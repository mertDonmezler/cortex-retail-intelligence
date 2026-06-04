import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 6 haneli PIN sunucuda doğrulanır; doğruysa httpOnly oturum çerezi yazılır.
// Anahtarlar yalnızca ortam değişkenlerinden gelir (repoda gizli değer tutulmaz).
const PIN = process.env.SITE_PIN || "";
const SESSION = process.env.CORTEX_SESSION || "";
const COOKIE = "cortex_auth";

// Sabit-zamanlı PIN karşılaştırması: uzunluk farkında hemen false dön (timingSafeEqual
// eşit uzunluk ister), eşit uzunlukta ise zamanlama sızıntısı olmadan karşılaştır.
function pinMatches(got: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(PIN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const pin = String(body?.pin ?? "").trim();

  // Env eksikse giriş kapalı — yanlışlıkla "şifresiz açık" duruma düşmeyi engeller.
  if (!PIN || !SESSION) {
    return NextResponse.json(
      { ok: false, error: "Sunucu yapılandırması eksik: SITE_PIN ve CORTEX_SESSION tanımlayın." },
      { status: 503 }
    );
  }

  if (!pinMatches(pin)) {
    // Kaba kuvveti yavaşlatmak için küçük gecikme.
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ ok: false, error: "Hatalı PIN" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, SESSION, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 gün
  });
  return res;
}

// Çıkış: çerezi sil.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
