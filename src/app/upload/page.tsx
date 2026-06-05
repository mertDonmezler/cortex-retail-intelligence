"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { RETAILERS, fmtInt } from "@/lib/format";
import { SegTabs, CsvBtn, StatCard } from "@/components/Controls";

interface UploadResult {
  filename: string;
  week?: string;
  rows: number;
  status: string;
}

const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // Vercel serverless gövde limiti ~4.5MB

// ─────────────────────────────────────────────────────────────────────────────
// Durum sınıflandırması — API yalnızca "Yüklendi" döndüğünde başarı; diğer her
// şey (Boş/okunamadı, Çok büyük, Hafta tarihi çözülemedi, İşlenemedi, "Hata: …")
// başarısızlıktır. Eski satır içi kontrol yalnızca "Hata"/"Boş" kalıbına baktığı
// için bazı başarısızlıkları yeşil gösteriyordu; burada tek bir doğru kaynak var.
// ─────────────────────────────────────────────────────────────────────────────
type StatusKind = "ok" | "fail";

function kindOf(status: string): StatusKind {
  return status.trim() === "Yüklendi" ? "ok" : "fail";
}

// Boyutu insan-okur biçimde (KB/MB) — seçili dosya listesi ve toplam göstergesi için.
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

type StatusFilter = "all" | StatusKind;

export default function UploadPage() {
  const [retailer, setRetailer] = useState(RETAILERS[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Seçili dosyaların toplam boyutu — limit uyarısını önceden göstermek için.
  const totalBytes = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);
  const overLimit = totalBytes > MAX_TOTAL_BYTES;

  // ── Son yükleme özeti (sayfanın zaten elinde olan results üzerinden) ──────────
  const summary = useMemo(() => {
    if (!results) return null;
    let ok = 0, fail = 0, rows = 0;
    for (const r of results) {
      if (kindOf(r.status) === "ok") ok++; else fail++;
      rows += r.rows;
    }
    const weeks = new Set(results.filter((r) => r.week).map((r) => r.week as string));
    return { total: results.length, ok, fail, rows, weeks: weeks.size };
  }, [results]);

  // ── Durum filtresi uygulanmış sonuç listesi ──────────────────────────────────
  const shownResults = useMemo(() => {
    if (!results) return [];
    if (statusFilter === "all") return results;
    return results.filter((r) => kindOf(r.status) === statusFilter);
  }, [results, statusFilter]);

  function addFiles(incoming: File[]) {
    // Yalnız Excel uzantılarını al — sürükle-bırak her tür dosya bırakabilir.
    const xls = incoming.filter((f) => /\.xlsx?$/i.test(f.name));
    if (!xls.length) return;
    // Aynı dosya iki kez eklenmesin (ad+boyut anahtarı).
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + ":" + f.size));
      const merged = [...prev];
      for (const f of xls) {
        const k = f.name + ":" + f.size;
        if (!seen.has(k)) { seen.add(k); merged.push(f); }
      }
      return merged;
    });
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    if (!files.length) return;
    if (overLimit) {
      setErr(
        `Seçilen dosyalar çok büyük (toplam ${(totalBytes / 1e6).toFixed(1)}MB). ` +
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
        body: fd,
      });
      if (!r.ok) {
        let msg = `Sunucu hatası (${r.status})`;
        if (r.status === 413) msg = "Dosya(lar) çok büyük — daha küçük partiler halinde dene.";
        else {
          try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* JSON değil */ }
        }
        throw new Error(msg);
      }
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setResults(d.results);
      setStatusFilter("all");
      setFiles([]);
    } catch (e: any) {
      setErr(e.message ?? "Bilinmeyen hata");
    } finally {
      setBusy(false);
    }
  }

  // Durum filtresi sekmeleri — her sekme yanında o duruma giren dosya sayısı.
  const filterTabs = summary
    ? [
        { id: "all" as const, label: `Tümü (${summary.total})` },
        { id: "ok" as const, label: `✓ Yüklendi (${summary.ok})` },
        { id: "fail" as const, label: `✕ Başarısız (${summary.fail})` },
      ]
    : [];

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
          <label className="mono text-xs text-txt-dim uppercase tracking-wider">Perakendeci</label>
          <div className="flex gap-2 mt-2 flex-wrap">
            {RETAILERS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRetailer(r)}
                aria-pressed={retailer === r}
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

          {/* Sürükle-bırak alanı — tıklayınca gizli input'u açar. Davranış aynı:
              seçilen dosyalar addFiles ile state'e eklenir. */}
          <label
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              addFiles(Array.from(e.dataTransfer.files ?? []));
            }}
            className={`mt-2 flex flex-col items-center justify-center gap-1 cursor-pointer rounded-lg border border-dashed px-4 py-7 text-center transition-colors ${
              drag ? "border-neon bg-neon/10" : "border-line hover:border-neon/40"
            }`}
          >
            <input
              type="file"
              accept=".xlsx,.xls"
              multiple
              onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.currentTarget.value = ""; }}
              className="hidden"
            />
            <span className="text-2xl leading-none">⬆</span>
            <span className="mono text-sm text-txt">
              Dosyaları buraya sürükle <span className="text-txt-dim">veya seçmek için tıkla</span>
            </span>
            <span className="mono text-[11px] text-txt-dim">.xlsx / .xls · dosya başına ≤ 4MB</span>
          </label>

          {/* Seçili dosya listesi — ad + boyut + tek tek kaldırma. */}
          {files.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="mono text-xs text-txt-dim">
                  Seçili: {files.length} dosya · {fmtBytes(totalBytes)}
                </span>
                <button
                  type="button"
                  onClick={() => setFiles([])}
                  className="mono text-[11px] text-txt-dim hover:text-neon transition-colors"
                >
                  temizle
                </button>
              </div>
              <ul className="space-y-1">
                {files.map((f, i) => (
                  <li
                    key={f.name + ":" + f.size + ":" + i}
                    className="flex items-center justify-between gap-3 rounded-lg bg-ink-2 border border-line px-3 py-2"
                  >
                    <span className="mono text-sm text-txt truncate" title={f.name}>📄 {f.name}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="mono text-[11px] text-txt-dim">{fmtBytes(f.size)}</span>
                      <button
                        type="button"
                        onClick={() => removeFile(i)}
                        aria-label={`${f.name} dosyasını kaldır`}
                        className="mono text-xs px-1.5 -mr-1 py-1 text-txt-dim hover:text-red-400 transition-colors"
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              {overLimit && (
                <div className="mono text-[11px] text-red-400">
                  Toplam boyut 4MB sınırını aşıyor — bazı dosyaları çıkar ya da 'npm run seed' kullan.
                </div>
              )}
            </div>
          )}
        </div>

        <button
          onClick={submit}
          disabled={busy || !files.length || overLimit}
          className="mono text-sm px-6 py-3 rounded-lg bg-neon text-ink font-bold
            disabled:opacity-40 disabled:cursor-not-allowed hover:bg-neon-dim transition-colors"
        >
          {busy ? "İçe aktarılıyor…" : "⬆ İçe Aktar"}
        </button>
      </div>

      {err && (
        <div role="alert" className="card p-4 border-red-500/40 text-red-400 mono text-sm">
          Hata: {err}
        </div>
      )}

      {summary && (
        <div role="status" aria-live="polite" className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="DOSYA" value={fmtInt(summary.total)} sub={`${summary.weeks} hafta`} />
          <StatCard label="YÜKLENDİ" value={fmtInt(summary.ok)} sub="başarılı" />
          <StatCard
            label="BAŞARISIZ"
            value={fmtInt(summary.fail)}
            color={summary.fail > 0 ? "#f87171" : undefined}
            sub={summary.fail > 0 ? "kontrol et" : "sorun yok"}
          />
          <StatCard label="TOPLAM SATIR" value={fmtInt(summary.rows)} sub="içe aktarılan" />
        </div>
      )}

      {results && (
        <div className="card p-6">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <h2 className="font-bold">Sonuç</h2>
            <CsvBtn
              filename="cortex-yukleme-sonuc"
              rows={shownResults.map((r) => ({
                dosya: r.filename,
                hafta: r.week ? new Date(r.week).toLocaleDateString("tr-TR") : "—",
                satir: r.rows,
                durum: r.status,
              }))}
              cols={[
                { key: "dosya", label: "Dosya" },
                { key: "hafta", label: "Hafta" },
                { key: "satir", label: "Satır" },
                { key: "durum", label: "Durum" },
              ]}
            />
          </div>

          {summary && summary.total > 1 && (
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <SegTabs tabs={filterTabs} active={statusFilter} onChange={setStatusFilter} />
              <span className="mono text-xs text-txt-dim">
                {shownResults.length} / {summary.total} dosya
              </span>
            </div>
          )}

          {shownResults.length === 0 ? (
            <div className="mono text-sm text-txt-dim text-center py-6">
              Bu durumda dosya yok.
            </div>
          ) : (
            <table>
              <thead>
                <tr><th>Dosya</th><th>Hafta</th><th>Satır</th><th>Durum</th></tr>
              </thead>
              <tbody>
                {shownResults.map((r, i) => (
                  <motion.tr key={r.filename + ":" + i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.02 }}>
                    <td className="mono">{r.filename}</td>
                    <td className="mono">{r.week ? new Date(r.week).toLocaleDateString("tr-TR") : "—"}</td>
                    <td className="mono">{r.rows.toLocaleString("tr-TR")}</td>
                    <td className={`mono ${kindOf(r.status) === "ok" ? "text-neon" : "text-red-400"}`}>
                      {r.status}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          )}
          {summary && summary.ok > 0 ? (
            <a href="/" className="inline-block mt-4 mono text-sm neon-text">→ Dashboard'a git</a>
          ) : (
            <div className="mt-4 mono text-xs text-txt-dim">
              Hiçbir dosya yüklenmedi — durum sütununu kontrol edip yeniden dene.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
