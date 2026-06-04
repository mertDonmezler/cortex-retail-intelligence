"use client";

import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { WeeklySummary, RETAILERS, fmtDate, fmtInt, fmtMoney, RETAILER_COLORS } from "@/lib/format";

const COLORS = RETAILER_COLORS;

export function TrendChart({ summary }: { summary: WeeklySummary[] }) {
  const [metric, setMetric] = useState<"qty" | "value">("value"); // varsayılan TL

  const data = useMemo(() => {
    const weeks = [...new Set(summary.map((s) => s.week_start))].sort();
    return weeks.map((w) => {
      const row: Record<string, number | string> = { week: fmtDate(w) };
      for (const r of RETAILERS) {
        const rec = summary.find((s) => s.week_start === w && s.retailer === r);
        if (rec) {
          row[r] = metric === "qty"
            ? Number(rec.sales_qty)
            : Number(rec.sales_value ?? 0);
        }
      }
      return row;
    });
  }, [summary, metric]);

  if (data.length < 2) {
    return (
      <div className="card p-6">
        <div className="mono text-sm text-txt-dim">
          Trend grafiği için en az 2 hafta verisi gerekli.
        </div>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold">Haftalık Trend</h2>
        <div className="flex gap-1 mono text-xs">
          <button
            onClick={() => setMetric("value")}
            className={`px-3 py-1 rounded ${metric === "value" ? "bg-neon/15 text-neon" : "text-txt-dim"}`}
          >TL</button>
          <button
            onClick={() => setMetric("qty")}
            className={`px-3 py-1 rounded ${metric === "qty" ? "bg-neon/15 text-neon" : "text-txt-dim"}`}
          >Adet</button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={340}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="#1f2a1f" strokeDasharray="3 3" />
          <XAxis dataKey="week" stroke="#7d927d" fontSize={11} tickMargin={8} />
          <YAxis stroke="#7d927d" fontSize={11} width={64}
            tickFormatter={(v) => (metric === "value" ? "₺" : "") + (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)} />
          <Tooltip
            contentStyle={{ background: "#0f150f", border: "1px solid #1f2a1f", borderRadius: 10, fontSize: 12 }}
            labelStyle={{ color: "#d8e8d8" }}
            formatter={(v: any) => (metric === "value" ? fmtMoney(Number(v)) : fmtInt(Number(v)))}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {RETAILERS.map((r) => (
            <Line key={r} type="monotone" dataKey={r} stroke={COLORS[r]}
              strokeWidth={2} dot={{ r: 2 }} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
