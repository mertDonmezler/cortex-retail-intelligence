"use client";

import { useEffect, useMemo, useState } from "react";
import { SortableTh, SearchBox, MultiChips, RangeMin, useSort, CsvBtn } from "@/components/Controls";
import { colorOf } from "@/lib/format";
import { parseProductMeta } from "@/lib/compute";

interface Cand { barkod: string; name: string; score: number; src?: string }
interface Alias {
  id: number; retailer: string; sku_name: string; barkod: string;
  match_name: string | null; confidence: number | null; status: string;
  candidates?: Cand[] | null; // auto-öneri için sıralı aday EAN'ler (/eslesme seçimi)
}

const confColor = (c: number | null) => (c == null ? "#7d927d" : c >= 0.8 ? "#1FF80B" : c >= 0.7 ? "#f8b00b" : "#ff8855");

// Bir alias listesini istemci tarafında filtrele: perakendeci + min güven + metin.
// (Veri zaten çekili; burada sadece görünür alt kümeyi daraltıyoruz.)
function filterAliases(rows: Alias[], retailers: Set<string>, minConf: number, q: string): Alias[] {
  const needle = q.trim().toLowerCase();
  const minFrac = minConf / 100; // RangeMin yüzde (0-100) → oran (0-1)
  return rows.filter((a) => {
    if (retailers.size && !retailers.has(a.retailer)) return false;
    // Güven eşiği yalnız değeri olan satırlara uygulanır; null güven (eşik 0 değilse) elenir.
    if (minConf > 0 && (a.confidence == null || a.confidence < minFrac)) return false;
    if (needle) {
      const hay = `${a.sku_name} ${a.match_name ?? ""} ${a.barkod}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export default function EslesmePage() {
  const [sug, setSug] = useState<Alias[]>([]);
  const [approved, setApproved] = useState<Alias[]>([]);
  const [rejected, setRejected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [choice, setChoice] = useState<Record<number, string>>({}); // id → seçilen/manuel EAN

  // ── İstemci-tarafı analiz kontrolleri ──
  const [retSel, setRetSel] = useState<string[]>([]); // boş = tüm perakendeciler
  const [minConf, setMinConf] = useState(0); // % cinsinden min güven eşiği
  const [q, setQ] = useState(""); // ürün / eşleşme / barkod araması

  function load() {
    fetch("/api/alias")
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok || d?.error) throw new Error(d?.error || ("HTTP " + r.status)); return d; })
      .then((d) => { setSug(d.suggestions ?? []); setApproved(d.approved ?? []); setRejected(d.rejectedCount ?? 0); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function setStatus(a: Alias, status: "approved" | "rejected" | "suggested", override?: { barkod?: string; match_name?: string | null }) {
    setBusy(a.id);
    try {
      const r = await fetch("/api/alias", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id, status, ...override }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      // yerel state güncelle (onayda seçilen aday EAN/ad'ı yansıt)
      setSug((s) => s.filter((x) => x.id !== a.id));
      setApproved((s) => {
        const without = s.filter((x) => x.id !== a.id);
        const merged = { ...a, status, barkod: override?.barkod ?? a.barkod, match_name: override?.match_name ?? a.match_name };
        return status === "approved" ? [merged, ...without] : without;
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

  // Chip seçenekleri: yalnız veride gerçekten görünen perakendeciler (öneri + onaylı).
  const retOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of sug) if (a.retailer) set.add(a.retailer);
    for (const a of approved) if (a.retailer) set.add(a.retailer);
    return [...set].sort((x, y) => x.localeCompare(y, "tr"));
  }, [sug, approved]);

  const retSet = useMemo(() => new Set(retSel), [retSel]);

  // Filtre uygulanmış listeler (sıralamadan önce).
  const sugFiltered = useMemo(() => filterAliases(sug, retSet, minConf, q), [sug, retSet, minConf, q]);
  const approvedFiltered = useMemo(() => filterAliases(approved, retSet, minConf, q), [approved, retSet, minConf, q]);

  // Önerilerde sıralama (güven varsayılan, azalan). Onaylananlar mevcut sırayı korur.
  const { sorted: sugSorted, sortKey, dir, toggle } = useSort<Alias>(sugFiltered, "confidence", "desc");

  const filtersOn = retSel.length > 0 || minConf > 0 || q.trim() !== "";
  const toggleRet = (r: string) => setRetSel((s) => (s.includes(r) ? s.filter((x) => x !== r) : [...s, r]));
  const clearFilters = () => { setRetSel([]); setMinConf(0); setQ(""); };

  // Güven bandı dağılımı (bekleyen öneriler) — confColor ile aynı eşikler.
  // Onay kuyruğunu hızlı okumak için: kaçı güvenli, kaçı şüpheli? Banda tıkla → min güven filtresi.
  const confBands = useMemo(() => {
    let high = 0, mid = 0, low = 0, none = 0;
    for (const a of sug) {
      if (a.confidence == null) none++;
      else if (a.confidence >= 0.8) high++;
      else if (a.confidence >= 0.7) mid++;
      else low++;
    }
    return { high, mid, low, none };
  }, [sug]);

  // CSV: filtrelenmiş önerileri düz satırlara indir (güven yüzdeye çevrilir).
  const csvRows = useMemo(
    () => sugSorted.map((a) => ({
      perakendeci: a.retailer,
      urun: a.sku_name,
      eslesme: a.match_name ?? "",
      barkod: a.barkod,
      guven: a.confidence != null ? Math.round(a.confidence * 100) : "",
    })),
    [sugSorted]
  );
  const csvCols = [
    { key: "perakendeci" as const, label: "Perakendeci" },
    { key: "urun" as const, label: "Ürün" },
    { key: "eslesme" as const, label: "Eşleşen Ürün" },
    { key: "barkod" as const, label: "Barkod" },
    { key: "guven" as const, label: "Güven %" },
  ];

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

      {/* ── Güven bandı dağılımı (bekleyen) ── */}
      {/* Yüksek/Orta bantlar min-güven filtresine tıklanabilir (alt-sınır olarak ifade edilebilir).
          Düşük/Güven-yok yalnız bilgi amaçlı: alt-sınırlı filtreyle izole edilemez. */}
      {sug.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([
            { label: "YÜKSEK ≥%80", n: confBands.high, c: "#1FF80B", thr: 80 },
            { label: "ORTA %70–79", n: confBands.mid, c: "#f8b00b", thr: 70 },
            { label: "DÜŞÜK <%70", n: confBands.low, c: "#ff8855", thr: null },
            { label: "GÜVEN YOK", n: confBands.none, c: "#7d927d", thr: null },
          ] as const).map((b) => {
            const num = <div className="text-2xl font-bold mono mt-1" style={{ color: b.n > 0 ? b.c : "#7d927d" }}>{b.n}</div>;
            const lbl = <div className="mono text-[10px] text-txt-dim tracking-wider">{b.label}</div>;
            if (b.thr == null) {
              return <div key={b.label} className="card p-4">{lbl}{num}</div>;
            }
            const isActive = minConf === b.thr;
            return (
              <button
                key={b.label}
                type="button"
                onClick={() => setMinConf((m) => (m === b.thr ? 0 : b.thr))}
                aria-pressed={isActive}
                title={isActive ? "Güven filtresini kaldır" : `Min güven %${b.thr} olarak filtrele`}
                className="card p-4 text-left transition-colors hover:border-neon/50"
                style={isActive ? { borderColor: b.c + "80", background: b.c + "12" } : undefined}
              >
                {lbl}{num}
              </button>
            );
          })}
        </div>
      )}

      {dirty && <div className="card p-3 border-l-4 mono text-xs text-txt-dim" style={{ borderLeftColor: "#f8b00b" }}>Değişiklik var — Ölü Stok/listelere yansıması için sağ üstten <span className="text-txt font-bold">Uygula</span>'ya bas.</div>}

      {/* ── Filtre paneli (istemci tarafı; çekili veriyi daraltır) ── */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <SearchBox value={q} onChange={setQ} placeholder="Ürün, eşleşme veya barkod ara…" className="flex-1 min-w-[220px]" />
          <RangeMin label="Min güven" value={minConf} onChange={setMinConf} suffix="%" step={5} min={0} />
          {filtersOn && (
            <button type="button" onClick={clearFilters}
              className="mono text-[11px] text-txt-dim hover:text-neon transition-colors">filtreyi temizle</button>
          )}
        </div>
        {retOptions.length > 1 && (
          <MultiChips
            label="Perakendeci:"
            options={retOptions}
            selected={retSel}
            onToggle={toggleRet}
            onAll={() => setRetSel([...retOptions])}
            onNone={() => setRetSel([])}
            colorOf={colorOf}
          />
        )}
      </div>

      {/* Öneriler */}
      <div className="card p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
          <h2 className="font-bold">Bekleyen Öneriler</h2>
          <div className="flex items-center gap-3">
            <span className="mono text-xs text-txt-dim">{sugSorted.length} / {sug.length}</span>
            <CsvBtn filename="cortex-eslesme-oneriler" rows={csvRows} cols={csvCols} />
          </div>
        </div>
        <p className="mono text-xs text-txt-dim mb-4">Skor = isim örtüşme oranı. Soldaki Toyzz ürünü için sağdaki açılır listeden doğru barkodlu eşi seç (ya da ✎ manuel EAN gir), sonra Onayla ✓. Yanlışsa Reddet ✗</p>
        {loading ? <div className="mono text-txt-dim animate-pulse py-4">Yükleniyor…</div>
          : sug.length === 0 ? <div className="mono text-sm text-txt-dim py-4">Bekleyen öneri yok. Yeni öneri için <span className="neon-text">npm run match:toyzz</span>.</div>
          : sugSorted.length === 0 ? <div className="mono text-sm text-txt-dim py-4">Filtreyle eşleşen öneri yok. <button type="button" onClick={clearFilters} className="neon-text hover:underline">Filtreyi temizle</button>.</div>
          : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <SortableTh label="Güven" sortKey="confidence" active={sortKey === "confidence"} dir={dir} onClick={toggle} align="left" />
                  <SortableTh label="Toyzz Ürünü" sortKey="sku_name" active={sortKey === "sku_name"} dir={dir} onClick={toggle} align="left" />
                  <SortableTh label="Eşleşen Ürün" sortKey="match_name" active={sortKey === "match_name"} dir={dir} onClick={toggle} align="left" />
                  <th className="text-right">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {sugSorted.map((a) => {
                  const meta = parseProductMeta(a.sku_name);
                  const cands = a.candidates ?? [];
                  const chosen = choice[a.id] ?? a.barkod;            // seçili/manuel EAN
                  const inList = cands.some((c) => c.barkod === chosen);
                  const chosenName = cands.find((c) => c.barkod === chosen)?.name ?? (chosen === a.barkod ? a.match_name : null);
                  return (
                    <tr key={a.id} className="border-b border-line/40">
                      <td>
                        <span className="mono text-xs font-bold px-2 py-1 rounded inline-block" style={{ color: confColor(a.confidence), background: `${confColor(a.confidence)}1a` }}>
                          {a.confidence != null ? "%" + Math.round(a.confidence * 100) : "—"}
                        </span>
                      </td>
                      <td className="max-w-xs">
                        <div className="text-sm truncate" title={a.sku_name}>
                          <span className="mono text-[10px] mr-1" style={{ color: colorOf(a.retailer) }}>{a.retailer.toUpperCase()}</span>{a.sku_name}
                        </div>
                        {(meta.team !== "Genel" || meta.brand !== "Diğer" || meta.type !== "Diğer") && (
                          <div className="flex gap-1 flex-wrap mt-0.5">
                            {meta.brand !== "Diğer" && <span className="mono text-[9px] px-1 py-0.5 rounded bg-ink-2 text-txt-dim">{meta.brand}</span>}
                            {meta.team !== "Genel" && <span className="mono text-[9px] px-1 py-0.5 rounded bg-ink-2 text-txt-dim">{meta.team}</span>}
                            {meta.type !== "Diğer" && <span className="mono text-[9px] px-1 py-0.5 rounded bg-ink-2 text-txt-dim">{meta.type}</span>}
                          </div>
                        )}
                      </td>
                      <td className="max-w-sm">
                        {cands.length > 0 ? (
                          <div className="space-y-1">
                            <select
                              value={inList ? chosen : "__m"}
                              onChange={(e) => setChoice((c) => ({ ...c, [a.id]: e.target.value === "__m" ? "" : e.target.value }))}
                              title="Doğru eşleşmeyi seç veya manuel EAN gir"
                              className="mono text-[11px] bg-ink-2 border border-line rounded px-1.5 py-1 w-full text-txt"
                            >
                              {cands.map((c) => (
                                <option key={c.barkod} value={c.barkod}>%{Math.round((c.score ?? 0) * 100)} · {c.name} [{c.barkod}]</option>
                              ))}
                              <option value="__m">✎ manuel EAN…</option>
                            </select>
                            {!inList && (
                              <input
                                value={chosen}
                                onChange={(e) => setChoice((c) => ({ ...c, [a.id]: e.target.value.replace(/\D/g, "") }))}
                                placeholder="EAN (8-14 hane)" inputMode="numeric"
                                className="mono text-[11px] bg-ink-2 border border-line rounded px-1.5 py-1 w-full text-txt"
                              />
                            )}
                          </div>
                        ) : (
                          <div className="text-sm text-txt-dim truncate" title={(a.match_name ?? "") + " · " + a.barkod}>
                            {a.match_name}<span className="text-[10px] ml-1 opacity-50">[{a.barkod}]</span>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="flex gap-1 justify-end">
                          <button disabled={busy === a.id || (!inList && !/^\d{8,14}$/.test(chosen))}
                            onClick={() => setStatus(a, "approved", { barkod: chosen, match_name: chosenName })}
                            className="mono text-xs px-3 py-1.5 rounded bg-neon/15 text-neon border border-neon/30 hover:bg-neon/25 disabled:opacity-40">✓ Onayla</button>
                          <button disabled={busy === a.id} onClick={() => setStatus(a, "rejected")}
                            className="mono text-xs px-3 py-1.5 rounded border border-line text-txt-dim hover:text-red-400 hover:border-red-400/40 disabled:opacity-40">✗</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Onaylananlar */}
      {approved.length > 0 && (
        <div className="card p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <h2 className="font-bold">Onaylananlar</h2>
            <span className="mono text-xs text-txt-dim">{approvedFiltered.length} / {approved.length}</span>
          </div>
          {approvedFiltered.length === 0 ? (
            <div className="mono text-sm text-txt-dim py-2">Filtreyle eşleşen onaylı eşleşme yok. <button type="button" onClick={clearFilters} className="neon-text hover:underline">Filtreyi temizle</button>.</div>
          ) : (
          <div className="space-y-1">
            {approvedFiltered.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-1.5 border-b border-line/40 text-[13px]">
                <span className="flex-1 min-w-0 truncate"><span className="mono text-[10px] mr-1" style={{ color: colorOf(a.retailer) }}>{a.retailer.toUpperCase()}</span>{a.sku_name}</span>
                <span className="mono text-txt-dim">↔</span>
                <span className="flex-1 min-w-0 text-txt-dim truncate">{a.match_name}<span className="text-[10px] ml-1 opacity-50">[{a.barkod}]</span></span>
                <button disabled={busy === a.id} onClick={() => setStatus(a, "suggested")}
                  className="mono text-[11px] px-2 py-1 rounded border border-line text-txt-dim hover:text-neon shrink-0 disabled:opacity-40">geri al</button>
              </div>
            ))}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
