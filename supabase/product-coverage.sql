-- Ürün coverage (ağ geneli, firmalar arası) — ölü/fazla stok sayfası için.
-- product_key = barkod (varsa) yoksa 'NAME:'||sku_name. Aynı barkod farklı
-- firmalarda → aynı ürün olarak birleşir (149 barkod >1 firmada). Toyzz'da
-- barkod yok → NAME: anahtarıyla tek-firma kalır (eşleşemez, dürüst).
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
    -- birim PSF: fiyat kolonu varsa o, yoksa satış tutarı/adetten türet (Huppaluppo/Nezih)
    max(coalesce(price, case when sales_qty > 0 then sales_value / sales_qty end))::numeric as psf
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
  coalesce(a.psf, 0)                                                            as psf
from agg a left join laststock l on l.retailer = a.retailer and l.product_key = a.product_key;

create unique index if not exists idx_pcov_key on product_coverage (retailer, product_key);
create index if not exists idx_pcov_barkod on product_coverage (barkod);
grant select on product_coverage to anon, authenticated;

-- Yenileme fonksiyonu (refresh_summaries) tek yerde tanımlıdır: supabase/refresh-fix.sql.
