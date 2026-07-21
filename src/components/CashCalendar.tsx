"use client";

// Nakit Takvimi — konsinye modelde paranın kasaya NE ZAMAN gireceği.
// /api/cashflow: her haftanın net kazancı, hafta bitişi + kanal vadesi günü
// tahsil edilir varsayılır → ay bazında projeksiyon + sahada bekleyen alacak.
import { useEffect, useState } from "react";
import { colorOf, fmtMoney } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import { Info } from "@/components/Info";

interface CashMonth { month: string; label: string; total: number; byChannel: Record<string, number> }
interface CashData {
  asOf: string;
  receivable: { total: number; byChannel: { retailer: string; amount: number; vadeDays: number | null }[] };
  months: CashMonth[];
}

export function CashCalendar() {
  const [data, setData] = useState<CashData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchJson("/api/cashflow").then(setData).catch(() => setFailed(true));
  }, []);

  if (failed) return null;
  if (!data) {
    return <div className="card p-5 mono text-xs text-txt-dim animate-pulse">💰 Nakit takvimi hesaplanıyor…</div>;
  }
  if (!data.months.length) return null;

  const maxMonth = Math.max(...data.months.map((m) => m.total), 1);

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h2 className="font-bold">
          💰 Nakit Takvimi
          <span className="mono text-xs text-txt-dim font-normal ml-2">tahmini tahsilat</span>
          <Info text={"Model: haftanın net kazancı, hafta bitişi + kanal vadesi günü tahsil edilir (Huppa 30g · D&R 90g · Armağan 95g · Toyzz/Nezih 150g). Geçmiş vadeler tahsil edilmiş varsayılır; iade/kesinti öngörülmez."} />
        </h2>
        <div className="mono text-xs text-txt-dim">
          SAHADA BEKLEYEN ALACAK{" "}
          <span className="neon-text font-bold text-base">{fmtMoney(data.receivable.total)}</span>
        </div>
      </div>

      {/* Kanal kırılımı — bekleyen alacağın kimde olduğu + vadesi */}
      <div className="flex flex-wrap gap-2 mb-4">
        {data.receivable.byChannel.map((c) => (
          <span key={c.retailer} className="mono text-[11px] px-2 py-1 rounded border"
            style={{ color: colorOf(c.retailer), borderColor: colorOf(c.retailer) + "40", background: colorOf(c.retailer) + "10" }}>
            {c.retailer} {fmtMoney(c.amount)}{c.vadeDays != null && <span className="opacity-60"> · {c.vadeDays}g</span>}
          </span>
        ))}
      </div>

      {/* Ay bazında projeksiyon — kanal renkli yığılı bar */}
      <div className="space-y-2">
        {data.months.map((m) => (
          <div key={m.month} className="flex items-center gap-3">
            <span className="mono text-xs text-txt-dim w-24 shrink-0">{m.label}</span>
            <div className="flex-1 h-4 rounded bg-ink-3 overflow-hidden flex">
              {Object.entries(m.byChannel)
                .sort((a, b) => b[1] - a[1])
                .map(([ret, amt]) => (
                  <div key={ret} title={`${ret}: ${fmtMoney(amt)}`}
                    className="h-full first:rounded-l last:rounded-r"
                    style={{ width: `${(amt / maxMonth) * 100}%`, background: colorOf(ret), opacity: 0.85 }} />
                ))}
            </div>
            <span className="mono text-xs w-24 text-right shrink-0">{fmtMoney(m.total)}</span>
          </div>
        ))}
      </div>

      <p className="mono text-[10px] text-txt-dim mt-3">
        Varsayım: satış haftası + vade; Nezih faturadan çalışır (yaklaşık). Kesin mutabakat aşağıdaki tabloda.
      </p>
    </div>
  );
}
