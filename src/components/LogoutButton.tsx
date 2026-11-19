"use client";

import { useState } from "react";
import { basla } from "@/lib/mesgul";

// Oturumu kapatır (çerezi siler) ve giriş ekranına döner.
export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        // Sert yönlendirme her şeyi keseceği için sayaç bilerek kapatılmaz:
        // çıkış isteği sürerken logo tarar.
        basla();
        setBusy(true);
        try {
          await fetch("/api/auth", { method: "DELETE" });
        } catch {
          /* yoksay */
        }
        window.location.assign("/giris");
      }}
      disabled={busy}
      className="mono text-[11px] text-txt-dim hover:text-neon hover:transition-colors disabled:opacity-50"
      title="Oturumu kapat"
    >
      {busy ? "çıkılıyor…" : "çıkış"}
    </button>
  );
}
