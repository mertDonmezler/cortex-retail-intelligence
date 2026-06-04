-- HIZ matview'ları (2026-06-05): ağır fact_weekly okumalarını çökertir.
-- D&R eski haftaları mağaza-bazlı (~15K satır/hafta); rankings/insights/stores bunları
-- ham çekince 4-9s sürüyordu. Bu matview'lar mağaza boyutunu önceden topluyor.
--
-- sku_weekly  : mağaza boyutu kaldırılmış SKU-hafta özeti (389K → ~11K satır).
--               rankings, stock-alerts, insights, compare buradan okur.
-- store_weekly: mağaza-hafta özeti (~4K satır). stores sayfası buradan okur.
-- Ciro BRÜT tutulur; net dönüşüm uygulamada (netRows/netFactor).

create materialized view if not exists sku_weekly as
select retailer, week_start, sku_name,
       (array_agg(barkod) filter (where barkod is not null))[1] as barkod,
       sum(sales_qty)::numeric  as sales_qty,
       sum(sales_value)::numeric as sales_value,
       sum(stock_qty)::numeric  as stock_qty
from fact_weekly
group by retailer, week_start, sku_name;
-- concurrently refresh için UNIQUE index şart
create unique index if not exists sku_weekly_pk on sku_weekly (retailer, week_start, sku_name);

create materialized view if not exists store_weekly as
select retailer, week_start, store,
       sum(sales_qty)::numeric   as sales_qty,
       sum(sales_value)::numeric as sales_value,
       sum(stock_qty)::numeric   as stock_qty,
       count(distinct sku_name)::int as sku_count
from fact_weekly
where store is not null
group by retailer, week_start, store;
create unique index if not exists store_weekly_pk on store_weekly (retailer, week_start, store);

grant select on sku_weekly   to anon, authenticated, service_role;
grant select on store_weekly to anon, authenticated, service_role;
