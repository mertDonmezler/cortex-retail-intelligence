// HAREKET TOKENLARI — globals.css :root'taki --cx-* değişkenlerinin JS ikizi.
// İkisi aynı kalmalı; scripts/test.ts eşitliği denetler.
//
// Sistemin kuralı kısa: hareket yalnız iki şey söyler. (1) Ekran henüz kesin
// değil (bir istek 200 ms'yi aştı). (2) Hüküm şimdi verildi (karar motoru
// yanıtı). Veri geldiği karede son haliyle basılır; bayat veri, kullanıcının
// kendi seçimi ve yeniden render hiçbir hareket üretmez.
import { useEffect, useLayoutEffect } from "react";

export const SURE = {
  tik: 120,        // hover girişi, örtü, soluklaşmanın kendisi
  adim: 180,       // logo taramasında tek uç düğüm (5 adım = 900 ms tur)
  gecis: 180,      // KanalSeridi FLIP, KanalDetay panel girişi
  sonum: 360,      // hüküm fosforu, logo ateşi, yankı, satır izi — TAVAN
  esik: 200,       // bundan kısa bekleme görünmez
  imzaEsigi: 600,  // "KARAR MOTORU ÇALIŞIYOR…" en az bu kadar görünmediyse imza yok
  emniyet: 10000,  // gezinme hedef çizgisi için zaman aşımı
  debounce: 300,   // sayısal girdi → istek
} as const;

export const EGRI = "cubic-bezier(.16,1,.3,1)";
export const SOLUK = 0.45;

export function azaltilmisHareket(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// Boyamadan önce çalışan etki; sunucuda useEffect'e düşer (uyarı vermesin diye).
export const useKareEtkisi = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Geçersiz okuma işareti. Kullanım: <div className="cx-soluk" {...bekleme(bekliyor)}>
// Soluklaşma CSS'te eşiklidir: 200 ms'den kısa beklemede hiç görünmez.
export function bekleme(b: boolean): { "data-bekliyor"?: ""; "aria-busy"?: true } {
  return b ? { "data-bekliyor": "", "aria-busy": true } : {};
}
