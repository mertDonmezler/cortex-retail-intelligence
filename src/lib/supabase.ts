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

// ── Anon client (okuma) ──
// Lazy singleton: client ilk gerçek kullanımda kurulur. Böylece `next build`
// page-data toplarken (env değişkenleri henüz yokken) modülün sadece import
// edilmesi "supabaseUrl is required" ile patlamaz. Çağrı yerleri değişmez:
// `supabase.from(...)` aynen çalışır, client arkada runtime'da oluşturulur.
let _anon: SupabaseClient | null = null;
function anonClient(): SupabaseClient {
  if (!_anon) {
    _anon = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    );
  }
  return _anon;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = anonClient();
    const value = Reflect.get(client as object, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

// ── Sayfalı tam çekim ──
// PostgREST (Supabase) tek istekte varsayılan ~1000 satır döndürür ve fazlasını
// SESSİZCE kırpar. fact_weekly gibi büyük tablolardan tam küme gerektiren
// sorgularda toplamlar/sıralamalar yanlış çıkmasın diye 1000'erlik sayfalarla
// hepsini çeker. `make`, her sayfa için range uygulanmış bir sorgu döndürmeli;
// sorgunun KARARLI bir order'ı olmalı (ör. .order("id")), yoksa sayfalar çakışır.
export async function fetchAllRows<T = any>(
  make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await make(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
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
