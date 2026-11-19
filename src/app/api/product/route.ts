import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { pivotProduct } from "@/lib/compute";
import { toNetFacts, SKU_COLS } from "@/lib/rows";
import { sorguParcala, gorunenAd } from "@/lib/urun-arama";

export const runtime = "nodejs";
export const revalidate = 0;
// fetchAllRows ile sayfalı okuma yapıyor; Vercel'in 10 sn varsayılanı yetmeyebilir.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const barkod = searchParams.get("barkod");
  try {
    if (barkod) {
      const SEL = SKU_COLS;
      // Sıra tek başına sku_name ile KARARSIZ olurdu (aynı isim birçok firma/haftada
      // tekrar eder → sayfa sınırında satır çift gelir/kaybolur). Benzersiz anahtarı
      // kapsayacak şekilde (retailer, week_start, sku_name) sıralanıyor.
      let rows = await fetchAllRows<any>(
        (from, to) =>
          supabase.from("sku_weekly").select(SEL).eq("barkod", barkod)
            .order("retailer").order("week_start").order("sku_name").range(from, to),
        { label: "product sku_weekly" }
      );
      // Onaylı alias'la bu barkoda bağlı barkodsuz kalemler (ör. Toyzz) de dahil.
      // N+1 KALDIRILDI: eskiden her alias için ayrı bir sıralı sorgu atılıyordu.
      // Artık tek `.in()` sorgusu; kesişimden gelen fazla satırlar (retailer X'in
      // sku_name'i Y firmasında da varsa) JS'te tam çift kümesine göre süzülür.
      const { data: al } = await supabase.from("product_alias")
        .select("retailer, sku_name").eq("barkod", barkod).eq("status", "approved");
      const pairs = new Set((al ?? []).map((a) => `${a.retailer}|${a.sku_name}`));
      if (pairs.size) {
        const extra = await fetchAllRows<any>(
          (from, to) =>
            supabase.from("sku_weekly").select(SEL)
              .in("retailer", [...new Set((al ?? []).map((a) => a.retailer))])
              .in("sku_name", [...new Set((al ?? []).map((a) => a.sku_name))])
              .is("barkod", null)
              // Sıra benzersiz anahtarı kapsasın (retailer, week_start, sku_name).
              .order("retailer").order("week_start").order("sku_name").range(from, to),
          { label: "product alias sku_weekly" }
        );
        rows = rows.concat(extra.filter((r) => pairs.has(`${r.retailer}|${r.sku_name}`)));
      }
      const pivot = pivotProduct(toNetFacts(rows));
      return NextResponse.json({ barkod, ...pivot });
    }
    if (q && q.trim().length >= 2) {
      // ARAMA HAFTALIK TABLODA YAPILMAZ.
      // sku_weekly'de her urun HER HAFTA icin bir satir tasiyor (urun basina ~23
      // satir). `.limit(500)` bu yuzden ~20 URUN demekti ve `.order()` de
      // olmadigi icin hangi 20 urunun geldigi belirsizdi: eslesenlerin buyuk
      // kismi sessizce listeye hic girmiyordu. product_coverage satir basina tek
      // (firma, urun) tasiyor -> ayni limit ~500 urun demek.
      //
      // BARKOD VE ÇOKLU ARAMA (bkz. lib/urun-arama.ts). Sorgu virgülle (ya da
      // boşlukla ayrılmış barkod listesi olarak) parçalara ayrılır; tam barkod,
      // barkodun bir kısmı ve ürün adı parçaları birlikte aranır. Böylece
      // "8685185015616, 8685185015623" iki ürünü birden listeler. Virgülsüz tek
      // ad sorgusu aynı ürünleri bulur; sıralama artık GÖRÜNEN ada göre ve sınır
      // 30 değil 100 (liste kaydırılabilir).
      const { barkodlar, adlar, atlanan, gecersiz } = sorguParcala(q);
      type Grup = { barkod: string; names: { retailer: string; sku_name: string }[]; retailers: Set<string>; eslesen?: string };
      const seen = new Map<string, Grup>();
      const tamParca = barkodlar.filter((b) => b.length >= 8);
      const adEkle = (e: Grup, r: any) => {
        if (!e.names.some((n) => n.retailer === r.retailer && n.sku_name === r.sku_name)) e.names.push({ retailer: r.retailer, sku_name: r.sku_name });
        e.retailers.add(r.retailer);
      };
      const ekle = (rows: any[] | null) => {
        for (const r of rows ?? []) {
          if (!r.barkod) continue;
          let e = seen.get(r.barkod);
          // Öncelik yalnız TAM barkod parçasına: kısa rakam ("1000", "2026") yıl ya
          // da adet de olabilir, ad eşleşmelerinin önüne geçmesin.
          if (!e) { e = { barkod: r.barkod, names: [], retailers: new Set(), eslesen: tamParca.find((b) => r.barkod.includes(b)) }; seen.set(r.barkod, e); }
          adEkle(e, r);
        }
      };

      // Barkod parçaları: yalnız rakam oldukları doğrulandı → .or() filtresine
      // güvenle girer. İçeren arama (%x%) hem tam hem kısmi barkodu bulur.
      if (barkodlar.length) {
        const { data, error } = await supabase
          .from("product_coverage").select("barkod, sku_name, retailer")
          .or(barkodlar.map((b) => `barkod.ilike.%${b}%`).join(","))
          .order("barkod").order("retailer").limit(1000);
        if (error) throw error;
        ekle(data);
      }
      // Ad parçaları: her biri kendi sorgusu (ad serbest metin; .or() dizgesine
      // konursa virgül/parantez sözdizimini bozar). En çok 5 parça.
      for (const ad of adlar.slice(0, 5)) {
        const { data, error } = await supabase
          .from("product_coverage").select("barkod, sku_name, retailer")
          .ilike("sku_name", `%${ad}%`).not("barkod", "is", null)
          .order("sku_name").limit(500);
        if (error) throw error;
        ekle(data);
      }

      // TAMAMLAMA. Ad araması yalnız adı eşleşen satırları getirir: D&R aynı ürüne
      // "Mythos Gs Pre-Season" dediği için "Galatasaray" aramasında ürün yalnız
      // Toyzz'da görünüyordu. Bulunan BÜTÜN barkodların bütün firmalardaki
      // kayıtları 200'lük parçalarla eklenir → firma rozetleri eksiksiz, görünen
      // ad (sıralama anahtarı) doğru seçilir.
      const bulunan = [...seen.keys()];
      for (let k = 0; k < bulunan.length; k += 200) {
        const { data, error } = await supabase
          .from("product_coverage").select("barkod, sku_name, retailer")
          .in("barkod", bulunan.slice(k, k + 200)).order("barkod").order("retailer");
        if (error) throw error;
        for (const r of data ?? []) { const e = seen.get(r.barkod); if (e) adEkle(e, r); }
      }

      // TAM barkodla bulunanlar YAZILAN SIRAYLA önde (liste taramasında okunan
      // sıra korunur); geri kalanı görünen ada göre (gizli Toyzz kod-adının
      // alfabesi liste sırasını karıştırmasın).
      const sirali = [...seen.values()].sort((a, b) => {
        const ia = a.eslesen ? tamParca.indexOf(a.eslesen) : Infinity;
        const ib = b.eslesen ? tamParca.indexOf(b.eslesen) : Infinity;
        if (ia !== ib) return ia - ib;
        return gorunenAd(a.names).localeCompare(gorunenAd(b.names), "tr");
      });
      const results = sirali.slice(0, 100).map((e) => ({
        barkod: e.barkod, name: gorunenAd(e.names), retailers: [...e.retailers],
      }));
      // Hiçbir ürüne denk gelmeyen TAM barkodlar + okunamayan rakam dizileri —
      // çoklu taramada hangi barkodun sistemde olmadığı açıkça görünsün. Kısa
      // rakam parçası adla da arandığı için "bulunamadı" sayılmaz.
      const bulunamayan = [...tamParca.filter((b) => ![...seen.keys()].some((bk) => bk.includes(b))), ...gecersiz];
      return NextResponse.json({
        results, barkodlar, bulunamayan, atlanan,
        toplam: sirali.length, kesildi: sirali.length > results.length,
      });
    }
    return NextResponse.json({ results: [] });
  } catch (e: any) {
    console.error("product route hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
