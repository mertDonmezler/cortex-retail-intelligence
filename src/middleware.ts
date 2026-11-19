import { NextRequest, NextResponse } from "next/server";

// PIN ile giriş kapısı. Oturum çerezi geçerliyse geç, değilse /giris'e yönlendir.
// Not: PIN burada DEĞİL, /api/auth içinde (sunucu) doğrulanır; tarayıcıya hiç inmez.
//
// ÇEREZ ARTIK STATİK SIR DEĞİL: eskiden çerez değeri doğrudan CORTEX_SESSION'dı
// (herkeste aynı, 30 gün, iptal edilemez, çalınınca fark edilemez). Artık çerez
// /api/auth'un imzaladığı `iat.nonce.hmac` biçiminde süreli bir token; burada hem
// imza hem yaş doğrulanır. CORTEX_SESSION = İMZA ANAHTARI → değeri değiştirilince
// dağıtılmış tüm token'lar geçersiz olur (oturum iptali).
//
// RUNTIME NOTU: Next.js 14'te middleware Edge runtime'da çalışır, `node:crypto`
// burada yoktur. Bu yüzden doğrulama Web Crypto (crypto.subtle) ile yapılır;
// karşılaştırma subtle.verify içinde sabit zamanlı olur (elle byte kıyaslaması
// yapmıyoruz). /api/auth ise nodejs runtime'da aynı imzayı createHmac ile üretir —
// HMAC-SHA256 + base64url her iki tarafta aynı sonucu verir.
const SESSION = process.env.CORTEX_SESSION || "";
const COOKIE = "cortex_auth";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // /api/auth ile aynı olmalı
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// İmza anahtarı örnek başına bir kez kurulur (Edge örnekleri yeniden kullanılır).
let keyPromise: Promise<CryptoKey> | null = null;
function hmacKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SESSION),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
  }
  return keyPromise;
}

// base64url → byte dizisi (Edge'de Buffer yok; atob var).
// Dönüş tipi bilinçli olarak yazılmadı: TS 5.7+ Uint8Array'i generic yaptı ve
// crypto.subtle.verify `ArrayBuffer` destekli bir görünüm bekliyor; tampon açıkça
// ArrayBuffer'dan kurulup tip çıkarımına bırakılınca her iki TS sürümünde de derler.
function b64urlToBytes(s: string) {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Fail-closed: SESSION yoksa, biçim bozuksa, süre geçmişse veya imza tutmazsa
// HER durumda false → kapı kapalı kalır.
async function tokenValid(token: string | undefined): Promise<boolean> {
  if (!SESSION || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [iatStr, nonce, mac] = parts;
  if (!/^\d{10,15}$/.test(iatStr)) return false;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return false;
  const age = Date.now() - Number(iatStr);
  if (age > SESSION_TTL_MS) return false; // süresi doldu
  if (age < -CLOCK_SKEW_MS) return false; // gelecekten gelen token (uydurulmuş/saat kayması)
  const sig = b64urlToBytes(mac);
  if (!sig) return false;
  try {
    const key = await hmacKey();
    // İmzalanan metin ham parçalardan kurulur (yeniden biçimlendirme yok) ki
    // /api/auth'un imzaladığı bayt dizisiyle birebir aynı olsun.
    return await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      new TextEncoder().encode(`${iatStr}.${nonce}`)
    );
  } catch (e) {
    keyPromise = null; // geçici hata kalıcı bozulmaya dönüşmesin
    console.error("oturum imzası doğrulanamadı:", e);
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Giriş sayfası her zaman açık olmalı (yoksa sonsuz yönlendirme).
  if (pathname === "/giris" || pathname.startsWith("/giris/")) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE)?.value;
  if (await tokenValid(token)) return NextResponse.next();

  // API YOLLARI YONLENDIRILMEZ, 401 DONER.
  //
  // Bu middleware API cagrilarina da uygulaniyor. Oturum suresi (7 gun) dolunca
  // /giris'e yonlendirme yayinlaniyordu; tarayici fetch'i yonlendirmeyi takip
  // edip 200 + giris sayfasinin HTML'ini donduruyor ve fetchJson bunu BASARILI
  // sayiyordu. Sonuc: ekran ne hata veriyor ne veri gosteriyor, sessizce bos.
  if (pathname.startsWith("/api/")) {
    const res = NextResponse.json(
      { error: "Oturum suresi doldu - sayfayi yenileyip PIN ile tekrar girin." },
      { status: 401 }
    );
    if (token) res.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  // Giriş yapılmamış → /giris'e gönder, geldiği yolu sakla (giriş sonrası dönsün).
  const url = req.nextUrl.clone();
  url.pathname = "/giris";
  url.search = "";
  const next = pathname + (req.nextUrl.search || "");
  if (next && next !== "/") url.searchParams.set("next", next);
  const res = NextResponse.redirect(url);
  // Geçersiz/süresi geçmiş (ve eski biçimdeki) çerezi temizle: tarayıcıda işe
  // yaramaz bir değer taşınmasın, her istekte boşuna doğrulanmasın.
  if (token) res.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export const config = {
  // api/auth, _next statikleri ve BILINEN uzantili varliklar haric her sey.
  //
  // UZANTI LISTESI ACIK YAZILDI. Eski kalip `.*\.` idi ve "icinde nokta gecen
  // HER yolu" kapi disinda birakiyordu; /kanal/[slug] keyfi slug kabul ettigi
  // icin /kanal/a.b middlewarei hic gormuyordu. Bugun veri sizmiyor (sayfa
  // istemci tarafinda, veriyi korunan uctan cekiyor) ama bu tesaduf, kural degil.
  // Genel `.*\.[a-z0-9]+$` de ayni acigi birakirdi (a.b eslesirdi); bu yuzden
  // yalnizca gercek varlik uzantilari muaf.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon|robots|sitemap|.*\\.(?:ico|png|jpe?g|gif|svg|webp|avif|css|js|mjs|map|txt|xml|json|woff2?|ttf|otf|eot)$).*)"],
};
