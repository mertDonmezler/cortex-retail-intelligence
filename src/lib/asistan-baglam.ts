"use client";

// ASİSTAN EKRAN BAĞLAMI — sayfanın "şu an neye bakılıyor" bilgisi.
//
// Asistan (components/Asistan.tsx) her sayfada açık durur; hangi ekranda
// olduğunu yoldan (pathname) zaten bilir. Yolda olmayan seçimler (ürün
// sayfasında seçili ürün, panoda seçili hafta) sayfanın state'inde yaşar;
// sayfa onları buraya yazar, asistan soruya ekler. Böylece "bu ürün neden
// düştü?" sorusu hangi ürünün kastedildiğini taşır.
import { useEffect, useSyncExternalStore } from "react";

type Baglam = Record<string, string>;
let baglam: Baglam = {};
const dinleyiciler = new Set<() => void>();

function yaz(b: Baglam) {
  baglam = b;
  dinleyiciler.forEach((f) => f());
}

/** Sayfa bileşeninde: seçim değiştikçe bağlamı yazar, sayfadan çıkınca siler. */
export function useAsistanBaglami(b: Baglam | null) {
  const anahtar = b ? JSON.stringify(b) : "";
  useEffect(() => {
    yaz(anahtar ? JSON.parse(anahtar) : {});
    return () => yaz({});
  }, [anahtar]);
}

export function useBaglamOku(): Baglam {
  return useSyncExternalStore(
    (f) => { dinleyiciler.add(f); return () => { dinleyiciler.delete(f); }; },
    () => baglam,
    () => baglam,
  );
}
