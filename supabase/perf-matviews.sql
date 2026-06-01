-- Performans: weekly_summary & data_freshness'i MATERIALIZED VIEW'a çevir.
-- Normal view her istekte 356K satırda count(distinct ...) hesaplıyordu → free tier
-- statement_timeout'u (57014) aşıyordu. Matview önceden hesaplanır; okuma anlık.
-- Her veri yüklemesinden sonra refresh_summaries() çağrılır (upload route + seed).

drop view if exists weekly_summary cascade;
drop materialized view if exists weekly_summary cascade;
create materialized view weekly_summary as
select
  retailer, week_start, week_end,
  sum(sales_qty)                                           as sales_qty,
  sum(sales_value)                                         as sales_value,
  bool_or(sales_value is not null)                         as has_value,
  sum(stock_qty)                                           as stock_qty,
  count(distinct sku_name)                                 as sku_count,
  count(distinct store) filter (where store is not null)   as store_count
from fact_weekly
group by retailer, week_start, week_end;
-- concurrent refresh için benzersiz index şart
create unique index if not exists idx_ws_key on weekly_summary (retailer, week_start, week_end);
create index if not exists idx_ws_week on weekly_summary (week_start);

drop view if exists data_freshness cascade;
drop materialized view if exists data_freshness cascade;
create materialized view data_freshness as
select
  f.retailer,
  max(f.week_start)                          as last_week,
  count(distinct f.week_start)               as week_count,
  (select max(imported_at) from import_log l where l.retailer = f.retailer) as last_import
from fact_weekly f
group by f.retailer;
create unique index if not exists idx_df_retailer on data_freshness (retailer);

-- Matview'larda RLS yok; anon okuma için açık grant.
grant select on weekly_summary to anon, authenticated;
grant select on data_freshness to anon, authenticated;

-- Yenileme fonksiyonu (yazımdan sonra çağrılır). security definer → RLS/yetki bypass.
create or replace function refresh_summaries() returns void
language plpgsql security definer as $$
begin
  refresh materialized view concurrently weekly_summary;
  refresh materialized view concurrently data_freshness;
end;
$$;
grant execute on function refresh_summaries() to anon, authenticated, service_role;

-- Güvenlik ağı: ilk/ağır sorgular için API rollerinde statement_timeout'u yükselt.
alter role anon set statement_timeout = '30s';
alter role authenticated set statement_timeout = '30s';
