// İstemci tarafı JSON fetch — r.ok + d.error kontrolü + standart hata mesajı tek yerde.
// 15 sayfadaki tekrar eden fetch+ayrıştırma boilerplate'ini tek satıra indirir.
// Her çağrı meşgul sayacından geçer (başlıktaki logo bekleme boyunca tarar).
import { izle } from "./mesgul";

export function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  return izle((async () => {
    const r = await fetch(url, init);
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok || (d && d.error)) {
      throw new Error((d && d.error) || ("Sunucu hatası " + r.status));
    }
    return d as T;
  })());
}
