"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useDemoMode } from "@/components/DemoMask";
import { KANALLAR, kanalAdi, slugOf } from "@/lib/kanal";
import { SURE, bekleme, useKareEtkisi } from "@/lib/hareket";
import { basla } from "@/lib/mesgul";

// Üst menü. Silinen sayfalar (/overview, /coverage, /olu-stok, /sat-ode) çıkarıldı;
// /stok birleşik stok merkezi, Dashboard özeti + nakit takvimini içeriyor.
// (Sat-Öde/fatura mutabakatı bilinçli olarak kapsam dışı: bu sistem satış-stok
// optimizasyonudur; fatura muhasebesi ayrı bir dünya.)
//
// KANAL SEKMELERİ (5 firma) menüye eklendi; yer açmak için /rankings ve
// /compare menüden ÇIKARILDI (sayfalar duruyor, adresten açılabilir). Gerekçe:
// ikisi de ağ genelinde sıralama/kıyas veriyordu, kanal ekranı aynı soruyu
// firmanın kendi tablosunda ve daha ayrıntılı cevaplıyor.
const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/insights", label: "Intelligence" },
  ...KANALLAR.map((r) => ({ href: `/kanal/${slugOf(r)}`, label: kanalAdi(r) })),
  { href: "/stores", label: "Mağazalar" },
  { href: "/product", label: "Ürün" },
  { href: "/sku", label: "SKU" },
  { href: "/stock-alerts", label: "Sipariş" },
  { href: "/stok", label: "Stok" },
  { href: "/yonlendirme", label: "Yönlendirme" },
  { href: "/eslesme", label: "Eşleşme" },
  { href: "/upload", label: "Yükle" },
];

// Aktif sayfa kontrolü: "/" yalnızca tam eşleşmede, diğerleri alt yollarda da aktif.
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Nav() {
  const pathname = usePathname();
  // Sunum modu açıkken bağlantılar ?demo'yu taşır. Mod sessionStorage'da da
  // tutuluyor (DemoMask); query'yi korumanın amacı adres çubuğunun modu doğru
  // göstermesi ve sert yenilemede/paylaşılan bağlantıda modun düşmemesi.
  const demo = useDemoMode();

  // "TIKLAMAN ALINDI, SAYFA YOLDA" ile "BURADASIN" iki ayrı durumdur. Aktif
  // zemin yalnız pathname değiştiği karede geçer; o zamana kadar tıklanan
  // bağlantının altında (200 ms eşikten sonra) statik bir çizgi durur ve logo
  // tarar. Çizgi dolmaz: sahte ilerleme değildir.
  const [bekleyen, setBekleyen] = useState<string | null>(null);
  const bitirRef = useRef<(() => void) | null>(null);
  const navRef = useRef<HTMLElement>(null);

  const git = (e: MouseEvent<HTMLAnchorElement>, href: string, active: boolean) => {
    // Yeni sekme / pencere ya da zaten buradayız → bekleme başlamaz.
    if (active || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    setBekleyen(href);
    bitirRef.current?.();
    bitirRef.current = basla();
  };

  // Boyamadan önce: aktif zeminin geldiği karede hedef çizgisi kalmasın.
  useKareEtkisi(() => {
    bitirRef.current?.();
    bitirRef.current = null;
    setBekleyen(null);
    // Dar ekranda menü yatay kayıyor: yeni aktif sekme görünür alana gelsin.
    const nav = navRef.current;
    if (nav && nav.scrollWidth > nav.clientWidth) {
      nav.querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [pathname]);

  // Emniyet: gezinme hiç tamamlanmazsa çizgi ve logo sonsuza dek kalmasın.
  useEffect(() => {
    if (!bekleyen) return;
    const t = setTimeout(() => {
      bitirRef.current?.();
      bitirRef.current = null;
      setBekleyen(null);
    }, SURE.emniyet);
    return () => clearTimeout(t);
  }, [bekleyen]);

  return (
    <nav ref={navRef} className="flex gap-0.5 flex-1 min-w-0 flex-nowrap overflow-x-auto md:flex-wrap md:justify-end md:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {NAV.map((n) => {
        const active = isActive(pathname, n.href);
        return (
          <Link
            key={n.href}
            href={demo ? `${n.href}?demo=1` : n.href}
            aria-current={active ? "page" : undefined}
            onClick={(e) => git(e, n.href, active)}
            {...bekleme(bekleyen === n.href)}
            className={
              active
                ? "relative cx-hedef mono text-xs px-3 py-2 rounded-lg text-neon bg-neon/10 whitespace-nowrap"
                : "relative cx-hedef mono text-xs px-3 py-2 rounded-lg text-txt-dim hover:text-neon hover:bg-neon/5 hover:transition-colors whitespace-nowrap"
            }
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
