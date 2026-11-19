// ÜRÜN ARAMA SORGUSU — /api/product?q= için parçalama.
//
// Sorgu virgülle (ya da ; / sekme / satır sonu) parçalara ayrılır; böylece bir
// listeden kopyalanan birden çok barkod tek seferde taranır. Her parça:
//   • 8-14 hane rakam  → yalnız BARKOD (ürün adında bu uzunlukta sayı geçmez),
//   • 4-7 hane rakam   → hem barkodun bir KISMI hem ürün adı ("2025" bir yıl da
//                        olabilir; bugün adla aranıyordu, o davranış korunur),
//   • diğer (2+ karakter) → ürün adı.
//
// BOŞLUKLA AYRILMIŞ LİSTE. Tek satırlı arama kutusu yapıştırılan satır sonlarını
// boşluğa çevirir (Excel sütunu → "8685185015616 8685185015623"). Boşlukla ayrılan
// her alt parça 8-14 hane rakamsa hepsi ayrı barkod sayılır; aksi hâlde boşluk ve
// tire tek barkodun gruplaması kabul edilip silinir ("868 5185 015616").
// 14 haneli, başında 0 olan GTIN → 13 haneli EAN'a indirilir (sistem EAN-13 tutar).
// Art arda okutulup bitişik gelen uzun rakam dizisi 13'ün katıysa 13'erli bölünür;
// değilse geçersiz sayılır ve sessizce ad olarak aranmaz.
export type AramaParcalari = { barkodlar: string[]; adlar: string[]; atlanan: string[]; gecersiz: string[] };

export const EN_COK_BARKOD = 100;

const TAM = /^\d{8,14}$/;

function normBarkod(b: string): string {
  return b.length === 14 && b.startsWith("0") ? b.slice(1) : b;
}

export function sorguParcala(q: string): AramaParcalari {
  const tum: string[] = [];
  const adlar: string[] = [];
  const gecersiz: string[] = [];
  const barkodEkle = (b: string) => { const n = normBarkod(b); if (!tum.includes(n)) tum.push(n); };
  const adEkle = (a: string) => { if (!adlar.includes(a)) adlar.push(a); };

  for (const ham of q.split(/[,;\n\t]+/)) {
    const t = ham.trim();
    if (!t) continue;
    const alt = t.split(/\s+/);
    if (alt.length > 1 && alt.every((x) => TAM.test(x))) { alt.forEach(barkodEkle); continue; }
    const rakam = t.replace(/[\s-]/g, "");
    if (/^\d+$/.test(rakam) && rakam.length > 14) {
      if (rakam.length % 13 === 0) for (let i = 0; i < rakam.length; i += 13) barkodEkle(rakam.slice(i, i + 13));
      else gecersiz.push(rakam);
      continue;
    }
    if (/^\d{4,14}$/.test(rakam)) {
      barkodEkle(rakam);
      if (rakam.length < 8) adEkle(t);
    } else if (t.length >= 2) {
      adEkle(t);
    }
  }
  return { barkodlar: tum.slice(0, EN_COK_BARKOD), atlanan: tum.slice(EN_COK_BARKOD), adlar, gecersiz };
}

// GÖRÜNEN AD. Toyzz 2026-09-28'den beri barkodlu ve aynı ürünün adlarından biri
// artık Toyzz'ın iç adlandırması ("ASP-MYT-KART GALATASARAY … 24D."). Ad alfabetik
// ilk ya da son satırdan seçilince hep bu kod-adı öne çıkıyordu. Kural girdi
// sırasından BAĞIMSIZ (liste ile karşılaştırma başlığı aynı adı göstersin): sabit
// firma önceliği, aynı firmada alfabetik ilk ad. Toyzz en sonda — ürün yalnız
// Toyzz'daysa Toyzz adı kalır.
const AD_ONCELIK = ["Huppaluppo", "Nezih", "DR", "Armağan", "Toyzz"];
export function gorunenAd(adlar: { retailer: string; sku_name: string }[]): string {
  let en: { retailer: string; sku_name: string } | null = null;
  const sira = (r: string) => { const i = AD_ONCELIK.indexOf(r); return i < 0 ? AD_ONCELIK.length : i; };
  for (const a of adlar) {
    if (!en || sira(a.retailer) < sira(en.retailer) ||
      (sira(a.retailer) === sira(en.retailer) && a.sku_name.localeCompare(en.sku_name, "tr") < 0)) en = a;
  }
  return en?.sku_name ?? "";
}
