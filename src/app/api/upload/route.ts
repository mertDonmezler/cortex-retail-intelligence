import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  normalizeFile,
  checkRowHealth,
  drDepoSatirlari,
} from "@/lib/normalizers";
import { canonicalWeek } from "@/lib/normalizers/week-parser";
import type { WeekRange } from "@/lib/normalizers/week-parser";
import type { Retailer } from "@/lib/normalizers/types";
import { RETAILERS } from "@/lib/normalizers/types";
// Fiyat enrichment mantığı tek modülde: scripts/seed.ts de aynı fonksiyonu
// çağırır, böylece aynı Excel iki yoldan yüklendiğinde aynı ciroyu üretir.
import { enrichPrices, type PriceSlice } from "@/lib/prices";
import {
  toyzzBarkodHaritasi,
  toyzzBarkodIsle,
  type BarkodHaritasi,
} from "@/lib/toyzz-barkod";
import { ARSIV, ARSIV_MIN_GUN, haftaKaydir, urunDuzeyine } from "@/lib/arsiv";
import type { SupabaseClient } from "@supabase/supabase-js";

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
        return NextResponse.json(
          { error: "Geçersiz hafta tarihi" },
          { status: 400 },
        );
      }
      weekOverride = canonicalWeek({ start: w, end: w });
    }

    if (!retailer || !RETAILERS.includes(retailer)) {
      return NextResponse.json(
        { error: "Geçersiz perakendeci" },
        { status: 400 },
      );
    }
    if (!files.length) {
      return NextResponse.json({ error: "Dosya seçilmedi" }, { status: 400 });
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        {
          error: `En fazla ${MAX_FILES} dosya. Büyük arşivler için 'npm run seed' kullanın.`,
        },
        { status: 400 },
      );
    }

    const db = supabaseAdmin();
    // GEÇEN YIL ARŞİVİ: ayrı tablo, ayrı kurallar (bkz. arsivYukle).
    if (form.get("hedef") === "arsiv")
      return arsivYukle(db, retailer, files, weekOverride);
    // Bu istekte gerçekten YAZILAN (firma, hafta) dilimleri. Fiyat enrichment'i
    // ve matview yenilemesi yalnız bunlara bakar — geçmişin tamamına değil.
    const slices: PriceSlice[] = [];
    const results: {
      filename: string;
      week?: string;
      rows: number;
      status: string;
      // Mutabakat: dosyanın toplamları + aynı firmanın ÖNCEKİ haftası (weekly_summary,
      // yükleme öncesi hali). Büyük sapma → yanlış hafta/dosya erken yakalanır.
      sales_qty?: number;
      stock_qty?: number;
      prev_sales?: number | null;
      prev_stock?: number | null;
      warn?: string;
      // Bu hafta için silinen satır sayısı — yanlış haftaya yazmayı görünür kılar.
      silinen?: number;
      // Sağlık kontrolü + mutabakat uyarılarının TAM listesi. `warn` bunların
      // birleştirilmiş hali (eski UI tek satır gösteriyor); yeni UI diziyi
      // satır satır basabilir.
      warnings?: string[];
    }[] = [];

    // AYNI İSTEKTE AYNI HAFTAYA İKİ DOSYA → İKİNCİSİ YAZILMAZ.
    // Her dosya kendi (firma, hafta) dilimini DELETE+INSERT eder. Aynı haftaya
    // çözülen iki dosya birbirini siler: sonuncu kazanır, öncekiler yok olur ve
    // hepsi "Yüklendi" görünür. İki gerçekçi yol var: (a) hafta elle seçilip
    // birden çok dosya bırakılması, (b) tarihsiz iki dosyanın (Nezih/D&R-Kategori)
    // ikisinin de `weekFromToday()` yedeğine düşmesi. Kural: ilk dosya korunur,
    // sonrakiler açıkça reddedilir — sessiz kayıp yerine görünür ret.
    const yazilanHaftalar = new Set<string>();
    // Toyzz Kalem Kodu → barkod eşlemesi; istek başına en fazla bir kez okunur.
    let toyzzHarita: BarkodHaritasi | null = null;

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
        // Eski, barkodsuz bir Toyzz haftası yeniden yüklenirse barkodu Kalem
        // Kodu'ndan geri işle; yoksa ürün anahtarı haftalar arasında ikiye
        // bölünür (bkz. lib/toyzz-barkod.ts). Sağlık kontrolünden ÖNCE.
        let toyzzUyari: string | null = null;
        if (retailer === "Toyzz") {
          toyzzHarita ??= await toyzzBarkodHaritasi(db);
          toyzzBarkodIsle(rows, toyzzHarita);
          // Eşleme tutmazsa (ör. Toyzz toplu ad değişikliği) bölünme SESSİZCE geri
          // gelirdi. Bugünkü taban: eski haftalarda ~%6 barkodsuz (dosyada olmayan
          // 13 kod). %15 üstü gerçek bir kopukluk demek → görünür uyarı.
          const barkodsuz = rows.filter((r) => !r.barkod).length;
          if (rows.length > 0 && barkodsuz / rows.length > 0.15) {
            toyzzUyari =
              `${barkodsuz}/${rows.length} Toyzz satırı barkodsuz kaldı (Kalem Kodu eşlemesi bulunamadı) — ` +
              `bu ürünler diğer haftalardan ayrı sayılabilir.`;
          }
        }
        // Sağlık kontrolü: satır sayısı, satış/stok toplamları, ciro üretilebilirliği.
        // Uyarılar yüklemeyi BLOKLAMAZ (gerçekten satışsız hafta olabilir) ama
        // sessiz de geçmez — hem log'a hem yanıta yazılır.
        const health = checkRowHealth(rows);
        if (toyzzUyari) health.warnings.push(toyzzUyari);
        if (health.warnings.length) {
          console.warn(
            `upload sağlık uyarısı (${retailer} / ${file.name}):`,
            health.warnings.join(" | "),
          );
        }
        if (rows.length === 0) {
          results.push({
            filename: file.name,
            rows: 0,
            status: "Boş / okunamadı",
            // sales_qty/stock_qty = 0 BİLEREK yazılıyor: mevcut UI mutabakat
            // hücresini (ve içindeki uyarıyı) yalnız sales_qty geldiğinde
            // gösteriyor. 0 satırlık dosyada toplamlar gerçekten 0'dır, uyarı da
            // görünür kalsın.
            sales_qty: 0,
            stock_qty: 0,
            warnings: health.warnings,
            warn: health.warnings.join(" · ") || undefined,
          });
          continue;
        }
        const week = rows[0].week_start;
        // week_start dosya adından türetiliyor; geçersiz tarihle DELETE/INSERT yapma.
        if (!ISO_DATE.test(week)) {
          results.push({
            filename: file.name,
            rows: 0,
            status: "Hafta tarihi çözülemedi",
          });
          continue;
        }
        if (yazilanHaftalar.has(week)) {
          results.push({
            filename: file.name,
            week,
            rows: 0,
            status: `Aynı haftaya (${week}) bu istekte ikinci dosya — YAZILMADI; ilk dosya korundu. Farklı bir haftaysa haftayı seçip ayrı yükle.`,
          });
          continue;
        }
        yazilanHaftalar.add(week);

        // NE SİLİNECEĞİ ÖNCE ÖLÇÜLÜR. Yükleme DELETE+INSERT ve geri alma yok;
        // yanlış haftaya yazılan bir dosya o haftanın gerçek verisini yok eder
        // (tarihsiz dosyalarda haftayı kod tahmin ediyor). Sayı yanıta gider ve
        // gelen dosya silinenin yanında çok küçükse açık uyarı basılır.
        const { count: silinecek } = await db
          .from("fact_weekly")
          .select("id", { count: "exact", head: true })
          .eq("retailer", retailer)
          .eq("week_start", week);

        // Aynı (retailer, week) verisini sil — idempotent re-import
        const { error: delErr } = await db
          .from("fact_weekly")
          .delete()
          .eq("retailer", retailer)
          .eq("week_start", week);
        if (delErr) {
          console.error("delete hatası:", delErr);
          throw new Error("Eski hafta silinemedi");
        }

        // Yeni satırları ekle (batch'ler halinde — Supabase büyük insert limiti)
        const CHUNK = 1000;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const slice = rows.slice(i, i + CHUNK);
          const { error } = await db.from("fact_weekly").insert(slice);
          if (error) {
            console.error("insert hatası:", error);
            throw new Error("Satırlar yazılamadı");
          }
        }

        if (
          !slices.some((s) => s.retailer === retailer && s.week_start === week)
        ) {
          slices.push({ retailer, week_start: week });
        }

        // D&R DEPO (supabase/kanal-depo.sql, lib/normalizers/dr-kategori.ts):
        // Kategori dosyasının Offline/Web Depo kolonları aynı haftaya yazılır.
        // Satış verisi ZATEN yazıldı; depo yazılamazsa yükleme düşmez, uyarı verir.
        // Tablo yoksa (SQL henüz çalıştırılmadı) bunu açıkça söyler.
        const depoUyarilari: string[] = [];
        // Kendi try/catch'i: depo okuması beklenmedik biçimde fırlatırsa dış catch
        // dosyayı "Hata" diye raporlardı — oysa satış verisi zaten yazıldı.
        if (retailer === "DR")
          try {
            const depo = drDepoSatirlari(
              buf,
              retailer,
              file.name,
              weekOverride,
            ).map((d) => ({ ...d, week_start: week }));
            if (depo.length) {
              const tabloYok = (e: any) =>
                e?.code === "42P01" ||
                e?.code === "PGRST205" ||
                /kanal_depo/.test(String(e?.message ?? ""));
              const { error: dDel } = await db
                .from("kanal_depo")
                .delete()
                .eq("retailer", "DR")
                .eq("week_start", week);
              let dHata: any = dDel;
              for (let i = 0; !dHata && i < depo.length; i += 1000) {
                const { error } = await db
                  .from("kanal_depo")
                  .insert(depo.slice(i, i + 1000));
                dHata = error;
              }
              if (dHata) {
                console.error("kanal_depo yazılamadı:", dHata.message ?? dHata);
                depoUyarilari.push(
                  tabloYok(dHata)
                    ? "D&R depo stoğu kaydedilmedi: kanal_depo tablosu yok (supabase/kanal-depo.sql bir kez çalıştırılmalı)."
                    : "D&R depo stoğu kaydedilemedi — satış/stok verisi yüklendi, yalnız depo eksik.",
                );
              }
            }
          } catch (e: any) {
            console.error("D&R depo okunamadı:", e?.message ?? e);
            depoUyarilari.push(
              "D&R depo stoğu okunamadı — satış/stok verisi yüklendi, yalnız depo eksik.",
            );
          }

        // import_log YÜKLEME GEÇMİŞİDİR: "bu hafta yüklendi mi?" sorusunun tek
        // kaynağı ve data_freshness.last_import buradan besleniyor. Hatası eskiden
        // sessizce yutuluyordu; veri girer, kaydı görünmezdi. Artık log'a düşer ve
        // yanıtta uyarı olarak görünür — AMA yükleme akışını KESMEZ: satırlar
        // fact_weekly'ye yazıldı, defter tutulamadı diye onları geri almak
        // (veya isteği hataya düşürmek) daha kötü bir sonuç olurdu.
        const logWarnings: string[] = [];
        const { error: logErr } = await db.from("import_log").insert({
          retailer,
          filename: file.name,
          week_start: week,
          rows: rows.length,
        });
        if (logErr) {
          console.error(
            `import_log yazılamadı (${retailer} / ${file.name} / ${week}):`,
            logErr.message,
          );
          logWarnings.push(
            "Veri yüklendi ama yükleme kaydı (import_log) yazılamadı — yükleme geçmişi bu dosyayı göstermeyecek.",
          );
        }

        // Mutabakat: dosya toplamları + önceki hafta kıyası (matview'daki eski state —
        // önceki hafta zaten yüklüyse oradadır; refresh bu isteğin sonunda yapılır).
        // Toplamlar sağlık kontrolünde bir kez dolaşıldı, yeniden hesaplanmıyor.
        const fileSales = health.salesQty;
        const fileStock = health.stockQty;
        const pw = new Date(week + "T00:00:00Z");
        pw.setUTCDate(pw.getUTCDate() - 7);
        const { data: prevRow } = await db
          .from("weekly_summary")
          .select("sales_qty, stock_qty")
          .eq("retailer", retailer)
          .eq("week_start", pw.toISOString().slice(0, 10))
          .maybeSingle();
        const prevSales = prevRow ? Number(prevRow.sales_qty) : null;
        // Sağlık uyarıları + log uyarısı + mutabakat sapması aynı listede.
        const warnings = [...health.warnings, ...logWarnings, ...depoUyarilari];
        // Huppaluppo dosyası kendi tarihini taşır; elle seçim onu ezdiğinde bunu
        // sonuçta söyle — seçim yanlışsa kullanıcı burada görsün.
        if (weekOverride && retailer === "Huppaluppo") {
          warnings.push(
            `Huppaluppo dosyasının içindeki tarih aralığı YOK SAYILDI — seçtiğin hafta (${week}) yazıldı. Dosya başka haftaya aitse doğru haftayı seçip yeniden yükle.`,
          );
        }
        // Silinen satır sayısı gelenden çok büyükse hafta seçimi şüphelidir:
        // tipik senaryo, mağaza kırılımlı bir haftanın (binlerce satır) kırılımsız
        // küçük bir dosyayla ezilmesi ya da dosyanın yanlış haftaya düşmesi.
        if ((silinecek ?? 0) > 0 && rows.length < (silinecek ?? 0) * 0.5) {
          warnings.push(
            `Bu hafta (${week}) için ${silinecek} satır SİLİNDİ, yerine ${rows.length} satır yazıldı. Hafta yanlışsa doğru haftayı seçip ilgili dosyayı yeniden yükle.`,
          );
        }
        if (prevSales != null && prevSales > 0) {
          const d = Math.abs(fileSales - prevSales) / prevSales;
          if (d > 0.6)
            warnings.push(
              `Satış geçen haftadan %${Math.round(d * 100)} sapıyor — hafta/dosya doğru mu?`,
            );
        } else if (!prevRow) {
          warnings.push(
            "Önceki haftanın verisi yok — hafta seçimini bir kontrol et.",
          );
        }

        results.push({
          filename: file.name,
          week,
          rows: rows.length,
          status: "Yüklendi",
          silinen: silinecek ?? 0,
          sales_qty: fileSales,
          stock_qty: fileStock,
          prev_sales: prevSales,
          prev_stock: prevRow ? Number(prevRow.stock_qty) : null,
          // `warn`: mevcut UI tek string bekliyor → hepsini birleştir ki yeni
          // uyarılar UI güncellenene kadar da görünür olsun. `warnings`: tam liste.
          warn: warnings.length ? warnings.join(" · ") : undefined,
          warnings: warnings.length ? warnings : undefined,
        });
      } catch (e: any) {
        console.error(`upload hatası (${file.name}):`, e);
        // Normalizer'ın domain mesajları (boş dosya, bilinmeyen format vb.) güvenli
        // ve kullanıcıya yardımcı; ham DB mesajları yukarıda zaten genelleştirildi.
        results.push({
          filename: file.name,
          rows: 0,
          status: e?.message ? `Hata: ${e.message}` : "İşlenemedi",
        });
      }
    }

    // İstek düzeyinde (tek dosyaya değil, yüklemenin tamamına ait) uyarı ekler.
    const addRequestWarning = (msg: string) => {
      for (const r of results) {
        if (r.status !== "Yüklendi") continue;
        r.warnings = [...(r.warnings ?? []), msg];
        r.warn = r.warnings.join(" · ");
      }
    };

    // Fiyat enrichment'i tetikle — YALNIZ bu istekte yazılan dilimler üzerinde.
    // Hiçbir dosya yazılmadıysa fact_weekly değişmemiştir: ne enrichment'in ne de
    // matview yenilemesinin yapacak işi var (refresh 356K satırda pahalı).
    //
    // İKİSİ DE YÜKLEMEDEN SONRAKİ adımlar: buradaki bir hata (ör. geçici DB
    // timeout'u) isteği 500'e düşürüp kullanıcıya "yükleme başarısız" göstermemeli —
    // satırlar zaten fact_weekly'de. Hata log'a + yanıta uyarı olarak yazılır;
    // aynı haftayı yeniden yüklemek (idempotent) adımı tekrar tetikler.
    if (slices.length) {
      try {
        const rep = await enrichPrices(db, slices);
        console.log(
          `enrichPrices: ${rep.slices} dilim, ${rep.gaps} ciro boşluğu, ` +
            `${rep.filled} satır dolduruldu, ${rep.unpriced} satır fiyatsız, ${rep.failed} yazma hatası.`,
        );
        if (rep.unpriced) {
          addRequestWarning(
            `${rep.unpriced} satırın fiyatı hiçbir kaynakta bulunamadı — cirosu 0 kaldı (yeni ürün olabilir).`,
          );
        }
        if (rep.failed) {
          addRequestWarning(
            `${rep.failed} satırın cirosu yazılamadı — ciro eksik görünebilir.`,
          );
        }
      } catch (e: any) {
        console.error("enrichPrices hatası:", e);
        addRequestWarning(
          "Ciro doldurma adımı tamamlanamadı — adetler doğru, ciro eksik olabilir. Aynı haftayı yeniden yükleyip tekrar deneyebilirsin.",
        );
      }
    }

    // MATVIEW YENİLEMESİ BU İSTEKTE YAPILMAZ — /api/refresh'e taşındı.
    //
    // refresh_summaries() altı matview'i sırayla yeniliyor ve kendi içinde
    // 180 sn'lik bir timeout tanımlıyor; bu uçun bütçesi ise 60 sn. Silme +
    // yazma + enrichment'in üstüne binince bütçe dolabiliyor ve platform
    // fonksiyonu öldürdüğünde satırlar yazılmış ama yanıt hiç dönmemiş oluyordu.
    // İstemci yükleme yanıtını aldıktan SONRA /api/refresh'i çağırır; orada bir
    // hata olursa veri kaybı yoktur, yalnız panel gecikmeli görünür.
    return NextResponse.json({
      ok: true,
      results,
      refreshGerekli: slices.length > 0,
    });
  } catch (e: any) {
    console.error("upload route hatası:", e);
    return NextResponse.json(
      { error: "Yükleme sırasında bir hata oluştu" },
      { status: 500 },
    );
  }
}

// GEÇEN YIL ARŞİVİNE YÜKLEME — fact_weekly_arsiv (lib/arsiv.ts).
//
// Canlı yoldan farkları, hepsi bilerek:
//   - HAFTA ZORUNLU: dosya adları yılı taşımıyor ("1-7 Eylül"); hafta çözücü
//     "veri hep geçmiştir" kuralıyla bu yılı seçer ve dosya yanlış yıla gider.
//   - HAFTA EN AZ 26 HAFTA ÖNCE: güncel bir dosyanın yanlışlıkla arşive gidip
//     canlı panelde görünmemesini engeller.
//   - CANLIDA OLAN HAFTA YAZILMAZ: aynı (firma, hafta) iki tabloda olursa yıl
//     kıyası hangisini okuyacağını seçmek zorunda kalır; tek kaynak kuralı.
//   - TEK DOSYA: hafta elle seçildiği için her dosya ayrı istekle yüklenir.
//   - Ürün düzeyine çökertilir; fiyat doldurma, import_log, matview yenilemesi
//     YOK — canlı panelin hiçbir hesabı arşivi okumaz.
async function arsivYukle(
  db: SupabaseClient,
  retailer: Retailer,
  files: File[],
  weekOverride?: WeekRange,
) {
  if (!weekOverride) {
    return NextResponse.json(
      {
        error:
          "Arşiv yüklemesinde hafta seçilmeli (dosya adındaki tarih yılı taşımıyor).",
      },
      { status: 400 },
    );
  }
  const week = weekOverride.start;
  const enGec = haftaKaydir(
    new Date().toISOString().slice(0, 10),
    -ARSIV_MIN_GUN,
  );
  if (week > enGec) {
    return NextResponse.json(
      {
        error: `Arşive yalnız ${enGec} ve öncesi yazılır — bu hafta canlı veriye yüklenmeli.`,
      },
      { status: 400 },
    );
  }
  if (files.length !== 1) {
    return NextResponse.json(
      {
        error:
          "Arşive her istekte tek dosya yüklenir (her dosyanın haftası ayrı seçilir).",
      },
      { status: 400 },
    );
  }
  const file = files[0];
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        error: `Dosya çok büyük (>${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB)`,
      },
      { status: 400 },
    );
  }
  try {
    const rows = normalizeFile(
      await file.arrayBuffer(),
      retailer,
      file.name,
      weekOverride,
    );
    if (retailer === "Toyzz")
      toyzzBarkodIsle(rows, await toyzzBarkodHaritasi(db));
    const health = checkRowHealth(rows);
    const urun = urunDuzeyine(rows);
    if (!urun.length) {
      return NextResponse.json({
        ok: true,
        arsiv: true,
        refreshGerekli: false,
        results: [
          {
            filename: file.name,
            week,
            rows: 0,
            status: "Boş / okunamadı",
            sales_qty: 0,
            stock_qty: 0,
            warnings: health.warnings,
          },
        ],
      });
    }
    const { count: canlida } = await db
      .from("fact_weekly")
      .select("id", { count: "exact", head: true })
      .eq("retailer", retailer)
      .eq("week_start", week);
    if (canlida) {
      return NextResponse.json({
        ok: true,
        arsiv: true,
        refreshGerekli: false,
        results: [
          {
            filename: file.name,
            week,
            rows: 0,
            status: `Bu hafta (${week}) canlı veride var — arşive YAZILMADI.`,
          },
        ],
      });
    }
    const { count: silinen } = await db
      .from(ARSIV)
      .select("id", { count: "exact", head: true })
      .eq("retailer", retailer)
      .eq("week_start", week);
    const { error: delErr } = await db
      .from(ARSIV)
      .delete()
      .eq("retailer", retailer)
      .eq("week_start", week);
    if (delErr) throw new Error(`Arşiv haftası silinemedi: ${delErr.message}`);
    for (let i = 0; i < urun.length; i += 1000) {
      const { error } = await db.from(ARSIV).insert(urun.slice(i, i + 1000));
      if (error) throw new Error(`Arşive yazılamadı: ${error.message}`);
    }
    return NextResponse.json({
      ok: true,
      arsiv: true,
      refreshGerekli: false,
      results: [
        {
          filename: file.name,
          week,
          rows: urun.length,
          status: "Arşive yüklendi",
          silinen: silinen ?? 0,
          sales_qty: health.salesQty,
          stock_qty: health.stockQty,
          warnings: health.warnings.length ? health.warnings : undefined,
          warn: health.warnings.length
            ? health.warnings.join(" · ")
            : undefined,
        },
      ],
    });
  } catch (e: any) {
    console.error(`arşiv yükleme hatası (${file.name}):`, e);
    return NextResponse.json({
      ok: true,
      arsiv: true,
      refreshGerekli: false,
      results: [
        {
          filename: file.name,
          week,
          rows: 0,
          status: e?.message ? `Hata: ${e.message}` : "İşlenemedi",
        },
      ],
    });
  }
}
