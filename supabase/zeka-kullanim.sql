-- CORTEX ASİSTANI KULLANIM KAYDI — kredi kontrolü, not önbelleği, geri bildirim.
-- Supabase SQL Editor'da BİR KEZ çalıştır (tekrar çalıştırmak zararsız).
--
-- Dört iş görür:
--   1) Oturum başına sınır: 10 dakikada en fazla 10 soru (lib/zeka/kota.ts).
--      Sayaç veritabanında, çünkü Vercel'de sunucu belleği istekler arasında
--      paylaşılmıyor.
--   2) Harcama görünürlüğü: her sorunun modeli, token'ı ve yaklaşık maliyeti
--      kaydedilir; asistan panelinde "bu ay ~X $" gösterilir.
--   3) Haftalık not önbelleği: aynı veriyle yazılmış not tekrar istenirse
--      yeniden ücret ödenmez, kayıttan gelir (`anahtar` = verinin imzası).
--   4) Geri bildirim: cevabın altındaki "işe yaradı / yanlış" (`puan` 1 / -1);
--      cevabın kendisi de saklanır ki yanlış bulunan cevaplar sonradan incelensin.
--
-- `oturum` çerezdeki oturum kimliğinin SHA-256 özetidir (çerezin kendisi
-- saklanmaz). Aynı PIN'le giren farklı tarayıcılar ayrı oturumdur.

create table if not exists public.zeka_kullanim (
  id             bigserial primary key,
  ts             timestamptz not null default now(),
  oturum         text not null,
  tur            text not null default 'soru',      -- soru | not
  soru           text,                               -- ilk 500 karakter
  model          text,
  durum          text not null default 'basladi',   -- basladi | tamam | kesildi | red | sinir | durduruldu | hata
  arac_sayisi    int,
  tur_sayisi     int,
  giris_token    int,
  cikis_token    int,
  onbellek_token int,
  maliyet_usd    numeric(10, 4),
  sure_ms        int
);

alter table public.zeka_kullanim add column if not exists cevap   text;      -- ilk 20.000 karakter
alter table public.zeka_kullanim add column if not exists anahtar text;      -- haftalık not: veri imzası
alter table public.zeka_kullanim add column if not exists puan    smallint;  -- 1 işe yaradı · -1 yanlış

create index if not exists zeka_kullanim_oturum_ts on public.zeka_kullanim (oturum, ts desc);
create index if not exists zeka_kullanim_ts on public.zeka_kullanim (ts desc);
create index if not exists zeka_kullanim_not on public.zeka_kullanim (anahtar, ts desc) where tur = 'not';

-- Güvenlik: access_log ile aynı desen — yalnız sunucu (service role) okur/yazar.
alter table public.zeka_kullanim enable row level security;
revoke all on public.zeka_kullanim from anon, authenticated;
revoke all on sequence public.zeka_kullanim_id_seq from anon, authenticated;

notify pgrst, 'reload schema';
