import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 6 haneli PIN sunucuda doğrulanır; doğruysa httpOnly oturum çerezi yazılır.
// Anahtarlar yalnızca ortam değişkenlerinden gelir (repoda gizli değer tutulmaz).
//
// ÖNEMLİ (değişen mimari): çerez artık CORTEX_SESSION'ın kendisi DEĞİL. Eskiden
// çerez değeri doğrudan bu sırdı; herkeste aynıydı, 30 gün geçerliydi, iptal
// edilemiyordu ve çalınan çerezle giriş /api/auth'a uğramadığı için access_log'da
// hiç görünmüyordu. Artık CORTEX_SESSION bir İMZA ANAHTARI: çerez `iat.nonce.hmac`
// biçiminde imzalı ve süreli bir token. Anahtar değiştirilince üretilmiş tüm
// token'lar tek hamlede geçersizleşir (oturum iptali imkânı).
const PIN = process.env.SITE_PIN || "";
const SESSION = process.env.CORTEX_SESSION || "";
const COOKIE = "cortex_auth";

// Oturum ömrü 7 gün (eskiden 30). Çalınan bir çerezin işe yaradığı pencereyi
// kısaltmak için düşürüldü; bedeli ekibin haftada bir kez PIN girmesi.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Kaba kuvvet frenleri ──
// 6 hane = 10^6 kombinasyon. Tek başına istek başına 500 ms gecikme FREN DEĞİL:
// Vercel serverless çağrıları paralel çalıştığı için onlarca eşzamanlı istekle
// tüm uzay saatler içinde taranabilir. Bu yüzden kalıcı (istekler arası yaşayan)
// bir sayaç gerekiyor. Vercel KV/Upstash yok → mevcut access_log tablosunu sayaç
// olarak kullanıyoruz: son N dakikadaki 'login_fail' kayıtları IP başına ve
// GLOBAL olarak sayılır, eşik aşılırsa PIN hiç kontrol edilmeden 429 döner.
const IP_WINDOW_MS = 5 * 60_000; // aynı IP: 5 dakikalık pencere
const IP_MAX_FAIL = 5; // pencerede bu kadar hatadan sonra kilit
const GLOBAL_WINDOW_MS = 15 * 60_000; // tüm sistem: 15 dakikalık pencere
const GLOBAL_MAX_FAIL = 30; // 30 hatadan sonra geçici tam kilit
const GLOBAL_MIN_IPS = 5; // ...ama yalnız hata DAĞITILMIŞSA (aşağıdaki nota bak)
const GLOBAL_SAMPLE = 200; // IP sayımı + boşalma hesabı için okunacak en yeni kayıt
const MEM_KEY_LIMIT = 1000; // süreç-içi sözlüğün üst sınırı (bellek koruması)

// KİLİT SÜRESİ SAYILMIYOR, ÖLÇÜLÜYOR. İlk sürümde sabit bir merdiven vardı
// (5-7 hata → 60 sn, 8-14 → 300 sn, 15+ → 900 sn) ve `Retry-After` bu değerden
// yazılıyordu. Canlıda test edince yalan söylediği görüldü: kapı aslında
// "son 5 dakikada 5'ten az hata" koşuluna bakıyor, dolayısıyla 60 saniye sonra
// tekrar deneyen kullanıcı yine 429 alıyordu (ölçüldü: 5. denemede kilit, 60 sn
// sonra doğru PIN hâlâ reddedildi). 900 sn'lik uç basamak ise penceresi 5 dakika
// olan bir sayaçla hiç uygulanamıyordu.
// Doğru cevap: kilit, sayacın eşiğin ALTINA DÜŞECEĞİ ana kadar sürer. Hatalar
// zaman damgalarıyla okunup o an hesaplanıyor — böylece `Retry-After` tutulabilir
// bir söz oluyor. Yan fayda: yanlış PIN girip bekleyen ekip üyesi gerçek süreyi
// görüyor, "1 dakika dedi 5 dakika bekletti" durumu ortadan kalkıyor.
// Fren gücü: pencere başına en fazla IP_MAX_FAIL deneme ⇒ saatte ~60 deneme
// ⇒ 10^6 kombinasyon için ~1.900 yıl. Merdivene ihtiyaç yok.
function drainSeconds(tsDesc: number[], max: number, windowMs: number): number {
  if (tsDesc.length < max) return 0;
  // tsDesc yeniden eskiye sıralı. Eşiğin altına düşmek için (max)'inci en yeni
  // kaydın pencereden çıkması gerekir: o çıkınca geride max-1 kayıt kalır.
  const pivot = tsDesc[max - 1];
  return Math.max(1, Math.ceil((pivot + windowMs - Date.now()) / 1000));
}

// NEDEN "dağıtılmışsa": tam kilit ekibi de dışarıda bırakır. Tek bir tarayıcı
// bot 30 hatalı POST atarak bütün ekibi kapıda bekletebilseydi, kilidin kendisi
// ucuz bir servis-dışı bırakma aracına dönüşürdü. Tek kaynaktan gelen saldırı
// ZATEN IP başına artan kilitle kesiliyor; global kilit yalnız dağıtık saldırı
// (bot ağı, IP döndürme) için gerekiyor — o yüzden en az GLOBAL_MIN_IPS farklı
// IP koşulu var.

// ── Yardımcılar ──

function clientIp(req: NextRequest): string | null {
  const h = req.headers;
  return (
    (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "").split(",")[0].trim() || null
  );
}

// Sabit-zamanlı PIN karşılaştırması: uzunluk farkında hemen false dön (timingSafeEqual
// eşit uzunluk ister), eşit uzunlukta ise zamanlama sızıntısı olmadan karşılaştır.
function pinMatches(got: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(PIN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Oturum token'ı (HMAC imzalı, süreli) ──
// Biçim: `<iat>.<nonce>.<hmac>` — hmac = HMAC-SHA256(CORTEX_SESSION, "iat.nonce").
// nonce base64url olduğu için içinde nokta yok; ayrıştırma tek anlamlı.
// Aynı doğrulama middleware'de de var (orası Edge runtime olduğu için node:crypto
// yerine Web Crypto kullanıyor). Ortak dosyaya çıkarılamadı: iki farklı runtime.
function sign(body: string): string {
  return createHmac("sha256", SESSION).update(body).digest("base64url");
}

function newToken(): string {
  const body = `${Date.now()}.${randomBytes(12).toString("base64url")}`;
  return `${body}.${sign(body)}`;
}

// Token doğrulama (yalnız logout'ta kullanılır — asıl kapı middleware'de).
function tokenValid(token: string): boolean {
  if (!SESSION || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [iatStr, nonce, mac] = parts;
  if (!/^\d{10,15}$/.test(iatStr)) return false;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return false;
  const age = Date.now() - Number(iatStr);
  if (age > SESSION_TTL_MS || age < -5 * 60_000) return false; // süresi geçmiş / gelecekten
  const expected = Buffer.from(sign(`${iatStr}.${nonce}`));
  const got = Buffer.from(mac);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

// ── Süreç-içi (in-memory) ön fren ──
// Vercel her isteği aynı örneğe göndermediği için bu TEK savunma değil; DB
// sayacının önünde duran hızlı bir eşik. Asıl faydası: aynı örneğe düşen paralel
// patlamayı (DB'ye yazılan hatalar henüz sayılamazken gelen istekler) kesmek.
// Bilinçli olarak yalnız IP başına: süreç-içi GLOBAL bir kilit, örneklerin
// bir kısmında ekibe 429 döndürüp teşhisi zorlaştırırdı. Global karar tek
// yerde, kalıcı sayaçta veriliyor.
const memFails = new Map<string, number[]>();

function memPrune(key: string, windowMs: number): number[] {
  const now = Date.now();
  const arr = (memFails.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length) memFails.set(key, arr);
  else memFails.delete(key);
  return arr;
}

function memAdd(key: string, windowMs: number): void {
  const arr = memPrune(key, windowMs);
  arr.push(Date.now());
  memFails.set(key, arr);
  // IP döndürerek belleği şişirmeye karşı basit üst sınır. Kalıcı sayaç
  // etkilenmez; en kötü durumda ön fren körelir, asıl fren yerinde kalır.
  if (memFails.size > MEM_KEY_LIMIT) memFails.clear();
}

// ── Kalıcı sayaç (access_log) ──
// İndeksli okuma: access_log_event_ts_idx (event, ts desc) → sorgu ucuz.
// Global tarafta yalnız sayı değil, en yeni kayıtların IP'leri de çekilir; kaç
// FARKLI kaynaktan geldiğini bilmeden dağıtık saldırıyı tek bir bottan ayırmak
// mümkün değil. Dönüş null ise sayaç OKUNAMADI (aşağıda ayrıca ele alınır).
// Zaman damgaları da çekilir (yalnız sayı değil): kilidin ne zaman açılacağını
// hesaplamak için gerekli — bkz. drainSeconds.
type FailCounts = { ipTs: number[]; globalTs: number[]; globalIps: number };

async function dbFailCounts(ip: string | null): Promise<FailCounts | null> {
  try {
    const db = supabaseAdmin();
    const now = Date.now();
    const globalQ = db
      .from("access_log")
      .select("ip, ts")
      .eq("event", "login_fail")
      .gte("ts", new Date(now - GLOBAL_WINDOW_MS).toISOString())
      .order("ts", { ascending: false })
      .limit(GLOBAL_SAMPLE);
    const ipQ = ip
      ? db
          .from("access_log")
          .select("ts")
          .eq("event", "login_fail")
          .eq("ip", ip)
          .gte("ts", new Date(now - IP_WINDOW_MS).toISOString())
          .order("ts", { ascending: false })
          .limit(GLOBAL_SAMPLE)
      : null;

    const [g, i] = await Promise.all([globalQ, ipQ]);
    if (g.error || i?.error) return null;
    const ms = (rows: { ts: string }[] | null | undefined) =>
      (rows ?? []).map((r) => Date.parse(r.ts)).filter((n) => Number.isFinite(n));
    return {
      globalTs: ms(g.data),
      globalIps: new Set((g.data ?? []).map((r) => r.ip ?? "bilinmiyor")).size,
      ipTs: ms(i?.data),
    };
  } catch (e) {
    console.error("hata sayacı okunamadı:", e);
    return null;
  }
}

// Aynı IP için kilit: pencerede IP_MAX_FAIL hata varsa, sayaç eşiğin altına
// düşene kadar. 0 dönerse blok yok.
function ipRetryAfter(tsDesc: number[]): number {
  return drainSeconds(tsDesc, IP_MAX_FAIL, IP_WINDOW_MS);
}

// 429 yanıtı. NOT: bloklanan istek access_log'a YAZILMAZ — yazılsaydı sayaç
// kendi kendini besleyip kilit hiç açılmaz, saldırı sürerken ekip de giremezdi.
// (Ayrı bir 'login_blocked' event türü CHECK kısıtı nedeniyle SQL gerektiriyor.)
function tooMany(seconds: number, scope: "ip" | "global"): NextResponse {
  // Süre gerçekten ölçüldüğü için kullanıcıya da gerçeğini söyleyebiliyoruz:
  // bir dakikanın altındaysa saniye, üstündeyse yukarı yuvarlanmış dakika.
  const dk = seconds < 60 ? `${seconds} saniye` : `${Math.ceil(seconds / 60)} dakika`;
  const res = NextResponse.json(
    {
      ok: false,
      error:
        scope === "global"
          ? `Çok fazla hatalı deneme (birden fazla kaynaktan). Giriş geçici olarak kilitli, ${dk} sonra tekrar dene.`
          : `Çok fazla hatalı deneme. ${dk} sonra tekrar dene.`,
    },
    { status: 429 }
  );
  res.headers.set("Retry-After", String(seconds));
  return res;
}

// Erişim kaydı — access_log tablosuna yazar (kaç kez/ne zaman/nereden + hatalı
// denemeler). İKİ KURAL: (1) PIN veya başka gizli değer ASLA loglanmaz;
// (2) log hatası girişi bozmaz — hata yutulur, kullanıcı etkilenmez.
async function logAccess(
  req: NextRequest,
  event: "login_ok" | "login_fail" | "logout",
  ip: string | null
): Promise<void> {
  try {
    const ua = (req.headers.get("user-agent") ?? "").slice(0, 300) || null;
    await supabaseAdmin().from("access_log").insert({ event, ip, user_agent: ua });
  } catch (e) {
    console.error("access_log yazılamadı:", e);
  }
}

export async function POST(req: NextRequest) {
  // Env eksikse giriş kapalı — yanlışlıkla "şifresiz açık" duruma düşmeyi engeller.
  // Sıra bilinçli: yapılandırma hatası her şeyden önce, kapı hiç açılmadan döner.
  if (!PIN || !SESSION) {
    return NextResponse.json(
      { ok: false, error: "Sunucu yapılandırması eksik: SITE_PIN ve CORTEX_SESSION tanımlayın." },
      { status: 503 }
    );
  }

  const ip = clientIp(req);
  const ipKey = `ip:${ip ?? "bilinmiyor"}`;

  // 1) Hızlı ön fren (süreç-içi, IP başına). Ucuz; DB'ye hiç gitmeden aynı
  //    kaynaktan gelen patlamayı keser.
  const memWait = ipRetryAfter([...memPrune(ipKey, IP_WINDOW_MS)].sort((a, b) => b - a));
  if (memWait) return tooMany(memWait, "ip");

  // 2) Kalıcı sayaç (access_log). Serverless örnekleri bellek paylaşmadığı için
  //    gerçek fren burasıdır. Kilit devredeyken DOĞRU PIN de reddedilir —
  //    yoksa kilit anlamsız olurdu (saldırgan doğru PIN'i bulduğu an girerdi).
  const counts = await dbFailCounts(ip);
  if (counts) {
    if (counts.globalIps >= GLOBAL_MIN_IPS) {
      const gWait = drainSeconds(counts.globalTs, GLOBAL_MAX_FAIL, GLOBAL_WINDOW_MS);
      if (gWait) return tooMany(gWait, "global");
    }
    const wait = ipRetryAfter(counts.ipTs);
    if (wait) return tooMany(wait, "ip");
  } else {
    // Sayaç okunamadı (Supabase erişimi yok). Burada tamamen reddetmek her kısa
    // kesintide ekibi kapı dışında bırakırdı; süreç-içi fren + 500 ms gecikme
    // devrede kalır. Kalan risk raporlandı.
    console.warn("auth: kalıcı sayaç okunamadı, yalnız süreç-içi fren devrede");
  }

  const body = await req.json().catch(() => ({}));
  const pin = String(body?.pin ?? "").trim();

  if (!pinMatches(pin)) {
    memAdd(ipKey, IP_WINDOW_MS);
    // Sayacın çalışması için hata kaydının yazılması ŞART (await bilinçli).
    await logAccess(req, "login_fail", ip);
    // Kaba kuvveti yavaşlatmak için küçük gecikme (tek fren değil, ek fren).
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ ok: false, error: "Hatalı PIN" }, { status: 401 });
  }

  await logAccess(req, "login_ok", ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, newToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000), // 7 gün — token ömrüyle aynı
  });
  return res;
}

// Çıkış: çerezi sil. Log YALNIZCA geçerli çerez varsa yazılır — /api/auth
// middleware kapısının dışında olduğu için aksi halde herkes kimliksiz istekle
// denetim tablosunu şişirip gerçek saldırı izlerini gürültüde boğabilirdi.
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(COOKIE)?.value ?? "";
  if (tokenValid(token)) await logAccess(req, "logout", clientIp(req));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
