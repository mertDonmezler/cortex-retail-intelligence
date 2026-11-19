-- FATURA FİYATI (2026-10-29) — şimdilik yalnız D&R (Turkuvaz).
-- Bizim kanala kestiğimiz toptan faturanın kalemleri; CORTEX D&R'da TL'yi buradan
-- alır (lib/fatura-fiyat.ts):
--   • yükleme: fiyatsız gelen D&R haftası, haftanın son gününe kadar kesilmiş son
--     faturanın net fiyatıyla doldurulur (lib/prices.ts, 0. kaynak),
--   • yönlendirme: D&R kaleminin TL etkisi son faturanın net fiyatıyla hesaplanır.
-- consignment_lines'tan (Sat-Öde paneli) AYRI: o tablo barkod taşımıyor ve panelin
-- alacak hesabını besliyor; burada yalnız fiyat kanıtı tutulur.
-- Tablo yokken uygulama aynen çalışır (medyan fiyata düşer); bu dosya bir kez
-- Supabase SQL Editor'da çalıştırılır.

create table if not exists fatura_fiyat (
  id          bigserial primary key,
  retailer    text not null,
  fatura_no   text not null,
  satir_no    int  not null,
  tarih       date not null,
  barkod      text,              -- teneke varyantı "-2" ekiyle gelebilir; okurken ayıklanır
  stok_kodu   text,
  urun_adi    text,
  miktar      numeric not null default 0,
  net_fiyat   numeric not null,  -- KDV hariç net birim fiyat
  iade        boolean not null default false,
  source_file text,
  created_at  timestamptz default now(),
  unique (retailer, fatura_no, satir_no)
);

create index if not exists idx_fatura_fiyat_barkod on fatura_fiyat (retailer, barkod, tarih);

-- RLS: kanal_depo deseni — anon erişimi yok; sunucu service-role ile okur/yazar.
alter table fatura_fiyat enable row level security;
revoke all on fatura_fiyat from anon;
