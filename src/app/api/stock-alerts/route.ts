import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import {
  reorderPriority, VELOCITY_WEEKS, sonTamamlanmisHafta, gecikmeHaftasi,
} from "@/lib/compute";
import { toNetFacts, SKU_COLS } from "@/lib/rows";
import { isWeek, isRetailer, badRequest, optionalWeek } from "@/lib/params";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// HIZ PENCERESİ TEK KAYNAKTAN (compute.ts). Eskiden burada 4, /stok ve
// /yonlendirme'de 8 haftaydı; aynı ürün için iki ekran ZIT KELİME söylüyordu
// (ölçüm: 19 ürün / 20.696 adet için burada "Yeterli", /stok'ta "Az stok" —
// 5 satırda hız girdisi 2,4× sapıyordu). Eşikler ekranlara özgü kalabilir
// (burada 1/2 hafta = yakın tükenme, /stok'ta 8/30 = sipariş/kampanya), ama
// GİRDİ aynı olmalı; yoksa "kaç hafta yeter" sorusunun iki cevabı olur.
const WINDOW = VELOCITY_WEEKS;

// Sipariş önceliği: son WINDOW haftanın HAFTALIK ORTALAMA satışı ≥ minSales olan
// ürünleri, stoğun kaç hafta yeteceğine (stok / ort. satış) göre en acilden sırala.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  // NaN KAPISI: `Math.max(1, NaN)` NaN döner ve eşik NaN olunca `avg >= minSales`
  // karşılaştırması her satırda false olur — yani ELEME TAMAMEN DEVRE DIŞI kalır.
  // Ölçüldü (?minSales=abc): tabandan 166 kalem fazla, içinde 117 hiç satmayan
  // ölü SKU; cover = stok/0 → Infinity, 0/0 → NaN, JSON'da null; counts.acil
  // 0 → 51 sıçrıyor, yani uydurma bir aciliyet listesi.
  const ham = Number(searchParams.get("minSales") ?? 10);
  const minSales = Number.isFinite(ham) ? Math.max(1, ham) : 10;
  if (!retailer) return NextResponse.json({ error: "retailer gerekli" }, { status: 400 });
  if (!isRetailer(retailer)) return badRequest("Bilinmeyen perakendeci");
  try {
    const { data: wkRows, error: eWk } = await supabase
      .from("weekly_summary").select("week_start")
      .eq("retailer", retailer).order("week_start", { ascending: false }).limit(WINDOW);
    // OKUMA HATASI "VERI YOK" DEMEK DEGIL. error alani okunmadiginda bir ag/izin
    // hatasi bos diziye donusuyor ve ekran "veri yok" / "siparis gerekmiyor" diye
    // okunuyordu. Hata artik 500 olarak yukari cikar.
    if (eWk) throw eWk;
    const weeks = [...new Set((wkRows ?? []).map((w) => w.week_start as string))]; // yeni → eski
    if (!weeks.length) {
      return NextResponse.json({ latest: null, minSales, weeksUsed: 0, items: [], counts: { tukendi: 0, acil: 0, izle: 0 } });
    }
    const latest = weeks[0];

    const rows = await fetchAllRows((from, to) =>
      supabase.from("sku_weekly")
        .select(SKU_COLS)
        .eq("retailer", retailer).in("week_start", weeks).order("week_start").order("sku_name").range(from, to)
    );

    const items = reorderPriority(toNetFacts(rows), weeks, minSales);
    const counts = {
      tukendi: items.filter((i) => i.status === "tükendi").length,
      acil: items.filter((i) => i.status === "acil").length,
      izle: items.filter((i) => i.status === "izle").length,
    };
    // VERİ YAŞI BURADA DA BASILIR — KIRPMA YOK.
    // Bu uç sipariş önceliğini firmanın KENDİ son haftasıyla üretiyor. Yaşlandırma
    // uygulanmıyor (kırpma /api/routing'in ÇEK tarafına ait bir düzeltme ve bu uç
    // sipariş, yani sevk tarafında; sevk hiçbir kademede bastırılmaz). Ama tarih
    // basılmazsa aynı SKU için üçüncü bir tarihsiz sayı doğar: /yonlendirme "SEVK
    // 1.436 (üst sınır 2.872)" derken burada çıplak bir üçüncü rakam durur.
    return NextResponse.json({
      latest, minSales, weeksUsed: weeks.length, items, counts,
      veri: {
        takvimHaftasi: sonTamamlanmisHafta(new Date()),
        dataWeek: latest,
        gecikmeHf: gecikmeHaftasi(latest, sonTamamlanmisHafta(new Date())),
        yaslandirma: false,
      },
    });
  } catch (e: any) {
    console.error("stock-alerts hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
