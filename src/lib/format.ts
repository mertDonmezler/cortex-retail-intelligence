// Client tarafı tipler ve yardımcılar
import { RETAILERS as CANON_RETAILERS } from "@/lib/normalizers/types";
export interface WeeklySummary {
  retailer: string;
  week_start: string;
  week_end: string;
  sales_qty: number;
  sales_value: number | null;
  has_value: boolean;
  stock_qty: number;
  sku_count: number;
  store_count: number;
}

export interface Freshness {
  retailer: string;
  last_week: string | null;
  week_count: number;
  last_import: string | null;
}

// Perakendeci listesi + renk kimliği tek kaynaktan (eskiden 3+7 dosyada kopyaydı).
export const RETAILERS: string[] = CANON_RETAILERS;
export const RETAILER_COLORS: Record<string, string> = {
  Nezih: "#1FF80B", Huppaluppo: "#0bd1f8", Armağan: "#f8b00b", Toyzz: "#f80b8a", DR: "#9b6bff",
};
export function colorOf(retailer: string): string {
  return RETAILER_COLORS[retailer] ?? "#7d927d";
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("tr-TR");
}
export function fmtMoney(n: number | null): string {
  if (n == null) return "₺—";
  return "₺" + Math.round(n).toLocaleString("tr-TR");
}
// Kısaltılmış para biçimi — "₺33,7 mn" / "₺794 bin".
//
// NEDEN VAR: kod tabanında kısaltılmış tutar biçimi hiç yoktu, her yer
// `fmtMoney` ile tam basıyordu (₺33.747.235 = 11 karakter + ₺). Yönetici
// özetinde aynı sayı 92 px'lik bir kartın içinde, yanında birim rozetiyle
// duruyor; tam biçim orada satırı sarmalıyor ve kart yüksekliği hesabını
// bozuyor. Kısaltma bir görsel süs değil, yerleşimin taşıyıcı varsayımı.
//
// TEK YUVARLAMA KURALI (bilinçli olarak tek kademe, iki değil):
//   |n| >= 1.000.000 → milyon, DAİMA 1 ondalık   → ₺33,7 mn · ₺2,2 mn
//   |n| >= 10.000    → bin, ondalıksız yuvarlak  → ₺794 bin
//   altı             → `fmtMoney` (tam tutar)    → ₺9.500
//
// Milyonda niye tek ondalık? İki ondalık (₺33,75 mn) 100 bin TL'lik bir
// ayrıntıyı gösterir ama karar için hiçbir şey değiştirmez; buna karşılık aynı
// sütunda duran değerlerin karakter genişliğini oynatır. Tek kademe seçmek,
// aynı sayının sayfanın iki yerinde farklı yazılması riskini de kapatır.
//
// Bin eşiği niye 10.000, 1.000 değil? ₺9.500 → "₺10 bin" yuvarlaması %5'lik bir
// sapma demek; dört haneli tutarlarda bu bilgi kaybı kabul edilemez, üstelik
// "₺9.500" zaten dar. Beş haneden itibaren yuvarlamanın bağıl hatası %0,5'in
// altına iniyor, orada kısaltmak bedava.
export function fmtCompact(n: number | null): string {
  if (n == null) return "₺—"; // fmtMoney ile aynı boşluk işareti
  const abs = Math.abs(n);
  if (abs >= 1e6) return "₺" + dec1(n / 1e6) + " mn";
  if (abs >= 1e4) {
    const bin = Math.round(n / 1e3);
    // ₺999.999 gibi bir tutar binlik yuvarlamada "₺1.000 bin" olur; bu ekranda
    // hata gibi okunur, o yüzden eşiğe dayanan tutar milyona yükseltilir.
    if (Math.abs(bin) >= 1000) return "₺" + dec1(bin / 1e3) + " mn";
    return "₺" + bin.toLocaleString("tr-TR") + " bin";
  }
  return fmtMoney(n);
}
// Türkçe ondalık ayırıcı virgüldür; toLocaleString bunu yerelden alır, elle
// replace edilmez. minimum=maximum=1 → 2 → "2,0" (basamak sayısı sabit kalır).
function dec1(x: number): string {
  return x.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
export function fmtPct(p: number | null): string {
  if (p == null) return "—";
  return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
}
// "YYYY-MM-DD" JS'te UTC GECE YARISI olarak ayrışılır; yerel saat dilimiyle
// biçimlenirse UTC'nin batısındaki bir tarayıcıda (ör. Amerika) bir gün geri
// kayar: "2026-08-31" → "30 Ağu". Gün bilgisi saat dilimsizdir; o yüzden salt
// tarih girdisi UTC ile biçimlenir. Zaman damgalı girdiler (fmtDateTime) yerel
// saatte kalır — orada saat dilimi anlamlıdır.
const SALT_TARIH = /^\d{4}-\d{2}-\d{2}$/;
export function fmtDate(d: string | null): string {
  if (!d) return "—";
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" };
  if (SALT_TARIH.test(d)) opts.timeZone = "UTC";
  return new Date(d).toLocaleDateString("tr-TR", opts);
}
// ── "07 Eyl 2026" YERİNE "güncel" ──
//
// Ekranların çoğunda gösterilen tarih tek bir şeyi söylüyor: bu sayı hangi
// haftanın raporundan geldi. Firmaların büyük kısmı aynı haftayı gönderdiği için
// aynı tarih tek ekranda onlarca kez tekrar ediyor ve okunmayı bırakıyordu
// (ölçüm: ana sayfada 15 kez "07 Eyl 2026").
//
// KOŞUL BİLEREK DAR: yalnız hafta TAM OLARAK takvim haftasıysa "güncel" yazılır.
// 1 hafta geride olan bir kanal bayat SAYILMAZ (eşik 2 hafta) ama GÜNCEL DE
// DEĞİLDİR; ona "güncel" demek, bu oturumda kurulan veri yaşı dürüstlüğünü
// tam da düzeltilen yerden bozardı. Gecikmiş her hafta gerçek tarihini gösterir.
//
// takvimHaftasi yoksa (henüz hesaplanmadıysa) tarih basılır — sessizce "güncel"
// demek, bilinmeyeni güncel saymak olurdu.
export function fmtHafta(d: string | null | undefined, takvimHaftasi: string | null | undefined): string {
  if (!d) return "—";
  return takvimHaftasi && d === takvimHaftasi ? "güncel" : fmtDate(d);
}
export function fmtDateTime(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("tr-TR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
