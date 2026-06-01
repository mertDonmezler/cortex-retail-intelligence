"use client";

import { useState, useEffect } from "react";
import { RETAILERS } from "@/lib/format";

interface UploadResult {
  filename: string;
  week?: string;
  rows: number;
  status: string;
}

const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // Vercel serverless gövde limiti ~4.5MB

export default function UploadPage() {
  const [retailer, setRetailer] = useState(RETAILERS[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Yükleme anahtarı yalnızca tarayıcı oturumunda tutulur (bundle'a gömülmez).
  useEffect(() => {
    const saved = sessionStorage.getItem("cortex_upload_token");
    if (saved) setToken(saved);
  }, []);
  useEffect(() => {
    if (token) sessionStorage.setItem("cortex_upload_token", token);
  }, [token]);

  async function submit() {
    if (!files.length) return;
    if (!token) { setErr("Önce yükleme anahtarını gir."); return; }
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      setErr(
        `Seçilen dosyalar çok büyük (toplam ${(total / 1e6).toFixed(1)}MB). ` +
        "Daha az/küçük dosya yükle ya da büyük arşiv için 'npm run seed' kullan."
      );
      return;
    }
    setBusy(true);
    setErr(null);
    setResults(null);
    const fd = new FormData();
    fd.append("retailer", retailer);
    files.forEach((f) => fd.append("files", f));
    try {
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { "x-upload-token": token },
        body: fd,
      });
      if (!r.ok) {
        let msg = `Sunucu hatası (${r.status})`;
        if (r.status === 401) msg = "Yükleme anahtarı yanlış.";
        else if (r.status === 413) msg = "Dosya(lar) çok büyük — daha küçük partiler halinde dene.";
        else {
          try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* JSON değil */ }
        }
        throw new Error(msg);
      }
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setResults(d.results);
      setFiles([]);
    } catch (e: any) {
      setErr(e.message ?? "Bilinmeyen hata");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Veri <span className="neon-text">Yükle</span>
        </h1>
        <p className="text-txt-dim mono text-sm mt-1">
          Haftalık Excel'i içe aktar — geçmiş veri korunur, aynı hafta tekrar
          yüklenirse güncellenir.
        </p>
      </div>

      <div className="card p-6 space-y-5">
        <div>
          <label className="mono text-xs text-txt-dim uppercase tracking-wider">Yükleme anahtarı</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Ekip yükleme anahtarı (UPLOAD_TOKEN)"
            autoComplete="off"
            className="mt-2 block w-full max-w-sm text-sm text-txt mono bg-ink/40
              border border-line rounded-lg px-3 py-2 focus:border-neon/60 outline-none"
          />
          <p className="mono text-[11px] text-txt-dim mt-1">
            Yalnızca bu tarayıcı oturumunda saklanır; veri yazımı bu anahtarla korunur.
          </p>
        </div>

        <div>
          <label className="mono text-xs text-txt-dim uppercase tracking-wider">Perakendeci</label>
          <div className="flex gap-2 mt-2 flex-wrap">
            {RETAILERS.map((r) => (
              <button
                key={r}
                onClick={() => setRetailer(r)}
                className={`mono text-sm px-4 py-2 rounded-lg border transition-colors ${
                  retailer === r
                    ? "border-neon text-neon bg-neon/10"
                    : "border-line text-txt-dim hover:border-neon/40"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mono text-xs text-txt-dim uppercase tracking-wider">
            Excel dosyası/dosyaları
          </label>
          <input
            type="file"
            accept=".xlsx,.xls"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="mt-2 block w-full text-sm text-txt-dim mono
              file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
              file:bg-neon/15 file:text-neon file:mono file:cursor-pointer
              hover:file:bg-neon/25"
          />
          {files.length > 0 && (
            <div className="mono text-xs text-txt-dim mt-2">
              {files.length} dosya: {files.map((f) => f.name).join(", ")}
            </div>
          )}
        </div>

        <button
          onClick={submit}
          disabled={busy || !files.length || !token}
          className="mono text-sm px-6 py-3 rounded-lg bg-neon text-ink font-bold
            disabled:opacity-40 disabled:cursor-not-allowed hover:bg-neon-dim transition-colors"
        >
          {busy ? "İçe aktarılıyor…" : "⬆ İçe Aktar"}
        </button>
      </div>

      {err && (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">
          Hata: {err}
        </div>
      )}

      {results && (
        <div className="card p-6">
          <h2 className="font-bold mb-3">Sonuç</h2>
          <table>
            <thead>
              <tr><th>Dosya</th><th>Hafta</th><th>Satır</th><th>Durum</th></tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.filename}</td>
                  <td className="mono">{r.week ? new Date(r.week).toLocaleDateString("tr-TR") : "—"}</td>
                  <td className="mono">{r.rows.toLocaleString("tr-TR")}</td>
                  <td className={`mono ${r.status.startsWith("Hata") || r.status.includes("Boş") ? "text-red-400" : "text-neon"}`}>
                    {r.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <a href="/" className="inline-block mt-4 mono text-sm neon-text">→ Dashboard'a git</a>
        </div>
      )}
    </div>
  );
}
