-- Mythos Retail Dashboard — Supabase şeması
-- Supabase SQL Editor'da çalıştır (proje oluşturduktan sonra).

-- Ana fact tablosu: her satır bir (perakendeci, hafta, mağaza, SKU)
create table if not exists fact_weekly (
  id           bigserial primary key,
  retailer     text not null,
  week_start   date not null,
  week_end     date not null,
  store        text,
  sku_name     text not null,
  sku_id       text,
  barkod       text,
  price        numeric,
  sales_qty    numeric not null default 0,
  sales_value  numeric,
  stock_qty    numeric not null default 0,
  source_file  text,
  created_at   timestamptz default now()
);

create index if not exists idx_fact_retailer_week on fact_weekly (retailer, week_start);
create index if not exists idx_fact_barkod        on fact_weekly (barkod);
create index if not exists idx_fact_week          on fact_weekly (week_start);

-- Import geçmişi: her yükleme bir satır
create table if not exists import_log (
  id           bigserial primary key,
  retailer     text not null,
  filename     text not null,
  week_start   date,
  rows         int,
  imported_at  timestamptz default now()
);

create index if not exists idx_import_retailer on import_log (retailer, imported_at desc);

-- Master fiyat tablosu (barkod → medyan birim fiyat). Enrichment buraya yazar.
create table if not exists sku_prices (
  barkod        text primary key,
  median_price  numeric not null,
  samples       int,
  last_seen     date,
  updated_at    timestamptz default now()
);

-- RLS: ekip içi kullanım için basit — anon okuma, service-role yazma.
-- (İstersen Supabase Auth ekleyip kullanıcı bazlı kısıtlayabilirsin.)
alter table fact_weekly enable row level security;
alter table import_log  enable row level security;
alter table sku_prices  enable row level security;

create policy "anon read fact"   on fact_weekly for select using (true);
create policy "anon read log"    on import_log  for select using (true);
create policy "anon read prices" on sku_prices  for select using (true);
-- Yazma işlemleri service_role key ile yapılır (RLS bypass eder).

-- ---------- Özet matview'ları (dashboard performansı için) ----------
-- MATERIALIZED: count(distinct ...) 350K+ satırda her istekte hesaplanırsa free
-- tier statement_timeout'unu (57014) aşar. Önceden hesaplanır; her yüklemeden
-- sonra refresh_summaries() ile yenilenir (upload route + seed çağırır).

-- Haftalık perakendeci özeti — kartlar + trend grafiği bundan beslenir
create materialized view if not exists weekly_summary as
select
  retailer,
  week_start,
  week_end,
  sum(sales_qty)                                           as sales_qty,
  sum(sales_value)                                         as sales_value,
  bool_or(sales_value is not null)                         as has_value,
  sum(stock_qty)                                           as stock_qty,
  count(distinct sku_name)                                 as sku_count,
  count(distinct store) filter (where store is not null)   as store_count
from fact_weekly
group by retailer, week_start, week_end;
create unique index if not exists idx_ws_key on weekly_summary (retailer, week_start, week_end);
create index if not exists idx_ws_week on weekly_summary (week_start);

-- Veri tazeliği — her perakendeci için son hafta + son import
create materialized view if not exists data_freshness as
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

-- SKU coverage (stok süresi) — coverage_weeks = son stok / ortalama haftalık satış.
create materialized view if not exists sku_coverage as
with agg as (
  select retailer, sku_name, sum(sales_qty)::numeric as total_sales,
    count(distinct week_start) as weeks, max(week_start) as last_week
  from fact_weekly group by retailer, sku_name
),
laststock as (
  select f.retailer, f.sku_name, sum(f.stock_qty)::numeric as last_stock
  from fact_weekly f join agg a on a.retailer = f.retailer and a.sku_name = f.sku_name and f.week_start = a.last_week
  group by f.retailer, f.sku_name
)
select a.retailer, a.sku_name, a.total_sales, a.weeks,
  case when a.weeks > 0 then a.total_sales / a.weeks else 0 end as avg_weekly,
  coalesce(l.last_stock, 0) as last_stock,
  case when a.weeks > 0 and a.total_sales > 0 then coalesce(l.last_stock, 0) / (a.total_sales / a.weeks) else null end as coverage_weeks
from agg a left join laststock l on l.retailer = a.retailer and l.sku_name = a.sku_name;
create unique index if not exists idx_skucov_key on sku_coverage (retailer, sku_name);
create index if not exists idx_skucov_retailer on sku_coverage (retailer);
grant select on sku_coverage to anon, authenticated;

-- Yenileme fonksiyonu (refresh_summaries) tek yerde tanımlıdır: supabase/refresh-fix.sql.
