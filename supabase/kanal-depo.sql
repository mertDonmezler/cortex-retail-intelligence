-- KANAL DEPO STOĞU (2026-10-29) — şimdilik yalnız D&R.
-- D&R'ın "Satin Alma - Kategori" haftalık dosyasındaki Offline/Web Depo kolonları.
-- fact_weekly'ye GİRMEZ: CORTEX'in stok standardı mağaza rafıdır, depo ayrı tutulur.
-- Yönlendirme motoru D&R'a sevk önerirken aynı haftanın deposuna bakar: depoda mal
-- varsa iş "sevk et" değil "D&R deposundan mağazalara dağıtsın" olur.
-- Tablo yokken uygulama aynen çalışır (depo adımı atlanır); bu dosya bir kez
-- Supabase SQL Editor'da çalıştırılınca bir sonraki D&R yüklemesinden itibaren dolar.

create table if not exists kanal_depo (
  id            bigserial primary key,
  retailer      text not null,
  week_start    date not null,
  sku_name      text not null,
  barkod        text,
  offline_depo  numeric not null default 0,   -- mağazalara dağıtılabilir depo
  web_depo      numeric not null default 0,   -- e-ticaret deposu (mağazaya gitmez)
  source_file   text,
  created_at    timestamptz default now()
);

create index if not exists idx_kanal_depo_hafta on kanal_depo (retailer, week_start);
create index if not exists idx_kanal_depo_barkod on kanal_depo (retailer, barkod);

-- RLS: security-hardening.sql deseni — anon erişimi yok; sunucu service-role ile okur/yazar.
alter table kanal_depo enable row level security;
revoke all on kanal_depo from anon;
