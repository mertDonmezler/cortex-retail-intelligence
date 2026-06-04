-- Refresh fonksiyonlarına yüksek statement_timeout (free-tier 57014 timeout'unu aşmak için)
-- + alias onayı için yalnız product_coverage'ı yenileyen hafif RPC.

create or replace function refresh_product_coverage() returns void
language plpgsql security definer as $$
begin
  set local statement_timeout = '180000';
  refresh materialized view concurrently product_coverage;
end;
$$;
grant execute on function refresh_product_coverage() to service_role;

create or replace function refresh_summaries() returns void
language plpgsql security definer as $$
begin
  set local statement_timeout = '180000';
  refresh materialized view concurrently weekly_summary;
  refresh materialized view concurrently data_freshness;
  refresh materialized view concurrently sku_coverage;
  refresh materialized view concurrently product_coverage;
end;
$$;
grant execute on function refresh_summaries() to service_role;
