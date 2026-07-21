"use client";

import { useEffect, useState } from "react";

// Sunum modu — URL'de ?demo (veya ?sunum) varsa para/hacim figürlerini GÖRSEL
// olarak blur'lar. Amaç: canlı ekran paylaşımı / ekran görüntüsü sırasında gerçek
// finansalları gizlemek (mülakat, showcase). Kaynak veriyi DEĞİŞTİRMEZ — yalnız
// CSS filter; query kaldırılınca her şey nete döner. Etiketler, düzen, grafik
// biçimleri ve yüzdeler (görece, hassas değil) görünür kalır → sistem anlaşılır,
// mutlak ₺ gizli.
//
// Eşleşme: ₺ işareti · binlik ayraçlı sayı (1.090.449) · 3+ basamaklı sayı (944).
// Küçük sayılar (5 kanal, 42) ve yüzdeler (+10,4%) bilinçli olarak açık bırakılır.
const NUM_RE = /₺|\d[.,]\d{3}|\d{3,}/;

export function DemoMask() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has("demo") && !q.has("sunum")) return;
    setOn(true);

    function mask() {
      document.querySelectorAll<HTMLElement>("main *, header *, footer *").forEach((el) => {
        if (el.dataset.demoSeen) return;
        el.dataset.demoSeen = "1";
        if (el.children.length !== 0) return;          // yalnız yaprak düğümler
        if (el.closest("[data-demo-ui]")) return;      // rozetin kendisi hariç
        const t = (el.textContent || "").trim();
        if (t.length > 0 && t.length < 48 && NUM_RE.test(t)) el.classList.add("demo-blur");
      });
    }
    // Dashboard verisi async geldiği için birkaç kez tekrar tara (yeni düğümleri yakala).
    mask();
    const timers = [250, 800, 1600, 3000].map((ms) => window.setTimeout(mask, ms));
    return () => timers.forEach(clearTimeout);
  }, []);

  if (!on) return null;
  return (
    <>
      <style>{`.demo-blur{filter:blur(6px)!important}`}</style>
      <div
        data-demo-ui
        aria-hidden="true"
        style={{
          position: "fixed", bottom: 14, right: 14, zIndex: 9999,
          fontFamily: "ui-monospace, 'JetBrains Mono', monospace", fontSize: 11,
          letterSpacing: "0.12em", color: "#0a0e0a", background: "#1FF80B",
          padding: "6px 11px", borderRadius: 7, fontWeight: 700,
          boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
        }}
      >
        ● SUNUM MODU · rakamlar gizli
      </div>
    </>
  );
}
