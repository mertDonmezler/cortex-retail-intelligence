// MEŞGUL SAYACI — sayfadaki bütün istekler buradan geçer.
// Sayaç sıfırdan büyükken ve 200 ms'yi aşınca <html data-mesgul> konur;
// başlıktaki logo o sürece beş kanalı sırayla tarar. Logo durgunsa ekrandaki
// her sayı kesindir. React state'i yok: yalnız kök öğenin özniteliği değişir.
import { SURE } from "./hareket";

let sayac = 0;
let esikZamani: ReturnType<typeof setTimeout> | null = null;

const kok = () => (typeof document === "undefined" ? null : document.documentElement);

export function basla(): () => void {
  const h = kok();
  if (!h) return () => {};
  sayac++;
  if (sayac === 1 && !h.hasAttribute("data-mesgul") && esikZamani == null) {
    esikZamani = setTimeout(() => {
      esikZamani = null;
      if (sayac > 0) h.setAttribute("data-mesgul", "");
    }, SURE.esik);
  }
  let bitti = false;
  return () => {
    if (bitti) return;
    bitti = true;
    sayac = Math.max(0, sayac - 1);
    if (sayac > 0) return;
    if (esikZamani != null) { clearTimeout(esikZamani); esikZamani = null; }
    // Bir sonraki karede hâlâ boşsa kaldır: gezinmeden veri isteğine geçerken
    // logo bir kareliğine sönüp yeniden yanmasın.
    requestAnimationFrame(() => { if (sayac === 0) h.removeAttribute("data-mesgul"); });
  };
}

// bitir, çağıranın then'inden önce çalışır.
export function izle<T>(p: Promise<T>): Promise<T> {
  const bitir = basla();
  return p.finally(bitir);
}

export function mesgulMu(): boolean {
  return sayac > 0;
}
