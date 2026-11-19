// İstemci tarafı CSV indirme — herhangi bir nesne dizisini CSV'ye çevirir.
export function downloadCsv(filename: string, rows: Record<string, any>[], headers?: { key: string; label: string }[]) {
  if (!rows.length) return;
  const cols = headers ?? Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
  const escape = (v: any) => {
    if (v == null) return "";
    // SAYI ASLA FORMUL OLAMAZ. Formul korumasi eksi isaretiyle baslayan her
    // hucreyi tirnakliyordu; negatif yuzde degerleri Excel'de METIN oluyordu:
    // saga hizalanmiyor, toplanmiyor, siralanmiyor. Sayi tipi korumanin onunde
    // gecer - enjeksiyon riski yalnizca dizelerde var.
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    let s = String(v);
    // CSV/Excel formül enjeksiyonu: =, +, -, @, tab, CR ile başlayan hücreyi nötrle
    // Sayi BICIMINDEKI dizeler ("-34", "-3,5") de muaf - ayni sebep.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map((c) => escape(c.label)).join(";");
  const body = rows.map((r) => cols.map((c) => escape(r[c.key])).join(";")).join("\n");
  // Excel'in Türkçe karakterleri tanıması için BOM + ; ayraç
  const csv = "\uFEFF" + head + "\n" + body;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : filename + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
