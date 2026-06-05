-- Ürün takma-ad eşlemesi: barkodsuz kalemleri (özellikle Toyzz) kanonik bir
-- barkoda bağlar. status='approved' olanlar ürün-kimliği resolver'ında kullanılır
-- (suggested/rejected birleşmeye ETKİ ETMEZ). Kaynak: auto (isim eşleştirme),
-- master (stok↔EAN dosyası — geldiğinde authoritative), manual.
create table if not exists product_alias (
  id          bigserial primary key,
  retailer    text not null,
  sku_name    text not null,
  barkod      text not null,        -- eşleştiği kanonik barkod
  match_name  text,                 -- eşleşen barkodlu ürünün adı (gösterim/doğrulama)
  confidence  numeric,              -- overlap skoru (auto için)
  status      text not null default 'suggested',  -- suggested | approved | rejected
  source      text not null default 'auto',        -- auto | master | manual
  candidates  jsonb,                -- auto-öneri için sıralı aday EAN listesi [{barkod,name,score,src}] (/eslesme seçimi)
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (retailer, sku_name)
);
create index if not exists idx_alias_status on product_alias (status);
create index if not exists idx_alias_lookup on product_alias (retailer, sku_name);

alter table product_alias enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='product_alias' and policyname='anon read alias') then
    create policy "anon read alias" on product_alias for select using (true);
  end if;
end $$;
