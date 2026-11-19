"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

// Sunum modu — URL'de ?demo (veya ?sunum) varsa para/hacim figürlerini GÖRSEL
// olarak blur'lar. Amaç: canlı ekran paylaşımı / ekran görüntüsü sırasında gerçek
// finansalları gizlemek (mülakat, showcase). Kaynak veriyi DEĞİŞTİRMEZ — yalnız
// CSS filter; değerler DOM'da ve ağ yanıtlarında AÇIKTIR. Yani bu bir veri gizleme
// mekanizması değil, "omuz üstünden bakan göze" karşı bir perde. Rozetin altındaki
// küçük not ve title bunu açıkça yazar (yanlış güven vermesin).
//
// GEÇMİŞ HATA (düzeltildi): mod yalnız ilk mount'ta URL'den okunuyor, son tarama
// 3000 ms'de bitiyordu. Bileşen root layout'ta olduğu için client gezinmede
// remount OLMUYOR, Nav bağlantıları da query'yi taşımıyordu → /?demo'dan /stok'a
// geçince yeni DOM hiç maskelenmiyor, ama yeşil rozet ekranda kalıyordu. Ekran
// paylaşımında yanlış güven. Çözüm: (1) mod sessionStorage'da kalıcı, (2) pathname
// değişiminde yeniden kurulum, (3) MutationObserver ile yeni/değişen düğümler
// sürekli maskelenir, (4) rozet ancak maskeleme gerçekten çalışırken görünür.
//
// Eşleşme: ₺ işareti · binlik ayraçlı sayı (1.090.449) · 3+ basamaklı sayı (944).
// Küçük sayılar (5 kanal, 42) ve yüzdeler (+10,4%) bilinçli olarak açık bırakılır.
const NUM_RE = /₺|\d[.,]\d{3}|\d{3,}/;

// Metin taşımayan / maskelemenin anlamsız olduğu etiketler.
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TITLE", "LINK", "META"]);

export const DEMO_KEY = "cortex_demo";
export const DEMO_EVENT = "cortex-demo-change";
const OFF_VALUES = new Set(["0", "off", "false", "kapat", "no"]);

// Mod açık mı? sessionStorage kullanılıyor: sekme kapanınca kendiliğinden söner,
// diğer sekmelere sızmaz. (Bazı gizlilik ayarlarında erişim hata verir → yut.)
export function demoActive(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DEMO_KEY) === "1";
  } catch {
    return false;
  }
}

function setDemoStored(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(DEMO_KEY, "1");
    else window.sessionStorage.removeItem(DEMO_KEY);
  } catch {
    /* sessionStorage kapalı — mod yalnız bu sayfa için geçerli olur */
  }
}

// Nav gibi diğer bileşenler modu buradan öğrenir (ör. bağlantılara ?demo ekleyip
// sert yenilemede modun kaybolmasını önlemek için).
export function useDemoMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(demoActive());
    sync();
    window.addEventListener(DEMO_EVENT, sync);
    return () => window.removeEventListener(DEMO_EVENT, sync);
  }, []);
  return on;
}

export function DemoMask() {
  const pathname = usePathname();
  const [on, setOn] = useState(false); // mod istendi mi
  const [active, setActive] = useState(false); // maskeleme gerçekten çalışıyor mu
  const lastOn = useRef<boolean | null>(null);

  // 1) Modu belirle. URL'de ?demo varsa aç, ?demo=0 ise kapat; aksi halde
  //    sessionStorage'daki karar geçerli. pathname'e bağlı → her gezinmede
  //    yeniden değerlendirilir (query düşse bile mod ayakta kalır).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const raw = q.has("demo") ? q.get("demo") : q.has("sunum") ? q.get("sunum") : null;
    const wantsOff = raw !== null && OFF_VALUES.has(raw.trim().toLowerCase());
    const next = wantsOff ? false : raw !== null || demoActive();

    setDemoStored(next);
    setOn(next);
    // Yalnız gerçek değişimde haber ver (Nav boşuna render olmasın).
    if (lastOn.current !== next) {
      lastOn.current = next;
      window.dispatchEvent(new Event(DEMO_EVENT));
    }
  }, [pathname]);

  // Mod kapanırsa rozet de anında düşsün.
  useEffect(() => {
    if (!on) setActive(false);
  }, [on]);

  // 2) Maskeleme. Açılışta tarar, sonra DOM'u izler: async gelen veriler, client
  //    gezinmeyle değişen sayfa gövdesi ve sonradan dolan hücreler dahil.
  useEffect(() => {
    if (!on) return;
    let timer = 0;
    let stopped = false;

    // Kural İKİ yönlü: sayı içeren yaprak düğüme maske EKLE, artık sayı
    // içermiyorsa KALDIR. Eski sürümdeki "bir kez gördüm" damgası, boşken
    // taranıp sonra veriyle dolan hücreleri kalıcı olarak açıkta bırakıyordu.
    function isaretle(el: Element) {
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.children.length !== 0) return; // yalnız yaprak düğümler
      if (el.closest("[data-demo-ui]")) return; // rozetin kendisi hariç
      const t = (el.textContent || "").trim();
      const hit = t.length > 0 && t.length < 48 && NUM_RE.test(t);
      if (hit) el.classList.add("demo-blur");
      else el.classList.remove("demo-blur");
    }

    function scan() {
      document.querySelectorAll<HTMLElement>("body *").forEach(isaretle);
    }

    function schedule() {
      if (timer) return; // 120 ms'lik toplama: animasyon/veri akışında boğulmayalım
      timer = window.setTimeout(() => {
        timer = 0;
        scan();
      }, 120);
    }

    // DEĞİŞEN DÜĞÜMLER EŞZAMANLI İŞARETLENİR. Gözlemci geri çağrısı boyamadan
    // önce (mikro görevde) çalışır; yalnız 120 ms'lik taramaya güvenmek "—" → ₺
    // geçişinde birkaç kare maskesiz sayı gösteriyordu. Tam tarama yine çalışır
    // ve yaprak olmaktan çıkan düğümlerin maskesini temizler.
    function degisenler(kayitlar: MutationRecord[]) {
      for (const k of kayitlar) {
        if (k.type === "characterData") {
          if (k.target.parentElement) isaretle(k.target.parentElement);
          continue;
        }
        k.addedNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) {
            if (n.parentElement) isaretle(n.parentElement);
          } else if (n instanceof Element) {
            isaretle(n);
            n.querySelectorAll("*").forEach(isaretle);
          }
        });
      }
      schedule();
    }

    scan();
    const mo = new MutationObserver(degisenler);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Rozet ancak ilk tarama yapılıp izleyici kurulduktan SONRA görünür.
    if (!stopped) setActive(true);

    return () => {
      stopped = true;
      mo.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [on, pathname]);

  if (!on) return null;
  return (
    <>
      {/* Stil, rozetten önce basılır ki sınıf eklenen düğüm bir an açık kalmasın. */}
      <style>{`.demo-blur{filter:blur(6px)!important}`}</style>
      {active && (
        <div
          data-demo-ui
          aria-hidden="true"
          title="Yalnız GÖRSEL maskeleme: sayılar CSS ile bulanıklaştırılır, değerler DOM'da ve ağ yanıtlarında açıktır. Ekran paylaşımı içindir, veri gizleme değildir. Kapatmak için adrese ?demo=0 ekle."
          style={{
            position: "fixed", bottom: 14, right: 14, zIndex: 9999,
            fontFamily: "ui-monospace, 'JetBrains Mono', monospace", fontSize: 11,
            letterSpacing: "0.12em", color: "#0a0e0a", background: "#1FF80B",
            padding: "6px 11px", borderRadius: 7, fontWeight: 700,
            boxShadow: "0 4px 16px rgba(0,0,0,0.45)", lineHeight: 1.35,
            textAlign: "right",
          }}
        >
          <div>● SUNUM MODU · rakamlar bulanık</div>
          <div style={{ fontSize: 9, fontWeight: 600, opacity: 0.75, letterSpacing: "0.06em" }}>
            yalnız görsel · veri DOM&apos;da açık
          </div>
        </div>
      )}
    </>
  );
}
