"use client";

// Aksiyon Zekâsı — dashboard'a gömülü haftalık "ne yapmalı" özeti (yeni sayfa yok).
// Veri kaynağı mevcut /api/routing (uzman segment motoru): SEVK tarafı tükenme
// riskini, ÇEK tarafı bağlanmış parayı (likidasyon/depo/transfer, PSF) gösterir.
// İkincil veri: hata/boşlukta sessizce kaybolur, dashboard'ı asla bozmaz.
import { useEffect, useState } from "react";
import { colorOf, fmtInt, fmtMoney } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";

interface Route {
  sku_name: string;
  retailer: string;
  action: "SEVK" | "LIKIDASYON" | "TRANSFER" | "DEPO" | "İZLE";
  qty: number;
  value: number;
  reason: string;
  dest?: { retailer: string; qty: number } | null;
}

const CEK_BADGE: Record<string, { label: string; color: string }> = {
  LIKIDASYON: { label: "LİKİDE", color: "#ff5555" },
  TRANSFER: { label: "TRANSFER", color: "#22d3ee" },
  DEPO: { label: "DEPO", color: "#f8b00b" },
};

function Chip({ retailer }: { retailer: string }) {
  const c = colorOf(retailer);
  return (
    <span className="mono text-[10px] px-1.5 py-0.5 rounded shrink-0"
      style={{ color: c, border: `1px solid ${c}40`, background: c + "14" }}>
      {retailer}
    </span>
  );
}

export function ActionPanel() {
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchJson("/api/routing?mode=denge")
      .then((d) => setRoutes((d?.routes ?? []) as Route[]))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;
  if (routes === null) {
    return (
      <div className="card p-5 mono text-xs text-txt-dim animate-pulse">
        ⚡ Aksiyon Zekâsı hesaplanıyor…
      </div>
    );
  }

  const sevk = routes.filter((r) => r.action === "SEVK").slice(0, 5);
  const cekAll = routes.filter((r) => r.action === "LIKIDASYON" || r.action === "TRANSFER" || r.action === "DEPO");
  const cek = [...cekAll].sort((a, b) => b.value - a.value).slice(0, 5);
  if (sevk.length === 0 && cek.length === 0) return null;

  const cekTotal = cekAll.reduce((a, r) => a + (r.value || 0), 0);
  const sevkCount = routes.filter((r) => r.action === "SEVK").length;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="mono text-xs text-txt-dim tracking-wider">⚡ AKSİYON ZEKÂSI · bu hafta ne yapmalı</div>
        <a href="/yonlendirme" className="mono text-xs neon-text">tüm kararlar &rarr;</a>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <div className="mono text-[11px] text-txt-dim mb-2">
            🚚 SEVK — tükenme riski <span className="text-txt-dim/60">({fmtInt(sevkCount)} ürün)</span>
          </div>
          {sevk.length === 0 ? (
            <div className="mono text-xs text-txt-dim py-2">Sevk bekleyen yok — kanallar dolu.</div>
          ) : (
            <div className="space-y-1.5">
              {sevk.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-sm" title={r.reason}>
                  <Chip retailer={r.retailer} />
                  <span className="flex-1 truncate">{r.sku_name}</span>
                  <span className="mono text-xs text-neon shrink-0">→ {fmtInt(r.qty)} adet</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mono text-[11px] text-txt-dim mb-2">
            📦 ÇEK — bağlanmış para <span className="text-txt-dim/60">(PSF {fmtMoney(cekTotal)})</span>
          </div>
          {cek.length === 0 ? (
            <div className="mono text-xs text-txt-dim py-2">Çekilecek fazla stok yok.</div>
          ) : (
            <div className="space-y-1.5">
              {cek.map((r, i) => {
                const b = CEK_BADGE[r.action];
                return (
                  <div key={i} className="flex items-center gap-2 text-sm" title={r.reason}>
                    <Chip retailer={r.retailer} />
                    <span className="flex-1 truncate">{r.sku_name}</span>
                    <span className="mono text-[10px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ color: b.color, border: `1px solid ${b.color}40` }}>
                      {b.label}{r.action === "TRANSFER" && r.dest ? ` → ${r.dest.retailer}` : ""}
                    </span>
                    <span className="mono text-xs text-txt-dim shrink-0 w-20 text-right">{fmtMoney(r.value)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
