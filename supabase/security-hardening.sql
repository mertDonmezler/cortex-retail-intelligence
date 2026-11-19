-- ═══════════════════════════════════════════════════════════════════════════
-- CORTEX — VERİTABANI GÜVENLİK SERTLEŞTİRME
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NE YAPAR
--   `anon` ve `authenticated` rollerinin public şemasındaki TÜM okuma/yazma
--   izinlerini kaldırır, izin veren (`using (true)`) RLS politikalarını siler,
--   matview yenileme fonksiyonlarının EXECUTE iznini alır ve gelecekte
--   oluşturulacak nesnelerin otomatik olarak açılmasını engeller.
--
-- NEDEN (ölçüm, 2026-08-12)
--   Anon anahtarla — yani internete verilebilecek bir anahtarla — şunlar
--   okunabiliyordu:
--       fact_weekly        449.690 satır
--       sku_weekly          17.225
--       store_weekly         5.125
--       consignment_lines    1.081
--       sku_coverage           755
--       product_coverage       718
--       product_alias          200
--       sku_prices             160
--       weekly_summary         107
--       import_log              82
--       access_log        ✓ KAPALI (401)  ← doğru desen zaten buradaydı
--   Yani tüm firma-bazlı satış, stok ve fiyat verisi tek anahtarın sızmasına
--   bakıyordu. Yazma ve RPC çağrıları doğru şekilde kapalıydı (401).
--   `access_log` için uygulanan `revoke all` deseni bu betikle diğer tüm
--   nesnelere yayılıyor.
--
-- ⚠ ÖN KOŞUL — SIRAYI BOZMA
--   Uygulamanın OKUMALARI eskiden anon anahtarla yapılıyordu. Bu betik
--   çalıştırılmadan önce `src/lib/supabase.ts` içindeki okuma client'ının
--   service-role anahtarına geçmiş sürümü CANLIYA ALINMIŞ olmalı.
--   (Bu değişiklik 2026-08-12 tarihinde yapıldı ve deploy edildi; yine de
--   çalıştırmadan önce panelde bir sayfa açıp veri geldiğini doğrula.)
--   Sıra yanlış olursa: SQL önce çalışırsa panel deploy'a kadar boş görünür.
--
-- NASIL ÇALIŞTIRILIR
--   Supabase → SQL Editor → bu dosyanın tamamını yapıştır → Run.
--   Betik idempotenttir: birden fazla kez çalıştırılabilir, ikinci koşu
--   hiçbir şeyi bozmaz.
--
-- KURULUM SIRASINDAKİ YERİ
--   schema.sql → sku-weekly.sql → perf-matviews.sql → coverage.sql →
--   product-coverage.sql → product-alias.sql → refresh-fix.sql →
--   access-log.sql → **security-hardening.sql (en son)**
--   En sonda olmalı: kendinden önce oluşturulan her nesnenin iznini kapatır.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1) TÜM TABLO / VIEW / MATVIEW İZİNLERİNİ ANON'DAN AL
-- ───────────────────────────────────────────────────────────────────────────
-- Nesneler tek tek yazılmıyor, katalogdan geziliyor: elle liste tutmak,
-- yeni bir matview eklendiğinde sessizce açık kalmak demekti.
do $$
declare r record;
begin
  for r in
    select c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm')   -- tablo, partition, view, matview
  loop
    execute format('revoke all on %I.%I from anon, authenticated', 'public', r.relname);
  end loop;

  -- Diziler (sequence): insert izni olmasa da nextval açıksa gereksiz yüzey.
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('revoke all on sequence %I.%I from anon, authenticated', 'public', r.relname);
  end loop;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2) İZİN VEREN RLS POLİTİKALARINI KALDIR
-- ───────────────────────────────────────────────────────────────────────────
-- `using (true)` = "herkes okuyabilir". Grant kaldırıldığı için bu politikalar
-- artık tek başına erişim vermiyor, ama kalmaları yanlış güven yaratıyor:
-- ileride biri grant'i geri verdiğinde kapı yeniden ardına kadar açılır.
-- service_role RLS'i BYPASS ettiği için uygulamanın okumaları etkilenmez.
--
-- Bilinen adlar (schema.sql / product-alias.sql):
drop policy if exists "anon read fact"   on public.fact_weekly;
drop policy if exists "anon read log"    on public.import_log;
drop policy if exists "anon read prices" on public.sku_prices;
drop policy if exists "anon read alias"  on public.product_alias;

-- Kalan/yeni eklenmiş izin veren politikalar için süpürge: yalnız koşulu
-- düpedüz `true` olanları siler, gerçek bir kısıt taşıyan politikaya dokunmaz.
do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and coalesce(qual, 'true') = 'true'
      and (roles is null or roles = '{public}' or 'anon' = any(roles) or 'authenticated' = any(roles))
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    raise notice 'kaldırılan izin veren politika: %.% → %', p.schemaname, p.tablename, p.policyname;
  end loop;
end $$;

-- RLS'in açık olduğundan emin ol (politika yok + RLS açık = service_role dışında kimse okuyamaz).
alter table public.fact_weekly   enable row level security;
alter table public.import_log    enable row level security;
alter table public.sku_prices    enable row level security;
alter table public.product_alias enable row level security;
alter table public.access_log    enable row level security;


-- ───────────────────────────────────────────────────────────────────────────
-- 3) FONKSİYON EXECUTE İZİNLERİ
-- ───────────────────────────────────────────────────────────────────────────
-- refresh_summaries() ve refresh_product_coverage() 449.690 satırlık
-- matview'leri yeniliyor (ölçüldü: 13,4 sn + 6,4 sn). Anon çağırabiliyorsa
-- bu bedava bir servis-dışı bırakma aracıdır: art arda çağır, veritabanı
-- boğulsun. Bu fonksiyonları yalnız upload yolu (service-role) çağırıyor.
-- ÖLÇÜM NOTU: bugün anon ile çağrı 401 dönüyor, yani zaten kapalı; buradaki
-- revoke bir gerileme koruması (ileride biri grant verirse geri kapanır).
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from anon, authenticated', f.sig);
  end loop;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 4) GELECEKTE OLUŞACAK NESNELER OTOMATİK AÇILMASIN
-- ───────────────────────────────────────────────────────────────────────────
-- Supabase varsayılanı yeni tablolara anon/authenticated select verebiliyor.
-- Bu satırlar olmadan, bir sonraki `create table` sertleştirmeyi sessizce
-- geri alır. NOT: default privileges nesneyi OLUŞTURAN role bağlıdır; SQL
-- Editor'da `postgres` rolüyle çalıştığın için o role yazılıyor.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- 5) DOĞRULAMA — çalıştırdıktan sonra bunları kontrol et
-- ───────────────────────────────────────────────────────────────────────────
-- (a) anon'da kalan tablo izni olmamalı → 0 satır dönmeli:
--   select table_name, privilege_type from information_schema.role_table_grants
--   where grantee in ('anon','authenticated') and table_schema='public';
--
-- (b) izin veren politika kalmamalı → 0 satır dönmeli:
--   select tablename, policyname, qual from pg_policies
--   where schemaname='public' and coalesce(qual,'true')='true';
--
-- (c) DIŞARIDAN test (terminalden, anon anahtarla — 401 beklenir):
--   curl -s -o /dev/null -w "%{http_code}\n" \
--     "$SUPABASE_URL/rest/v1/fact_weekly?select=id&limit=1" \
--     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--   Beklenen: 401. (Sertleştirmeden önce 200/206 dönüyordu.)
--
-- (d) PANELİ AÇ ve bir sayfada veri geldiğini gör. Boş geliyorsa okuma yolu
--     hâlâ anon kullanıyor → 8. bölümdeki geri alma ile aç, deploy'u kontrol et.


-- ───────────────────────────────────────────────────────────────────────────
-- 6) access_log — İNDEKS
-- ───────────────────────────────────────────────────────────────────────────
-- Giriş denemesi sayacı her POST'ta (event, ts) üzerinden okuyor. İndeks
-- access-log.sql'de zaten var; burada yalnız garanti (if not exists).
create index if not exists access_log_event_ts_idx on public.access_log (event, ts desc);
-- IP başına sayaç sorgusu için: (ip, event, ts) — tablo büyüdüğünde giriş
-- gecikmesini engeller.
create index if not exists access_log_ip_event_ts_idx on public.access_log (ip, event, ts desc);


-- ───────────────────────────────────────────────────────────────────────────
-- 7) access_log — SAKLAMA SÜRESİ (ELLE, BİLİNÇLİ OLARAK OTOMATİK DEĞİL)
-- ───────────────────────────────────────────────────────────────────────────
-- Tablo süresiz büyüyor ve artık kaba kuvvet sayacı olarak da kullanılıyor;
-- şişmesi giriş yolunu yavaşlatır. Aşağıdaki cümle DENETİM KAYDI SİLER —
-- bu yüzden otomatik bir iş (cron/trigger) kurulmadı: silmeye karar veren
-- sen olmalısın. Ne silineceğini görmek için önce SELECT'i çalıştır.
--
--   -- kaç kayıt gidecek:
--   select count(*) from public.access_log where ts < now() - interval '180 days';
--   -- silmek için (yorumu kaldır):
--   -- delete from public.access_log where ts < now() - interval '180 days';
--
-- Not: 180 gün, "geçen sezon kim ne zaman girdi" sorusunu yanıtlamaya yeter
-- ve sayaç penceresi (5-15 dakika) yanında fazlasıyla geniştir.


-- ───────────────────────────────────────────────────────────────────────────
-- 8) GERİ ALMA (ROLLBACK) — panel veri göstermezse
-- ───────────────────────────────────────────────────────────────────────────
-- Sertleştirmenin tek gerçek riski: uygulamanın okuma yolu hâlâ anon
-- anahtarla çalışıyorsa ekranlar boşalır. O durumda aşağıdakiler eski
-- (açık) duruma döner — geçici çözüm olarak kullan, sonra deploy'u düzelt.
--
--   grant select on all tables in schema public to anon, authenticated;
--   create policy "anon read fact"   on public.fact_weekly   for select using (true);
--   create policy "anon read log"    on public.import_log    for select using (true);
--   create policy "anon read prices" on public.sku_prices    for select using (true);
--   create policy "anon read alias"  on public.product_alias for select using (true);
--   alter default privileges for role postgres in schema public
--     grant select on tables to anon, authenticated;
--
-- access_log'u GERİ AÇMA — o tablo tasarımı gereği yalnız service-role'e açık.
