import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Env değişkenini güvenli oku — eksikse anlaşılır hata ver (sessiz undefined yerine).
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} tanımlı değil. .env.local (local) veya Vercel → Environment Variables (canlı) kontrol et.`
    );
  }
  return v;
}

// ── Okuma client'ı ──
// Lazy singleton: client ilk gerçek kullanımda kurulur. Böylece `next build`
// page-data toplarken (env değişkenleri henüz yokken) modülün sadece import
// edilmesi "supabaseUrl is required" ile patlamaz. Çağrı yerleri değişmez:
// `supabase.from(...)` aynen çalışır, client arkada runtime'da oluşturulur.
//
// NEDEN ANON DEĞİL DE SERVICE-ROLE (2026-08 değişikliği):
// Okumalar eskiden NEXT_PUBLIC_SUPABASE_ANON_KEY ile yapılıyordu. Bu anahtarın
// tarayıcıya inmediği doğrulandı (hiçbir "use client" dosyası bu modülü veya o
// env değişkenini import etmiyor), AMA veritabanı tarafında RLS politikaları
// `using (true)` idi ve anon'a SELECT verilmişti — ölçüldü: anon anahtarla
// fact_weekly dahil her şey okunabiliyordu (449.690 + 17.225 + 5.125 … satır).
// Yani anahtar herhangi bir yolla sızsa (log, ekran görüntüsü, ileride
// yanlışlıkla bir client bileşenine taşınan bir import) tüm ticari veri
// internete açılırdı. Okuma yolu service-role'e alınınca anon'u veritabanında
// tamamen kapatabiliyoruz (bkz. supabase/security-hardening.sql).
//
// İki ek güvence:
//  • Bu modül yalnız sunucuda çalışan route'lardan import ediliyor ve tüm
//    route'lar PIN kapısının arkasında (src/middleware.ts).
//  • SUPABASE_SERVICE_ROLE_KEY `NEXT_PUBLIC_` ÖNEKLİ DEĞİL. Next.js yalnız
//    NEXT_PUBLIC_* değişkenlerini istemci paketine gömer; bu yüzden modül
//    kazara bir client bileşenine import edilirse anahtar sızmaz, değer
//    undefined olur ve requireEnv anlaşılır bir hatayla patlar. Eski durumda
//    aynı kaza sessizce çalışan ama anahtarı yayınlayan bir sayfa üretiyordu.
let _read: SupabaseClient | null = null;
function readClient(): SupabaseClient {
  if (!_read) {
    _read = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );
  }
  return _read;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = readClient();
    const value = Reflect.get(client as object, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

// ── Sayfalı tam çekim ──
// PostgREST (Supabase) tek istekte varsayılan ~1000 satır döndürür ve fazlasını
// SESSİZCE kırpar. fact_weekly gibi büyük tablolardan tam küme gerektiren
// sorgularda toplamlar/sıralamalar yanlış çıkmasın diye 1000'erlik sayfalarla
// hepsini çeker. `make`, her sayfa için range uygulanmış bir sorgu döndürmeli.
//
// KARARLI ORDER ŞART. Sorgunun deterministik bir sıralaması olmalı; sıra
// benzersiz anahtarı KAPSAMALI (ör. fact_weekly → .order("id"), product_alias →
// .order("retailer").order("sku_name")). Eşitlik içeren tek kolonla sıralamak
// yetmez: Postgres iki sayfa arasında eşit satırları farklı sırada döndürebilir,
// o zaman bazı satırlar İKİ KEZ gelir, bazıları HİÇ gelmez. Bu hata sessizdir —
// istek 200 döner, yalnız toplamlar sapar. Yeni çağrı eklerken sırayı buna göre ver.
//
// Güvenlik sınırları. Amaç kotayı kısmak değil; kararsız sıra yüzünden her sayfanın
// TAM dolu dönmesi (yani döngünün hiç bitmemesi) hâlinde platform timeout'unda
// teşhissiz ölmek yerine erken ve gürültülü uyarmak.
//  • WARN_PAGES: sorgu beklenenden büyük → daraltma sinyali. İstek bütçesi içinde
//    kalıyor, yani log'a gerçekten düşüyor. fact_weekly bugün 449.690 satır
//    (450 sayfa) — tam tablo taraması yapan çağrı yok, filtreli okumalar 40
//    sayfanın altında, o yüzden 100 gerçek bir anomali eşiği.
//  • MAX_PAGES: sert durdurma. 1000 sayfa = 1.000.000 satır ≈ mevcut verinin 2,2
//    katı; meşru bir okumayı kesmez ama sonsuz döngüyü keser.
const WARN_PAGES = 100;
const MAX_PAGES = 1000;
// Paralel modda aynı anda uçan sayfa sayısı. Hepsini tek Promise.all'a vermek
// büyük sonuç kümelerinde yüzlerce eşzamanlı isteğe dönüşür (bağlantı havuzu +
// Supabase rate limit riski). 8'lik dalgalar sıralı moda göre hâlâ 8 kat hızlı
// ama DB'yi dövmez; tipik okuma (5-6 sayfa) tek dalgada biter.
const PARALLEL_BATCH = 8;

export type FetchAllOptions = {
  pageSize?: number;
  // Paralel mod. Verilirse önce satır sayısı sorulur, sonra TÜM sayfalar
  // Promise.all ile aynı anda çekilir — 18 sayfa = 18 sıralı round-trip yerine
  // 1 count + 1 tur. Sıralı mod her sayfayı öncekinin dönüşünü bekleyerek
  // çektiği için gecikme sayfa sayısıyla doğrusal artıyordu.
  // Yalnız OKUMA yollarında kullan: count ile çekim arasına yazma girerse sayfa
  // sınırları kayar (kuyruk taraması aşağıda telafi eder, ama garanti tam değil).
  count?: () => PromiseLike<{ count: number | null; error: { message: string } | null }>;
  // Teşhis etiketi — üst sınıra dayanılırsa log'da hangi sorgu olduğu görünsün.
  label?: string;
};

export async function fetchAllRows<T = any>(
  make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  // Geriye uyum: eski çağrılar 2. argümanı düz sayı (pageSize) olarak veriyordu.
  opts: number | FetchAllOptions = {}
): Promise<T[]> {
  const o: FetchAllOptions = typeof opts === "number" ? { pageSize: opts } : opts;
  const pageSize = o.pageSize ?? 1000;
  const label = o.label ?? "fetchAllRows";

  const out: T[] = [];
  let from = 0;
  let pagesUsed = 0;

  if (o.count) {
    const { count, error } = await o.count();
    if (error) throw new Error(error.message);
    if (!count) return out;
    const pages = Math.min(Math.ceil(count / pageSize), MAX_PAGES);
    // Dalga dalga paralel; her dalga içinde indeks sırasıyla map'lendiği ve
    // dalgalar sırayla eklendiği için sonuç sırası deterministik kalır.
    for (let p = 0; p < pages; p += PARALLEL_BATCH) {
      const wave = Math.min(PARALLEL_BATCH, pages - p);
      const chunks = await Promise.all(
        Array.from({ length: wave }, (_, i) => {
          const start = (p + i) * pageSize;
          return make(start, start + pageSize - 1);
        })
      );
      for (const c of chunks) {
        if (c.error) throw new Error(c.error.message);
        if (c.data) out.push(...c.data);
      }
    }
    pagesUsed = pages;
    from = pages * pageSize;
    // Bir sayfa eksik döndüyse veri bitmiştir. Tam dolduysa count'tan sonra satır
    // eklenmiş olabilir → aşağıdaki sıralı döngü kuyruğu tamamlar.
    if (out.length < from) return out;
  }

  for (;; from += pageSize) {
    if (pagesUsed >= MAX_PAGES) {
      console.error(
        `${label}: ${MAX_PAGES} sayfa / ${out.length} satır sert sınırına dayandı — sonuç ` +
        `KIRPILMIŞ olabilir. Sorguyu daralt (hafta/firma filtresi) ya da sıralamanın ` +
        `benzersiz anahtarı kapsadığını doğrula (kararsız sıra döngüyü bitirmez).`
      );
      break;
    }
    if (pagesUsed === WARN_PAGES) {
      console.warn(
        `${label}: ${WARN_PAGES} sayfayı (${out.length} satır) geçti. Sıralı sayfalama ` +
        `burada gecikmeyi domine eder; sorguyu daraltmayı ya da count'lu paralel modu düşün.`
      );
    }
    const { data, error } = await make(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    pagesUsed++;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
  }
  return out;
}

// ── Sunucu / yazma (service role — RLS bypass) ──
// Sadece API route'larında çağrılır. Service key tarayıcıya asla sızmaz.
let _admin: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );
  }
  return _admin;
}
