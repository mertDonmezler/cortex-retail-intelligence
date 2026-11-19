-- Ürün coverage (ağ geneli, firmalar arası) — ölü/fazla stok sayfası için.
-- product_key = barkod (varsa) yoksa 'NAME:'||sku_name. Aynı barkod farklı
-- firmalarda → aynı ürün olarak birleşir (149 barkod >1 firmada). Toyzz 21-27
-- Eylül 2026'dan beri barkodlu (eski haftalar Kalem Kodu'yla geri işlendi,
-- bkz. src/lib/toyzz-barkod.ts); barkodsuz kalan kalemler alias → NAME: yoluna düşer.
-- Firma-bazlı coverage = son hafta stoğu / ortalama haftalık satış (sku_coverage ile aynı mantık).

drop materialized view if exists product_coverage cascade;
create materialized view product_coverage as
with base as (
  -- Barkod yoksa ONAYLANMIŞ alias barkodunu kullan (Toyzz vb. isim eşleşmesi);
  -- o da yoksa 'NAME:'||isim ile tek-firma kalır.
  select f.retailer,
    coalesce(nullif(f.barkod, ''), pa.barkod, 'NAME:' || f.sku_name) as product_key,
    coalesce(nullif(f.barkod, ''), pa.barkod)                        as barkod,
    f.sku_name, f.sales_qty, f.sales_value, f.stock_qty, f.price, f.week_start
  from fact_weekly f
  left join product_alias pa
    on pa.retailer = f.retailer and pa.sku_name = f.sku_name and pa.status = 'approved'
),
agg as (
  select retailer, product_key,
    max(barkod)                                          as barkod,
    (array_agg(sku_name order by length(sku_name) desc))[1] as sku_name,
    sum(sales_qty)::numeric                              as total_sales,
    count(distinct week_start)                           as weeks,
    max(week_start)                                      as last_week,
    -- BİRİM PSF — DOSYA KANITI ÖNCE, TÜRETİLMİŞ FİYAT SON ÇARE.
    --
    -- Eski hâli `coalesce(price, sales_value/sales_qty)` medyanıydı ve fact_weekly.price
    -- kolonunun BİR KISMINI enrichment'in kendisi yazıyor (src/lib/prices.ts). Yani
    -- türetilmiş bir fiyat, sonraki turda "kanıt" diye medyana geri giriyordu —
    -- prices.ts'in `fromFile` ayrımı tam da bunu engellemek için var (ölçüm oradaki
    -- notta: 155 barkodun 8'inde medyan >%2, birinde %17,8 kayıyor; 799,00 → 665,83).
    -- Bu kolon /api/routing'in eritNet, haftalikNet ve raf değeri rakamlarını besliyor,
    -- yani kayma doğrudan para kararına giriyordu. Üstelik pencere ÖMÜR BOYU.
    --
    -- Kural TS tarafıyla birebir aynı (prices.ts: PRICE_IN_FILE / fromFile / medianOf):
    --   • price NULL ise → ciro dosyanın kendi rakamı, birim fiyat kanıttır
    --   • price DOLU ve firma dosyasında fiyat kolonu taşıyorsa (Armağan, Toyzz) → kanıt
    --   • price DOLU ama firma fiyat göndermiyorsa → o değeri enrichment yazmıştır, kanıt DEĞİL
    -- Dosya kanıtı hiç yoksa türetilmiş medyana düşülür (fiyatsız bırakmak ciroyu
    -- 0'a indirirdi, ki kaymadan daha kötü bir sonuç).
    percentile_cont(0.5) within group (order by
      case
        when price is null and sales_qty > 0 then sales_value / sales_qty
        when price is not null and retailer in ('Armağan', 'Toyzz') then price
      end
    )::numeric as psf_dosya,
    percentile_cont(0.5) within group (
      order by coalesce(price, case when sales_qty > 0 then sales_value / sales_qty end)
    )::numeric as psf_tum
  from base group by retailer, product_key
),
laststock as (
  select b.retailer, b.product_key, sum(b.stock_qty)::numeric as last_stock
  from base b
  join agg a on a.retailer = b.retailer and a.product_key = b.product_key and b.week_start = a.last_week
  group by b.retailer, b.product_key
)
select a.retailer, a.product_key, a.barkod, a.sku_name, a.total_sales, a.weeks,
  case when a.weeks > 0 then a.total_sales / a.weeks else 0 end                  as avg_weekly,
  coalesce(l.last_stock, 0)                                                      as last_stock,
  case when a.weeks > 0 and a.total_sales > 0
       then coalesce(l.last_stock, 0) / (a.total_sales / a.weeks)
       else null end                                                            as coverage_weeks,
  -- Dosya kanıtı varsa o, yoksa türetilmiş medyan (prices.ts medianOf ile aynı sıra).
  coalesce(a.psf_dosya, a.psf_tum, 0)                                           as psf
from agg a left join laststock l on l.retailer = a.retailer and l.product_key = a.product_key;

create unique index if not exists idx_pcov_key on product_coverage (retailer, product_key);
create index if not exists idx_pcov_barkod on product_coverage (barkod);
grant select on product_coverage to anon, authenticated;

-- Yenileme fonksiyonu (refresh_summaries) tek yerde tanımlıdır: supabase/refresh-fix.sql.
