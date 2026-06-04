// İstemci tarafı JSON fetch — r.ok + d.error kontrolü + standart hata mesajı tek yerde.
// 15 sayfadaki tekrar eden fetch+ayrıştırma boilerplate'ini tek satıra indirir.
export async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({} as any));
  if (!r.ok || (d && d.error)) {
    throw new Error((d && d.error) || ("Sunucu hatası " + r.status));
  }
  return d as T;
}
