import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { LogoutButton } from "@/components/LogoutButton";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "CORTEX — Mythos Retail Intelligence",
  description: "Çok-perakendeci haftalık satış & stok zekası. Momentum, anomali, stockout tahmini, cross-retailer analiz.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <header className="border-b border-line sticky top-0 z-50 backdrop-blur-md bg-ink/80">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
            <Link href="/" className="flex items-center gap-2 sm:gap-3 group shrink-0">
              <svg width="26" height="26" viewBox="0 0 32 32" className="shrink-0">
                <path d="M16 2 L28 9 V23 L16 30 L4 23 V9 Z" fill="none"
                  stroke="#1FF80B" strokeWidth="1.5" opacity="0.4" />
                <circle cx="16" cy="16" r="3" fill="#1FF80B" />
                <path d="M16 16 L16 7 M16 16 L24 12 M16 16 L24 20 M16 16 L8 20 M16 16 L8 12"
                  stroke="#1FF80B" strokeWidth="1.2" opacity="0.7" />
                <circle cx="16" cy="7" r="1.6" fill="#1FF80B" />
                <circle cx="24" cy="12" r="1.6" fill="#1FF80B" />
                <circle cx="24" cy="20" r="1.6" fill="#1FF80B" />
                <circle cx="8" cy="20" r="1.6" fill="#1FF80B" />
                <circle cx="8" cy="12" r="1.6" fill="#1FF80B" />
              </svg>
              <div className="leading-none">
                <div className="font-bold text-lg tracking-[0.2em] neon-text">CORTEX</div>
                <div className="mono text-[9px] text-txt-dim tracking-wider mt-0.5 hidden sm:block">MYTHOS RETAIL INTELLIGENCE · UNHOLY LABS</div>
              </div>
            </Link>
            <Nav />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">{children}</main>
        <footer className="border-t border-line mt-16">
          <div className="max-w-7xl mx-auto px-6 py-6 mono text-xs text-txt-dim space-y-3">
            <div className="flex justify-between flex-wrap gap-2">
              <span>CORTEX · Mythos Cards</span>
              <span>Nezih · Huppaluppo · Armağan · Toyzz · DR</span>
            </div>
            <div className="pt-3 border-t border-line/50 flex items-center justify-center gap-3 text-[11px] tracking-wider">
              <span>© Unholy Labs / Mert Dönmezler</span>
              <span className="text-line">·</span>
              <LogoutButton />
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
