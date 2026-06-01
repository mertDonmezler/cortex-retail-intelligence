import { NextRequest, NextResponse } from "next/server";

// PIN ile giriş kapısı. Oturum çerezi (httpOnly) doğruysa geç, değilse /giris'e yönlendir.
// Not: PIN burada DEĞİL, /api/auth içinde (sunucu) doğrulanır; tarayıcıya hiç inmez.
// Oturum anahtarı yalnızca env'den okunur; tanımsızsa hiçbir çerez eşleşmez (fail-closed).
const SESSION = process.env.CORTEX_SESSION || "";
const COOKIE = "cortex_auth";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Giriş sayfası her zaman açık olmalı (yoksa sonsuz yönlendirme).
  if (pathname === "/giris" || pathname.startsWith("/giris/")) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE)?.value;
  if (token && token === SESSION) return NextResponse.next();

  // Giriş yapılmamış → /giris'e gönder, geldiği yolu sakla (giriş sonrası dönsün).
  const url = req.nextUrl.clone();
  url.pathname = "/giris";
  url.search = "";
  const next = pathname + (req.nextUrl.search || "");
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

export const config = {
  // api/auth, _next statikleri, favicon ve uzantılı dosyalar (resim, css…) hariç her şey.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon|robots|sitemap|.*\\.).*)"],
};
