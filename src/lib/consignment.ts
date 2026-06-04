// Sat-Öde (konsinye) saf hesap katmanı — Supabase'den ayrık, test edilebilir.
// Girdi: ConsignmentLine[] (fatura kalemleri). Çıktı: kanal özetleri, tahsilat
// takvimi, vade yaşlandırma ve KPI'lar.
//
// Para mantığı:
//   net   = KDV hariç fatura tutarı (Net tutar)
//   total = KDV dahil = bizim FİİLEN tahsil edeceğimiz tutar (Toplam)
// "Açık" faturalar henüz kapanmamış; vade tarihi geçmişse tahsilat beklenen ama
// gerçekleşmemiş demektir (konsinyede satış gerçekleştiyse). Bunu "vadesi geçti"
// olarak işaretleriz — kesin "ödenmedi" iddiası değil, tahsilat takip sinyalidir.

import type { ConsignmentLine } from "./normalizers/types";
import { CHANNEL_TERMS } from "./margins";

const monthKey = (iso: string | null): string | null =>
  iso && iso.length >= 7 ? iso.slice(0, 7) : null;

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

// ───────────────────────── Kanal özeti ─────────────────────────
export interface ChannelSummary {
  retailer: string;
  lines: number;
  qty: number;
  net: number;            // KDV hariç toplam
  vat: number;            // KDV toplam
  total: number;          // KDV dahil toplam = tahsil edilecek
  byInvoiceMonth: { month: string; total: number }[]; // faturalama ayına göre (KDV dahil)
  firstInvoice: string | null;
  lastInvoice: string | null;
  firstDue: string | null;
  lastDue: string | null;
  overdueTotal: number;   // vadesi bugünden önce (KDV dahil)
  upcomingTotal: number;  // vadesi bugün/sonra (KDV dahil)
  vadeDays: number | null; // CHANNEL_TERMS'ten bilgi amaçlı sözleşme vadesi
}

export function channelSummaries(lines: ConsignmentLine[], today: string): ChannelSummary[] {
  const map = new Map<string, ConsignmentLine[]>();
  for (const l of lines) {
    if (!map.has(l.retailer)) map.set(l.retailer, []);
    map.get(l.retailer)!.push(l);
  }
  const out: ChannelSummary[] = [];
  for (const [retailer, ls] of map) {
    let qty = 0, net = 0, vat = 0, total = 0, overdueTotal = 0, upcomingTotal = 0;
    const byMonth = new Map<string, number>();
    const invDates: string[] = [];
    const dueDates: string[] = [];
    for (const l of ls) {
      qty += l.qty; net += l.net_amount; vat += l.vat; total += l.total;
      const im = monthKey(l.invoice_date);
      if (im) byMonth.set(im, (byMonth.get(im) ?? 0) + l.total);
      if (l.invoice_date) invDates.push(l.invoice_date);
      if (l.due_date) {
        dueDates.push(l.due_date);
        if (l.due_date < today) overdueTotal += l.total; else upcomingTotal += l.total;
      }
    }
    invDates.sort(); dueDates.sort();
    out.push({
      retailer, lines: ls.length, qty, net, vat, total,
      byInvoiceMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, t]) => ({ month, total: t })),
      firstInvoice: invDates[0] ?? null,
      lastInvoice: invDates[invDates.length - 1] ?? null,
      firstDue: dueDates[0] ?? null,
      lastDue: dueDates[dueDates.length - 1] ?? null,
      overdueTotal, upcomingTotal,
      vadeDays: CHANNEL_TERMS[retailer]?.vadeDays ?? null,
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// ───────────────────────── KPI özeti ─────────────────────────
export interface ConsignmentKpis {
  totalNet: number;
  totalVat: number;
  totalGross: number;     // KDV dahil = toplam açık sevk / tahsil edilecek
  totalQty: number;
  lineCount: number;
  invoiceCount: number;
  channelCount: number;
  overdueGross: number;   // vadesi geçmiş (KDV dahil)
  dueThisMonthGross: number;
  nextDue: { date: string; gross: number } | null;
  invoiceRange: [string, string] | null;
}

export function consignmentKpis(lines: ConsignmentLine[], today: string): ConsignmentKpis {
  let totalNet = 0, totalVat = 0, totalGross = 0, totalQty = 0;
  let overdueGross = 0, dueThisMonthGross = 0;
  const invoices = new Set<string>();
  const channels = new Set<string>();
  const invDates: string[] = [];
  const tMonth = today.slice(0, 7);
  const futureDue = new Map<string, number>(); // date → gross (bugün ve sonrası)

  for (const l of lines) {
    totalNet += l.net_amount; totalVat += l.vat; totalGross += l.total; totalQty += l.qty;
    if (l.invoice_no) invoices.add(`${l.retailer}|${l.invoice_no}`);
    channels.add(l.retailer);
    if (l.invoice_date) invDates.push(l.invoice_date);
    if (l.due_date) {
      if (l.due_date < today) overdueGross += l.total;
      else futureDue.set(l.due_date, (futureDue.get(l.due_date) ?? 0) + l.total);
      if (monthKey(l.due_date) === tMonth) dueThisMonthGross += l.total;
    }
  }
  invDates.sort();
  const nextDueDate = [...futureDue.keys()].sort()[0] ?? null;

  return {
    totalNet, totalVat, totalGross, totalQty,
    lineCount: lines.length,
    invoiceCount: invoices.size,
    channelCount: channels.size,
    overdueGross, dueThisMonthGross,
    nextDue: nextDueDate ? { date: nextDueDate, gross: futureDue.get(nextDueDate)! } : null,
    invoiceRange: invDates.length ? [invDates[0], invDates[invDates.length - 1]] : null,
  };
}

// ───────────────────────── Tahsilat (vade) takvimi ─────────────────────────
export interface CollectionBucket {
  month: string;          // vade ayı YYYY-MM
  gross: number;          // KDV dahil tahsilat
  net: number;
  byRetailer: Record<string, number>; // kanal → KDV dahil
  status: "overdue" | "current" | "future";
}

// Vade ayına göre tahsilat takvimi: "hangi ay ne kadar para tahsil edilecek".
export function collectionSchedule(lines: ConsignmentLine[], today: string): CollectionBucket[] {
  const tMonth = today.slice(0, 7);
  const map = new Map<string, { gross: number; net: number; byRetailer: Record<string, number> }>();
  for (const l of lines) {
    const m = monthKey(l.due_date);
    if (!m) continue;
    let e = map.get(m);
    if (!e) { e = { gross: 0, net: 0, byRetailer: {} }; map.set(m, e); }
    e.gross += l.total; e.net += l.net_amount;
    e.byRetailer[l.retailer] = (e.byRetailer[l.retailer] ?? 0) + l.total;
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, e]) => ({
      month, gross: e.gross, net: e.net, byRetailer: e.byRetailer,
      status: month < tMonth ? "overdue" : month === tMonth ? "current" : "future",
    }));
}

// ───────────────────────── Vade yaşlandırma ─────────────────────────
export interface AgingBuckets {
  overdue: number;    // vadesi geçti (gün < 0)
  due0_30: number;    // 0–30 gün içinde
  due31_60: number;
  due61_90: number;
  due90plus: number;
  noDueDate: number;  // vadesi olmayan (varsa)
}

export function aging(lines: ConsignmentLine[], today: string): AgingBuckets {
  const b: AgingBuckets = { overdue: 0, due0_30: 0, due31_60: 0, due61_90: 0, due90plus: 0, noDueDate: 0 };
  for (const l of lines) {
    if (!l.due_date) { b.noDueDate += l.total; continue; }
    const d = daysBetween(today, l.due_date);
    if (d < 0) b.overdue += l.total;
    else if (d <= 30) b.due0_30 += l.total;
    else if (d <= 60) b.due31_60 += l.total;
    else if (d <= 90) b.due61_90 += l.total;
    else b.due90plus += l.total;
  }
  return b;
}

// ───────────────────────── Kanal detayı (drill) ─────────────────────────
// Bir kanalın fatura kalemleri, faturaya göre gruplanmış (tarih→fatura→kalemler).
export interface InvoiceGroup {
  invoice_no: string;
  invoice_date: string;
  due_date: string | null;
  net: number;
  total: number;
  qty: number;
  lines: ConsignmentLine[];
}

export function invoicesForChannel(lines: ConsignmentLine[], retailer: string): InvoiceGroup[] {
  const map = new Map<string, InvoiceGroup>();
  for (const l of lines) {
    if (l.retailer !== retailer) continue;
    const key = l.invoice_no || `${l.invoice_date}|${l.belge_no ?? ""}`;
    let g = map.get(key);
    if (!g) {
      g = { invoice_no: l.invoice_no, invoice_date: l.invoice_date, due_date: l.due_date, net: 0, total: 0, qty: 0, lines: [] };
      map.set(key, g);
    }
    g.net += l.net_amount; g.total += l.total; g.qty += l.qty; g.lines.push(l);
  }
  return [...map.values()].sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));
}

// ═══════════════════════ MUTABAKAT (sevk vs satış) ═══════════════════════
// Konsinye gerçeği: tahsilat = SATILAN kadar; satılmayan iade edilir. CORTEX'in
// haftalık sell-through'u (net kazanç = bizim toptan tahsilatımızla AYNI taban,
// margins.ts köprüsüyle) "ne kadar satıldı = ne kadar tahsil edilebilir"i verir.
//   sevkNet  = gönderdiğimiz (Sat Öde net)
//   soldNet  = satılan = tahsil edilebilir (CORTEX net kazanç)
//   returnRiskNet = max(0, sevk − satılan)   [yalnız satış verisi sevk dönemini kapsıyorsa]
// DİKKAT: Sat Öde'de barkod yok → eşleştirme KANAL-DEĞER düzeyinde, SKU değil.
// Satış verisi sevk dönemini kapsamıyorsa (ör. CORTEX'te kanal Mayıs'ta başlıyor,
// sevk Oca–Nis) "iade riski" hesaplanmaz (eksik veri ≠ satılmadı).

export interface WeeklyNet { retailer: string; week_start: string; net: number; }

function addDaysISO(iso: string, days: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

export interface ChannelReconcile {
  retailer: string;
  sevkNet: number;          // gönderilen (KDV hariç)
  sevkGross: number;        // gönderilen (KDV dahil)
  qty: number;
  soldNet: number;          // satılan = tahsil edilebilir (net kazanç)
  sellThroughPct: number | null;
  returnRiskNet: number | null;   // satılmayan ≈ iade riski (yalnız coverage=ok)
  coverage: "ok" | "partial" | "none";
  sevkFirst: string | null; sevkLast: string | null;
  sellFirst: string | null; sellLast: string | null;
  vadeDays: number | null;
}

export function reconcileChannels(lines: ConsignmentLine[], weekly: WeeklyNet[]): ChannelReconcile[] {
  const sevk = new Map<string, { net: number; gross: number; qty: number; first: string | null; last: string | null }>();
  for (const l of lines) {
    let e = sevk.get(l.retailer);
    if (!e) { e = { net: 0, gross: 0, qty: 0, first: null, last: null }; sevk.set(l.retailer, e); }
    e.net += l.net_amount; e.gross += l.total; e.qty += l.qty;
    if (l.invoice_date) {
      if (!e.first || l.invoice_date < e.first) e.first = l.invoice_date;
      if (!e.last || l.invoice_date > e.last) e.last = l.invoice_date;
    }
  }
  const sold = new Map<string, { net: number; first: string | null; last: string | null }>();
  for (const w of weekly) {
    let e = sold.get(w.retailer);
    if (!e) { e = { net: 0, first: null, last: null }; sold.set(w.retailer, e); }
    e.net += w.net;
    if (!e.first || w.week_start < e.first) e.first = w.week_start;
    if (!e.last || w.week_start > e.last) e.last = w.week_start;
  }

  const out: ChannelReconcile[] = [];
  for (const [retailer, s] of sevk) {
    const so = sold.get(retailer);
    // Pencere hizası: yalnızca sevk başlangıcından (s.first) sonraki satışları say.
    // Sevkten ÖNCEKİ dönemin satışı bu sevk partisini temsil etmez (eski stok),
    // bu yüzden sell-through%'a katılmaz. coverage kararı tüm satış başına (so.first)
    // göre verilir; soldNet ise pencereye kırpılır.
    let soldNet = 0;
    for (const w of weekly) {
      if (w.retailer !== retailer) continue;
      if (s.first && w.week_start < s.first) continue;
      soldNet += w.net;
    }
    // coverage: satış verisi sevk dönemini kapsıyor mu?
    let coverage: "ok" | "partial" | "none";
    if (!so || so.first == null) coverage = "none";
    else if (s.first && so.first <= s.first) coverage = "ok";        // satış, sevk başından önce/eşzamanlı
    else if (s.last && so.first <= s.last) coverage = "partial";     // kısmi örtüşme
    else coverage = "none";                                          // satış verisi sevkten sonra başlıyor
    out.push({
      retailer, sevkNet: s.net, sevkGross: s.gross, qty: s.qty, soldNet,
      sellThroughPct: coverage !== "none" && s.net > 0 ? (soldNet / s.net) * 100 : null,
      returnRiskNet: coverage === "ok" ? Math.max(0, s.net - soldNet) : null,
      coverage,
      sevkFirst: s.first, sevkLast: s.last,
      sellFirst: so?.first ?? null, sellLast: so?.last ?? null,
      vadeDays: CHANNEL_TERMS[retailer]?.vadeDays ?? null,
    });
  }
  return out.sort((a, b) => b.sevkNet - a.sevkNet);
}

// ───────── Satışa dayalı tahsilat takvimi ─────────
// Gerçek tahsilat = SATIŞ tarihi + kanal vadesi (faturanın nominal vadesi değil).
// Her haftanın net satışını, o kanalın vadesi kadar ileri taşıyıp aya kova(r).
export interface SalesCollectionBucket {
  month: string;
  net: number;
  byRetailer: Record<string, number>;
  status: "collected" | "upcoming";
}

export function salesCollectionSchedule(
  weekly: WeeklyNet[], today: string
): { buckets: SalesCollectionBucket[]; collectedTotal: number; upcomingTotal: number } {
  const tMonth = today.slice(0, 7);
  const map = new Map<string, { net: number; byRetailer: Record<string, number> }>();
  let collectedTotal = 0, upcomingTotal = 0;
  for (const w of weekly) {
    const vade = CHANNEL_TERMS[w.retailer]?.vadeDays ?? 0;
    const collDate = addDaysISO(w.week_start, vade);
    const month = collDate.slice(0, 7);
    let e = map.get(month);
    if (!e) { e = { net: 0, byRetailer: {} }; map.set(month, e); }
    e.net += w.net; e.byRetailer[w.retailer] = (e.byRetailer[w.retailer] ?? 0) + w.net;
    if (collDate < today) collectedTotal += w.net; else upcomingTotal += w.net;
  }
  const buckets = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, e]) => ({
    month, net: e.net, byRetailer: e.byRetailer,
    status: (month < tMonth ? "collected" : "upcoming") as "collected" | "upcoming",
  }));
  return { buckets, collectedTotal, upcomingTotal };
}
