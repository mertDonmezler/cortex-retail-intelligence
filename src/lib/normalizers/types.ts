// Unified veri şeması — tüm normalizer'lar bu tipi döndürür.
// Python tarafındaki UNIFIED_COLUMNS'un TypeScript karşılığı.

export type Retailer = "Nezih" | "Huppaluppo" | "Armağan" | "Toyzz" | "DR";

export const RETAILERS: Retailer[] = ["Nezih", "Huppaluppo", "Armağan", "Toyzz", "DR"];

export interface UnifiedRow {
  retailer: Retailer;
  week_start: string;   // ISO date "YYYY-MM-DD"
  week_end: string;     // ISO date
  store: string | null;
  sku_name: string;
  sku_id: string | null;
  barkod: string | null;
  price: number | null;
  sales_qty: number;
  sales_value: number | null;
  stock_qty: number;
  source_file: string;
}

// ── Sat-Öde (konsinye) fatura kalemi ──
// CORTEX'in haftalık sell-through verisinden AYRI bir veri kümesi: bizim
// perakendeciye kestiğimiz toptan faturanın kalem detayı (= "sevk" tarafı).
// Her satır bir fatura kalemi: hangi cari, hangi ürün, kaç adet, ne tutar,
// hangi tarihte faturalandı ve vadesi ne zaman. Tutarlar faturadaki HAM
// değerlerdir (net = KDV hariç, total = KDV dahil); marj/net-kazanç dönüşümü
// UYGULANMAZ — bu zaten bizim toptan satış faturamızdır.
export interface ConsignmentLine {
  retailer: Retailer;          // Cari adından eşlenen kanal (Toyzz/DR/Armağan/Huppaluppo/Nezih)
  cari_adi: string;            // ham cari adı (fatura üzerindeki ünvan)
  cari_kodu: string | null;
  invoice_no: string;          // Fatura no
  belge_no: string | null;     // Belge no
  invoice_date: string;        // Tarih — ISO "YYYY-MM-DD"
  due_date: string | null;     // Vade — ISO "YYYY-MM-DD"
  line_no: number | null;      // Satır sayısı
  stock_code: string | null;   // Stok kodu
  product_name: string;        // Stok ismi
  ana_grup: string | null;     // Ana grup (ör. Beşiktaş)
  alt_grup: string | null;     // Alt grup (ör. Pre-Season)
  qty: number;                 // Miktar
  unit_price_net: number | null; // Net Br.fiy (KDV hariç birim)
  net_amount: number;          // Net tutar (KDV hariç)
  vat: number;                 // Toplam vergi (KDV)
  total: number;               // Toplam (KDV dahil) = tahsil edilecek tutar
  source_file: string;
}
