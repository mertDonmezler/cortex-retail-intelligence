// Ürün ailesi + takım + sezon — "geçen yıl bu hafta" kıyası için.
//
// Sezonluk ürünler her yıl YENİ barkodla gelir (Pre-Season 25/26 → 26/27),
// yani barkod bazlı yıl kıyası tam da en kritik ürünlerde boş döner. Kıyas bu
// yüzden iki katmanlı: (1) aile — sezondan bağımsız ürün grubu, (2) karşılık —
// aynı firma + aynı aile + aynı takım + bir önceki sezon. Kurallar ad üzerinden;
// Toyzz "ASP-MYT-KART …", D&R "Mythos … Pkt", Armağan büyük harf ASCII gibi
// firma yazımlarının hepsi Türkçe harfler katlanarak (Ş→S, İ/ı→I) yakalanır.

const KATLA: Record<string, string> = { "Ş": "S", "Ğ": "G", "Ç": "C", "Ö": "O", "Ü": "U", "İ": "I" };

/** Büyük harf + Türkçe harf katlama: "Beşiktaş" → "BESIKTAS". */
export function katla(s: string | null | undefined): string {
  return (s ?? "").normalize("NFC").replace(/̇/g, "").toUpperCase()
    .replace(/[ŞĞÇÖÜİ]/g, (c) => KATLA[c]);
}

// Sıra önemli: ilk eşleşen kazanır (Pre-Season her şeyden önce; Champions
// Edition, Şampiyonluk Seti'nden önce).
const AILELER: [string, RegExp][] = [
  ["Pre-Season", /PRE-?SEASON/],
  ["Champions Edition", /CHAMPION/],
  ["Ultimate Kutu", /ULTI(MATE)?\s*KUTU|ULTIMATE/],
  ["Pulls / Futbolcu Kartları", /\bPULLS?\b|PLSFTBLC|FUTBOLCU/],
  ["First", /\bFIRST\b/],
  // Toyzz geçen yıl takım sezon kartlarını "ASP-MYT-KART FENERBAHCE 24/25 10LU"
  // adıyla satıyordu; bu yıl "SEZON KARTLARI 10LU 25/26".
  ["Sezon Kartları", /SEZON\s*KART|SEZONKART|^ASP-MYT-KART (GALATASARAY|FENERBAHCE|BESIKTAS|TRABZONSPOR) \d{2}\/\d{2} 10LU/],
  ["Şampiyonluk Seti", /SAMPIYONLUK/],
  ["Güçlendirici Paket", /GUCLENDIRICI/],
  ["Hafıza Kartı / Eşleştirme", /HAFIZA|ESLESTIR/],
  ["Tork Collection", /\bTORK\b/],
  ["Giants Çıkartma Seti", /GIANTS/],
  ["Efsane Kadro", /EFSANE\s*KADRO|EFSANEKADRO/],
  ["Karton Kutu", /KARTON\s*KUTU|KRTN|KARTONKUTU/],
  ["Metal Kutu", /METAL\s*KUTU|MTLKT/],
  ["Manifest", /MANIFEST/],
  ["Pokemon", /POKEMON|PKMN/],
  ["Labubu / Sevimli Canavar", /LABUBU|SEVIMLI\s*CANAVAR/],
  ["Nice To Know Animals", /ANIMALS|HAYVAN/],
  ["K-Pop", /K-?POP/],
  ["Holomonsters", /HOLOM/],
  ["Moments", /MOMENTS/],
  ["UEFA ŞL Sticker / Albüm", /(SAMP|UEFA|SL\b).*(STIC|CIKARTMA|ALBUM)|(STIC|CIKARTMA|ALBUM).*(SAMP|UEFA)/],
  ["Match Attax / Topps Kart", /MATCH\s*ATTAX|TOPPS|TURBO\s*ATTAX|MERLIN/],
  ["Poster / Çıkartma Set", /POSTER|CIKARTMA|STICKER|ALBUM|PSTR/],
  ["Puzzle", /PUZZLE|PZL/],
];

/** Tanınan aile adları ("Diğer" dahil) — analist araçları geçersiz adda bu listeyi döner. */
export const AILE_ADLARI: string[] = [...AILELER.map(([ad]) => ad), "Diğer"];

export function aile(ad: string | null | undefined): string {
  const a = katla(ad);
  for (const [adi, rx] of AILELER) if (rx.test(a)) return adi;
  return "Diğer";
}

export function takim(ad: string | null | undefined): string {
  const a = katla(ad);
  if (/GALATASARAY|\bGS\b|\(GS\)/.test(a)) return "Galatasaray";
  if (/FENERBAH|F\.BAHCE|\bFB\b|\(FB\)/.test(a)) return "Fenerbahçe";
  if (/BESIKTAS|\bBJK\b|\(BJK\)/.test(a)) return "Beşiktaş";
  if (/TRABZON|TRANZON|\bTS\b|\(TS\)/.test(a)) return "Trabzonspor";
  return "";
}

/** "25/26", "2025/26", "2025-2026", "24-25" → "25/26"; ardışık yıl değilse "" (ör. "5/6"). */
export function sezon(ad: string | null | undefined): string {
  const a = katla(ad);
  const ardisik = (x: string, y: string) => +y === (+x + 1) % 100;
  let m = a.match(/(\d{2})\s*\/\s*(\d{2})(?!\d)/);
  if (m && ardisik(m[1], m[2])) return `${m[1]}/${m[2]}`;
  m = a.match(/20(\d{2})\s*[/-]\s*(?:20)?(\d{2})(?!\d)/);
  if (m && ardisik(m[1], m[2])) return `${m[1]}/${m[2]}`;
  m = a.match(/(\d{2})-(\d{2})(?!\d)/);
  if (m && ardisik(m[1], m[2])) return `${m[1]}/${m[2]}`;
  return "";
}

export function oncekiSezon(s: string): string {
  if (!s) return "";
  const [a, b] = s.split("/").map(Number);
  return `${String((a + 99) % 100).padStart(2, "0")}/${String((b + 99) % 100).padStart(2, "0")}`;
}

/** Sezonluk ürünün geçen yılki karşılığını tanıyan anahtar: firma|aile|takım|sezon. */
export function karsilikAnahtari(retailer: string, ad: string, sezonu = sezon(ad)): string {
  return `${retailer}|${aile(ad)}|${takim(ad)}|${sezonu}`;
}
