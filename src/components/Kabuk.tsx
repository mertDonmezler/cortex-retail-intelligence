"use client";

// UYGULAMA KABUĞU — başlık ve alt bilgi, YALNIZ giriş yapılmış rotalarda.
//
// NEDEN VAR: paylaşılan yerleşim /giris rotasında da çalışıyordu ve kimliği
// doğrulanmamış ziyaretçiye şunları sunuyordu (ölçüldü: çerezsiz gövde,
// çerezli gövdeyle bayt-bayt aynı):
//   • 12 kalemlik tam gezinti menüsü — uygulamanın tüm yüzey haritası
//   • alt bilgideki iş ortağı listesi: Nezih · Huppaluppo · Armağan · Toyzz · DR
//   • "çıkış" butonu — oturumu olmayan birine gösterilen anlamsız bir kontrol
// PIN kapısının arkasındaki veriye erişim yok, ama hangi perakendecilerle
// çalışıldığı ticari bir bilgi ve giriş ekranında durmasının bir gerekçesi yok.
//
// NİYE ROUTE GROUP DEĞİL: /giris'i `(auth)/giris` altına taşımak da çözerdi ama
// dosya taşımak middleware eşleştiricisini ve /giris?next=… bağlantılarını
// etkiler. Tek bir yol kontrolü daha küçük ve geri alınabilir bir müdahale.
//
// SUNUCU JSX'i PROP OLARAK GEÇİYOR: header/footer ağaçları layout'ta (sunucu)
// kuruluyor, burada yalnız gösterilip gösterilmeyeceğine karar veriliyor —
// yani Nav/LogoutButton'ın kendi istemci sınırları olduğu gibi kalıyor.
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Asistan } from "@/components/Asistan";

export function Kabuk({
  header, footer, children,
}: {
  header: ReactNode; footer: ReactNode; children: ReactNode;
}) {
  const yol = usePathname() ?? "";
  const girisEkrani = yol === "/giris" || yol.startsWith("/giris/");
  return (
    <>
      {!girisEkrani && header}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">{children}</main>
      {!girisEkrani && footer}
      {/* CORTEX asistanı: kabukta yaşar, sayfa değişince sohbet sürer. */}
      {!girisEkrani && <Asistan />}
    </>
  );
}
