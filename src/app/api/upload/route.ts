import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, fetchAllRows } from "@/lib/supabase";
import { normalizeFile } from "@/lib/normalizers";
import { canonicalWeek } from "@/lib/normalizers/week-parser";
import type { WeekRange } from "@/lib/normalizers/week-parser";
import type { Retailer, UnifiedRow } from "@/lib/normalizers/types";
import { RETAILERS } from "@/lib/normalizers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Yükleme bu endpoint'in tek YAZMA/SİLME yüzeyidir ve service-role (RLS bypass)
// kullanır. Erişim, tüm /api/* yüzeyini koruyan middleware PIN çereziyle sağlanır;
// bu yüzden ayrı bir yükleme anahtarı katmanı tutulmaz.
const MAX_FILES = 20;
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB/dosya (Vercel serverless gövde limiti ~4.5MB)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const retailer = form.get("retailer") as Retailer | null;
    const files = form.getAll("files") as File[];
    // Opsiyonel hafta override'ı (YYYY-MM-DD, UI'dan). Tarihsiz/geç dosyalarda
    // (Nezih, D&R-Kategori, Armağan W-NN) dosya adı çözümü yanlış haftaya
    // yazabilir; kullanıcı seçimi her dosyaya uygulanır ve Pazartesi'ye hizalanır.
    const weekParam = form.get("week");
    let weekOverride: WeekRange | undefined;
    if (typeof weekParam === "string" && weekParam.trim()) {
      const w = weekParam.trim();
      if (!ISO_DATE.test(w) || isNaN(new Date(w + "T00:00:00Z").getTime())) {
        return NextResponse.json({ error: "Geçersiz hafta tarihi" }, { status: 400 });
      }
      weekOverride = canonicalWeek({ start: w, end: w });
    }

    if (!retailer || !RETAILERS.includes(retailer)) {
      return NextResponse.json({ error: "Geçersiz perakendeci" }, { status: 400 });
    }
    if (!files.length) {
      return NextResponse.json({ error: "Dosya seçilmedi" }, { status: 400 });
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { error: `En fazla ${MAX_FILES} dosya. Büyük arşivler için 'npm run seed' kullanın.` },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();
    const results: {
      filename: string; week?: string; rows: number; status: string;
      // Mutabakat: dosyanın toplamları + aynı firmanın ÖNCEKİ haftası (weekly_summary,
      // yükleme öncesi hali). Büyük sapma → yanlış hafta/dosya erken yakalanır.
      sales_qty?: number; stock_qty?: number;
      prev_sales?: number | null; prev_stock?: number | null; warn?: string;
    }[] = [];

    for (const file of files) {
      try {
        if (file.size > MAX_FILE_BYTES) {
          results.push({
            filename: file.name,
            rows: 0,
            status: `Çok büyük (>${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB) — seed ile yükleyin`,
          });
          continue;
        }
        const buf = await file.arrayBuffer();
        const rows = normalizeFile(buf, retailer, file.name, weekOverride);
        if (rows.length === 0) {
          results.push({ filename: file.name, rows: 0, status: "Boş / okunamadı" });
          continue;
        }
        const week = rows[0].week_start;
        // week_start dosya adından türetiliyor; geçersiz tarihle DELETE/INSERT yapma.
        if (!ISO_DATE.test(week)) {
          results.push({ filename: file.name, rows: 0, status: "Hafta tarihi çözülemedi" });
          continue;
        }

        // Aynı (retailer, week) verisini sil — idempotent re-import
        const { error: delErr } = await db.from("fact_weekly").delete()
          .eq("retailer", retailer).eq("week_start", week);
        if (delErr) { console.error("delete hatası:", delErr); throw new Error("Eski hafta silinemedi"); }

        // Yeni satırları ekle (batch'ler halinde — Supabase büyük insert limiti)
        const CHUNK = 1000;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const slice = rows.slice(i, i + CHUNK);
          const { error } = await db.from("fact_weekly").insert(slice);
          if (error) { console.error("insert hatası:", error); throw new Error("Satırlar yazılamadı"); }
        }

        await db.from("import_log").insert({
          retailer, filename: file.name, week_start: week, rows: rows.length,
        });

        // Mutabakat: dosya toplamları + önceki hafta kıyası (matview'daki eski state —
        // önceki hafta zaten yüklüyse oradadır; refresh bu isteğin sonunda yapılır).
        const fileSales = rows.reduce((a, r) => a + (Number(r.sales_qty) || 0), 0);
        const fileStock = rows.reduce((a, r) => a + (Number(r.stock_qty) || 0), 0);
        const pw = new Date(week + "T00:00:00Z");
        pw.setUTCDate(pw.getUTCDate() - 7);
        const { data: prevRow } = await db.from("weekly_summary")
          .select("sales_qty, stock_qty")
          .eq("retailer", retailer).eq("week_start", pw.toISOString().slice(0, 10))
          .maybeSingle();
        const prevSales = prevRow ? Number(prevRow.sales_qty) : null;
        let warn: string | undefined;
        if (prevSales != null && prevSales > 0) {
          const d = Math.abs(fileSales - prevSales) / prevSales;
          if (d > 0.6) warn = `Satış geçen haftadan %${Math.round(d * 100)} sapıyor — hafta/dosya doğru mu?`;
        } else if (!prevRow) {
          warn = "Önceki haftanın verisi yok — hafta seçimini bir kontrol et.";
        }

        results.push({
          filename: file.name, week, rows: rows.length, status: "Yüklendi",
          sales_qty: fileSales, stock_qty: fileStock,
          prev_sales: prevSales, prev_stock: prevRow ? Number(prevRow.stock_qty) : null, warn,
        });
      } catch (e: any) {
        console.error(`upload hatası (${file.name}):`, e);
        // Normalizer'ın domain mesajları (boş dosya, bilinmeyen format vb.) güvenli
        // ve kullanıcıya yardımcı; ham DB mesajları yukarıda zaten genelleştirildi.
        results.push({ filename: file.name, rows: 0, status: e?.message ? `Hata: ${e.message}` : "İşlenemedi" });
      }
    }

    // Fiyat enrichment'i tetikle (tüm DB üzerinde)
    await enrichPrices(db);

    // Özet matview'larını yenile ki dashboard yeni veriyi anında göstersin
    const { error: rErr } = await db.rpc("refresh_summaries");
    if (rErr) console.error("refresh_summaries hatası:", rErr);

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    console.error("upload route hatası:", e);
    return NextResponse.json({ error: "Yükleme sırasında bir hata oluştu" }, { status: 500 });
  }
}

// Barkod-bazlı medyan fiyat türet, sales_value=null satırları doldur.
async function enrichPrices(db: ReturnType<typeof supabaseAdmin>) {
  // Fiyat kaynağı: barkodu + sales_value + sales_qty olan satırlar (sayfalı tam çekim)
  const priced = await fetchAllRows<{ barkod: string | null; sales_value: number; sales_qty: number }>(
    (from, to) =>
      db.from("fact_weekly")
        .select("barkod, sales_value, sales_qty")
        .not("barkod", "is", null)
        .gt("sales_value", 0)
        .gt("sales_qty", 0)
        .order("id")
        .range(from, to)
  );

  if (priced.length === 0) return;

  // Barkod → medyan birim fiyat
  const byBarkod = new Map<string, number[]>();
  for (const r of priced) {
    const unit = Number(r.sales_value) / Number(r.sales_qty);
    if (!isFinite(unit) || unit <= 0) continue;
    const arr = byBarkod.get(r.barkod as string) ?? [];
    arr.push(unit);
    byBarkod.set(r.barkod as string, arr);
  }
  const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const priceMap = new Map<string, number>();
  for (const [bk, arr] of byBarkod) priceMap.set(bk, median(arr));

  // sku_prices tablosunu güncelle
  const priceRows = [...priceMap.entries()].map(([barkod, median_price]) => ({
    barkod, median_price, samples: byBarkod.get(barkod)!.length,
  }));
  for (let i = 0; i < priceRows.length; i += 1000) {
    await db.from("sku_prices").upsert(priceRows.slice(i, i + 1000), { onConflict: "barkod" });
  }

  // sales_value=null + barkod=var satırları doldur (sayfalı tam çekim)
  const missing = await fetchAllRows<{ id: number; barkod: string | null; sales_qty: number }>(
    (from, to) =>
      db.from("fact_weekly")
        .select("id, barkod, sales_qty")
        .is("sales_value", null)
        .not("barkod", "is", null)
        .order("id")
        .range(from, to)
  );

  const updates: { id: number; sales_value: number; price: number }[] = [];
  for (const r of missing) {
    const p = priceMap.get(r.barkod as string);
    if (p != null) {
      updates.push({ id: r.id as number, sales_value: p * Number(r.sales_qty), price: p });
    }
  }
  for (let i = 0; i < updates.length; i += 500) {
    const slice = updates.slice(i, i + 500);
    await Promise.all(
      slice.map((u) =>
        db.from("fact_weekly").update({ sales_value: u.sales_value, price: u.price }).eq("id", u.id)
      )
    );
  }
}
