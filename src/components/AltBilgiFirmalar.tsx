"use client";

// Alt bilgideki iş ortağı listesi — İSTEMCİ BİLEŞENİ OLMASI BİLİNÇLİ.
//
// Bu satır önce layout'ta düz sunucu JSX'iydi ve `Kabuk` /giris'te alt bilgiyi
// render etmemesine rağmen isimler kimliği doğrulanmamış yanıtta KALIYORDU:
// sunucu JSX'i bir istemci bileşenine prop olarak geçtiğinde Flight yüküne
// METİN olarak serileşiyor (render edilmese bile). Ölçüm bunu tam olarak
// gösterdi: /giris HTML'inde "Yönlendirme" 0 kez (Nav bir istemci bileşeni
// olduğu için yalnız modül referansı serileşiyor) ama "Nezih" 1 kez geçiyordu.
//
// İstemci bileşeni yapıldığında bu satır da modül referansına dönüşür ve giriş
// ekranının HTML'inde hiç görünmez.
//
// DÜRÜST SINIR: isimler `RETAILERS` sabitinden geliyor ve o sabit zaten istemci
// paketinde — `_next/static/**` middleware kapısının dışında olduğu için
// anonim olarak indirilebilir. Yani buradaki kazanç "giriş ekranının yanıtı
// temiz" olmasıdır, mutlak gizlilik değil. Gerçek gizlilik istenirse liste
// sunucuda kalmalı ve yalnız kimlik doğrulanmış bir uçtan gelmelidir.
import { RETAILERS } from "@/lib/format";

export function AltBilgiFirmalar() {
  return <span>{RETAILERS.join(" · ")}</span>;
}
