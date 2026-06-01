"use client";

import { useState } from "react";

// Oturumu kapatır (çerezi siler) ve giriş ekranına döner.
export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/auth", { method: "DELETE" });
        } catch {
          /* yoksay */
        }
        window.location.assign("/giris");
      }}
      disabled={busy}
      className="mono text-[11px] text-txt-dim hover:text-neon transition-colors disabled:opacity-50"
      title="Oturumu kapat"
    >
      {busy ? "çıkılıyor…" : "çıkış"}
    </button>
  );
}
