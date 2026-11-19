import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { LogoutButton } from "@/components/LogoutButton";
import { Nav } from "@/components/Nav";
import { DemoMask } from "@/components/DemoMask";
import { Kabuk } from "@/components/Kabuk";
import { AltBilgiFirmalar } from "@/components/AltBilgiFirmalar";
import { CortexLogo } from "@/components/CortexLogo";

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
        <DemoMask />
        <Kabuk
          header={
            <header className="border-b border-line sticky top-0 z-50 backdrop-blur-md bg-ink/80">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
                <Link href="/" className="flex items-center gap-2 sm:gap-3 group shrink-0">
                  <CortexLogo boyut={26} className="shrink-0" />
                  <div className="leading-none">
                    <div className="font-bold text-lg tracking-[0.2em] neon-text">CORTEX</div>
                    <div className="mono text-[9px] text-txt-dim tracking-wider mt-0.5 hidden sm:block">MYTHOS RETAIL INTELLIGENCE</div>
                  </div>
                </Link>
                <Nav />
              </div>
            </header>
          }
          footer={
            <footer className="border-t border-line mt-16">
              <div className="max-w-7xl mx-auto px-6 py-6 mono text-xs text-txt-dim space-y-3">
                <div className="flex justify-between flex-wrap gap-2">
                  <span>CORTEX · Mythos Cards</span>
                  <AltBilgiFirmalar />
                </div>
                <div className="pt-3 border-t border-line/50 flex items-center justify-center gap-3 text-[11px] tracking-wider">
                  <span>© Mert Dönmezler</span>
                  <span className="text-line">·</span>
                  <LogoutButton />
                </div>
              </div>
            </footer>
          }
        >
          {children}
        </Kabuk>
      </body>
    </html>
  );
}
