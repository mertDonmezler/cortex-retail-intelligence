"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Üst menü. Silinen sayfalar (/overview, /coverage, /olu-stok) çıkarıldı;
// /stok birleşik stok merkezi, Dashboard ise özeti içeriyor.
const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/insights", label: "Intelligence" },
  { href: "/rankings", label: "Sıralamalar" },
  { href: "/compare", label: "Karşılaştır" },
  { href: "/stores", label: "Mağazalar" },
  { href: "/product", label: "Ürün" },
  { href: "/sku", label: "SKU" },
  { href: "/stock-alerts", label: "Sipariş" },
  { href: "/stok", label: "Stok" },
  { href: "/yonlendirme", label: "Yönlendirme" },
  { href: "/sat-ode", label: "Sat-Öde" },
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
  return (
    <nav className="flex gap-0.5 flex-1 min-w-0 flex-nowrap overflow-x-auto md:flex-wrap md:justify-end md:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {NAV.map((n) => {
        const active = isActive(pathname, n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "mono text-xs px-3 py-2 rounded-lg text-neon bg-neon/10 transition-colors whitespace-nowrap"
                : "mono text-xs px-3 py-2 rounded-lg text-txt-dim hover:text-neon hover:bg-neon/5 transition-colors whitespace-nowrap"
            }
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
