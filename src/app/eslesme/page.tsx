"use client";

import { useEffect, useState } from "react";

interface Alias {
  id: number; retailer: string; sku_name: string; barkod: string;
  match_name: string | null; confidence: number | null; status: string;
}

const confColor = (c: number | null) => (c == null ? "#7d927d" : c >= 0.8 ? "#1FF80B" : c >= 0.7 ? "#f8b00b" : "#ff8855");

export default function EslesmePage() {
  const [sug, setSug] = useState<Alias[]>([]);
  const [approved, setApproved] = useState<Alias[]>([]);
  const [rejected, setRejected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  function load() {
    fetch("/api/alias")
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok || d?.error) throw new Error(d?.error || ("HTTP " + r.status)); return d; })
      .then((d) => { setSug(d.suggestions ?? []); setApproved(d.approved ?? []); setRejected(d.rejectedCount ?? 0); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function setStatus(a: Alias, status: "approved" | "rejected" | "suggested") {
    setBusy(a.id);
    try {
      const r = await fetch("/api/alias", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id, status }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      // yerel state güncelle
      setSug((s) => s.filter((x) => x.id !== a.id));
      setApproved((s) => {
        const without = s.filter((x) => x.id !== a.id);
        return status === "approved" ? [{ ...a, status }, ...without] : without;
      });
      if (status === "suggested") setSug((s) => [{ ...a, status }, ...s].sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0)));
      setDirty(true);
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  async function applyRefresh() {
    setRefreshing(true);
    try {
      const r = await fetch("/api/alias", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh: true }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setDirty(false);
    } catch (e: any) { setErr(e.message); } finally { setRefreshing(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Ürün <span className="neon-text">Eşleşme</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Toyzz (barkodsuz) → barkodlu ürün önerileri. Onayla → o ürün firmalar arası birleşir. Auto-öneri; onaylanana kadar birleşmez.
          </p>
        </div>
        <button onClick={applyRefresh} disabled={refreshing || !dirty}
          className={`mono text-xs px-4 py-2 rounded-lg font-bold transition-colors ${dirty ? "bg-neon text-ink hover:bg-neon-dim" : "border border-line text-txt-dim"}`}>
          {refreshing ? "Yenileniyor…" : dirty ? "⟳ Uygula (Ölü Stok'a yansıt)" : "Güncel"}
        </button>
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Hata: {err}</div>}

      <div className="grid grid-cols-3 gap-3">
        <div className="card p-4"><div className="mono text-[10px] text-txt-dim">BEKLEYEN ÖNERİ</div><div className="text-2xl font-bold mono mt-1" style={{ color: "#f8b00b" }}>{sug.length}</div></div>
        <div className="card p-4"><div className="mono text-[10px] text-txt-dim">ONAYLANAN</div><div className="text-2xl font-bold mono mt-1 neon-text">{approved.length}</div></div>
        <div className="card p-4"><div className="mono text-[10px] text-txt-dim">REDDEDİLEN</div><div className="text-2xl font-bold mono mt-1 text-txt-dim">{rejected}</div></div>
      </div>

      {dirty && <div className="card p-3 border-l-4 mono text-xs text-txt-dim" style={{ borderLeftColor: "#f8b00b" }}>Değişiklik var — Ölü Stok/listelere yansıması için sağ üstten <span className="text-txt font-bold">Uygula</span>'ya bas.</div>}

      {/* Öneriler */}
      <div className="card p-6">
        <h2 className="font-bold mb-1">Bekleyen Öneriler</h2>
        <p className="mono text-xs text-txt-dim mb-4">Skor = isim örtüşme oranı. Soldaki Toyzz ürünü, sağdaki barkodlu ürünle aynı mı? Onayla ✓ / Reddet ✗</p>
        {loading ? <div className="mono text-txt-dim animate-pulse py-4">Yükleniyor…</div>
          : sug.length === 0 ? <div className="mono text-sm text-txt-dim py-4">Bekleyen öneri yok. Yeni öneri için <span className="neon-text">npm run match:toyzz</span>.</div>
          : (
          <div className="space-y-2">
            {sug.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-2 border-b border-line/40">
                <span className="mono text-xs font-bold px-2 py-1 rounded shrink-0" style={{ color: confColor(a.confidence), background: `${confColor(a.confidence)}1a` }}>
                  {a.confidence != null ? "%" + Math.round(a.confidence * 100) : "—"}
                </span>
                <span className="flex-1 min-w-0 text-sm truncate" title={a.sku_name}><span className="text-[#f80b8a] mono text-[10px] mr-1">TOYZZ</span>{a.sku_name}</span>
                <span className="mono text-txt-dim shrink-0">↔</span>
                <span className="flex-1 min-w-0 text-sm text-txt-dim truncate" title={(a.match_name ?? "") + " · " + a.barkod}>{a.match_name}<span className="text-[10px] ml-1 opacity-50">[{a.barkod}]</span></span>
                <div className="flex gap-1 shrink-0">
                  <button disabled={busy === a.id} onClick={() => setStatus(a, "approved")}
                    className="mono text-xs px-3 py-1.5 rounded bg-neon/15 text-neon border border-neon/30 hover:bg-neon/25 disabled:opacity-40">✓ Onayla</button>
                  <button disabled={busy === a.id} onClick={() => setStatus(a, "rejected")}
                    className="mono text-xs px-3 py-1.5 rounded border border-line text-txt-dim hover:text-red-400 hover:border-red-400/40 disabled:opacity-40">✗</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Onaylananlar */}
      {approved.length > 0 && (
        <div className="card p-6">
          <h2 className="font-bold mb-4">Onaylananlar ({approved.length})</h2>
          <div className="space-y-1">
            {approved.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-1.5 border-b border-line/40 text-[13px]">
                <span className="flex-1 min-w-0 truncate"><span className="text-[#f80b8a] mono text-[10px] mr-1">TOYZZ</span>{a.sku_name}</span>
                <span className="mono text-txt-dim">↔</span>
                <span className="flex-1 min-w-0 text-txt-dim truncate">{a.match_name}<span className="text-[10px] ml-1 opacity-50">[{a.barkod}]</span></span>
                <button disabled={busy === a.id} onClick={() => setStatus(a, "suggested")}
                  className="mono text-[11px] px-2 py-1 rounded border border-line text-txt-dim hover:text-neon shrink-0 disabled:opacity-40">geri al</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
