-- GEÇEN YIL ARŞİVİ — fact_weekly ile AYNI kolonlar, AYRI tablo.
-- Supabase SQL Editor'da BİR KEZ çalıştır.
--
-- NEDEN AYRI TABLO: canlı hesapların bir kısmı fact_weekly'nin TÜM geçmişine
-- bakıyor — product_coverage / sku_coverage haftalık ortalamayı tüm haftalar
-- üzerinden alıyor (/stok'taki az stok / fazla stok sınıfları), veri sağlığı
-- seri boşluklarını "eksik hafta" sayıyor, aylık özet her ayı basıyor. Geçen
-- yılın haftaları oraya girerse (arada Ekim–Kasım 2025 boşluğuyla) bugünkü
-- sınıflandırmalar sessizce değişir. Arşiv yalnız "geçen yılla karşılaştırma"
-- ekranlarına girer; canlı hiçbir hesap bu tabloyu okumaz.
--
-- Satırlar ürün × hafta düzeyinde tutulur (mağaza kırılımı toplanır): D&R
-- 30 Mart 2026'dan beri mağaza göndermediği için mağaza bazlı yıl kıyası zaten
-- mümkün değil; 2025 D&R dosyaları mağaza bazında ~16-40 bin satır/hafta.

create table if not exists public.fact_weekly_arsiv (
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

create index if not exists idx_arsiv_retailer_week on public.fact_weekly_arsiv (retailer, week_start);
create index if not exists idx_arsiv_barkod        on public.fact_weekly_arsiv (barkod);

-- Güvenlik: fact_weekly ile aynı kural — yalnız sunucu (service role) okur/yazar.
alter table public.fact_weekly_arsiv enable row level security;
revoke all on public.fact_weekly_arsiv from anon, authenticated;
revoke all on sequence public.fact_weekly_arsiv_id_seq from anon, authenticated;

-- PostgREST şema önbelleğini yenile: tablo API'de hemen görünsün.
notify pgrst, 'reload schema';
