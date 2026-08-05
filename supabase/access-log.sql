-- Erişim kaydı (giriş logu). Amaç: siteye kaç kez girildiği, ne zaman, hangi
-- cihaz/IP'den — ve başarısız PIN denemeleri (kaba kuvvet / sızmış PIN sinyali).
--
-- NOT (kimlik): şu an tek ortak PIN kullanıldığı için "kim girdi" bilinemez;
-- user_label kolonu bilinçli olarak ŞİMDİDEN eklendi. Kişi başına PIN'e geçilirse
-- yalnız bu kolon dolmaya başlar — tablo/şema değişikliği gerekmez.
create table if not exists access_log (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  event       text        not null check (event in ('login_ok', 'login_fail', 'logout')),
  user_label  text,                 -- ileride kişi bazlı kimlik için (şimdilik null)
  ip          text,
  user_agent  text
);

-- Sorgular hep "son N kayıt" / "son 30 gün" şeklinde → ts azalan indeks.
create index if not exists access_log_ts_idx on access_log (ts desc);
create index if not exists access_log_event_ts_idx on access_log (event, ts desc);

-- Güvenlik: bu tablo denetim verisidir; tarayıcıya inen anon anahtarla OKUNAMAZ.
-- Yazma ve okuma yalnızca sunucu tarafındaki service-role ile yapılır (RLS bypass).
alter table access_log enable row level security;
revoke all on access_log from anon;
revoke all on access_log from authenticated;
revoke all on sequence access_log_id_seq from anon;
revoke all on sequence access_log_id_seq from authenticated;
