"use client";

// "Haftalık Mail" butonu — seçili haftanın durum mailini /api/weekly-report'tan
// hazır metin olarak çeker, modal içinde gösterir; tek tıkla panoya kopyalanır.
// (Her hafta elle yazılan durum mailinin ürünleşmiş hali.)
import { useState } from "react";
import { fetchJson } from "@/lib/fetchJson";

export function MailButton({ week }: { week: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setErr("");
    setCopied(false);
    setOpen(true);
    try {
      const d = await fetchJson(`/api/weekly-report?week=${encodeURIComponent(week)}`);
      setText(d.text ?? "");
    } catch (e: any) {
      setErr(e?.message ?? "Rapor üretilemedi");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Pano izni yoksa kullanıcı metni elle seçebilir — sessiz geç.
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={generate}
        disabled={!week}
        className="mono text-xs px-4 py-2 rounded-lg border border-neon/50 text-neon
          hover:bg-neon/10 transition-colors disabled:opacity-40"
      >
        📋 Haftalık Mail
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="card w-full max-w-2xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Haftalık mail taslağı"
          >
            <div className="flex items-center justify-between">
              <div className="mono text-xs text-txt-dim tracking-wider">📋 HAFTALIK MAİL TASLAĞI</div>
              <button type="button" onClick={() => setOpen(false)}
                className="mono text-xs text-txt-dim hover:text-neon">✕ kapat</button>
            </div>

            {busy ? (
              <div className="mono text-sm text-txt-dim animate-pulse py-10 text-center">Hazırlanıyor…</div>
            ) : err ? (
              <div className="mono text-sm text-red-400 py-6 text-center">{err}</div>
            ) : (
              <>
                <textarea
                  readOnly
                  value={text}
                  rows={18}
                  className="w-full card bg-ink-2 mono text-xs p-3 outline-none focus:border-neon resize-y"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="mono text-[11px] text-txt-dim">
                    Eksik firma varsa metinde belirtilir — göndermeden önce göz at.
                  </span>
                  <button
                    type="button"
                    onClick={copy}
                    className="mono text-sm px-5 py-2 rounded-lg bg-neon text-ink font-bold hover:bg-neon-dim transition-colors"
                  >
                    {copied ? "✓ Kopyalandı" : "⧉ Kopyala"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
