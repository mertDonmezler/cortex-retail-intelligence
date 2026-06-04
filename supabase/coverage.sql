-- SKU coverage (stok süresi) — firma geneli, DB tarafında agregasyon.
-- coverage_weeks = son hafta stoğu / ortalama haftalık satış (toplam satış / satış haftası).
-- Firma geneli DR'de ~390K satır olduğundan JS'te değil burada hesaplanır; matview.

drop materialized view if exists sku_coverage cascade;
create materialized view sku_coverage as
with agg as (
  select retailer, sku_name,
    sum(sales_qty)::numeric        as total_sales,
    count(distinct week_start)     as weeks,
    max(week_start)                as last_week
  from fact_weekly
  group by retailer, sku_name
),
laststock as (
  -- SKU'nun en güncel haftasındaki stok (mağaza-bazlıysa mağazalar toplanır)
  select f.retailer, f.sku_name, sum(f.stock_qty)::numeric as last_stock
  from fact_weekly f
  join agg a on a.retailer = f.retailer and a.sku_name = f.sku_name and f.week_start = a.last_week
  group by f.retailer, f.sku_name
)
select
  a.retailer,
  a.sku_name,
  a.total_sales,
  a.weeks,
  case when a.weeks > 0 then a.total_sales / a.weeks else 0 end                 as avg_weekly,
  coalesce(l.last_stock, 0)                                                     as last_stock,
  case when a.weeks > 0 and a.total_sales > 0
       then coalesce(l.last_stock, 0) / (a.total_sales / a.weeks)
       else null end                                                           as coverage_weeks
from agg a
left join laststock l on l.retailer = a.retailer and l.sku_name = a.sku_name;

create unique index if not exists idx_skucov_key on sku_coverage (retailer, sku_name);
create index if not exists idx_skucov_retailer on sku_coverage (retailer);
grant select on sku_coverage to anon, authenticated;

-- Yenileme fonksiyonu (refresh_summaries) tek yerde tanımlıdır: supabase/refresh-fix.sql.
