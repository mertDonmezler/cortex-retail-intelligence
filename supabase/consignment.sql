-- Sat-Öde (konsinye) fatura kalemleri — CORTEX sell-through'undan AYRI veri kümesi.
-- Bizim perakendeciye kestiğimiz toptan faturaların kalem detayı (= "sevk" tarafı).
-- Küçük tablo (~birkaç bin satır); matview gerekmez, panel ham satırdan hesaplar.

create table if not exists consignment_lines (
  id             bigserial primary key,
  retailer       text not null,          -- Cari'den eşlenen kanal (Toyzz/DR/Armağan/Huppaluppo)
  cari_adi       text,                   -- ham cari ünvanı
  cari_kodu      text,
  invoice_no     text not null,          -- Fatura no
  belge_no       text,
  invoice_date   date not null,          -- Tarih
  due_date       date,                   -- Vade
  line_no        int,
  stock_code     text,
  product_name   text,
  ana_grup       text,                   -- ör. Beşiktaş
  alt_grup       text,                   -- ör. Pre-Season
  qty            numeric not null default 0,   -- Miktar
  unit_price_net numeric,                       -- Net Br.fiy (KDV hariç birim)
  net_amount     numeric not null default 0,    -- Net tutar (KDV hariç)
  vat            numeric not null default 0,     -- Toplam vergi (KDV)
  total          numeric not null default 0,     -- Toplam (KDV dahil) = tahsil edilecek
  source_file    text,
  created_at     timestamptz default now()
);

create index if not exists idx_consign_retailer on consignment_lines (retailer);
create index if not exists idx_consign_due       on consignment_lines (due_date);
create index if not exists idx_consign_invoice   on consignment_lines (retailer, invoice_no);
create index if not exists idx_consign_invdate   on consignment_lines (invoice_date);

-- RLS: diğer tablolarla aynı desen — anon okuma, yazma yalnız service-role.
alter table consignment_lines enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'consignment_lines' and policyname = 'anon read consign') then
    create policy "anon read consign" on consignment_lines for select using (true);
  end if;
end $$;
