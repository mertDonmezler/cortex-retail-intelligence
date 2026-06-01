// Türkçe-duyarlı sayı ayrıştırma. Excel hücreleri çoğunlukla sayı olarak gelir
// (raw:true) — bu durumda değer DEĞİŞMEDEN döner; sadece metin gelen hücrelerde
// binlik ayıracı (.) ve ondalık (,) doğru yorumlanır. Örn:
//   "1.234,56" → 1234.56   "1.234" → 1234   "12,5" → 12.5   "₺1.250" → 1250

function parseStr(raw: string): number {
  // Para sembolü, harf, boşluk vb. at — yalnızca rakam, , . - kalsın
  let s = raw.trim().replace(/[^\d.,-]/g, "");
  if (s === "" || s === "-") return NaN;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // Son görülen ayıraç ondalıktır; diğeri (binlik) silinir.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    // TR: virgül ondalıktır
    s = s.replace(",", ".");
  } else if (hasDot) {
    // Sadece nokta: "1.234" / "12.345.678" gibi binlik gruplaması ise sil; aksi halde ondalık bırak
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

export function toNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  const n = parseStr(String(v));
  return isNaN(n) ? 0 : n;
}

export function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  const n = parseStr(String(v));
  return isNaN(n) ? null : n;
}
