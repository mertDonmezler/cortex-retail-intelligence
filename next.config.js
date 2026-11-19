/** @type {import('next').NextConfig} */

// Güvenlik başlıkları — iç şirket paneli olduğu için hepsi kısıtlayıcı yönde.
// NEDEN:
// - X-Frame-Options: DENY → panel başka bir sitenin iframe'ine gömülemez;
//   clickjacking ile ekibin farkında olmadan tıklaması engellenir. (Panelin
//   kendisini hiçbir yerde iframe'e gömmüyoruz, kırılacak bir kullanım yok.)
// - X-Content-Type-Options: nosniff → tarayıcı içerik türünü tahmin etmesin;
//   yüklenen bir dosyanın script gibi yorumlanmasına kapı bırakmaz.
// - Referrer-Policy → dış bağlantılara (ör. Google Fonts) tam URL sızmasın;
//   adres çubuğundaki sorgu parametreleri (sku, filtre) üçüncü tarafa gitmez.
// - Permissions-Policy → kamera/mikrofon/konum/ödeme/USB izinleri tamamen kapalı;
//   panelin böyle bir ihtiyacı yok, olası bir XSS bunları isteyemez.
//
// CSP BİLİNÇLİ OLARAK EKLENMEDİ: Next.js kendi hydration script'lerini ve
// styled-jsx/inline stil bloklarını inline basıyor, ayrıca Google Fonts dış
// kaynaklı. Nonce üretmeden yazılacak bir CSP ya paneli kırar ya da
// 'unsafe-inline' ile aslında koruma sağlamaz. Ayrıca raporlandı.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig = {
  reactStrictMode: true,
  optimizeFonts: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
module.exports = nextConfig;
