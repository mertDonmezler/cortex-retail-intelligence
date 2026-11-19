"use client";

// BANT 3 — BUGÜN YAPILACAKLAR. ActionPanel'in yerini alır.
//
// NEDEN YENİ BİLEŞEN: ActionPanel iki kova (SEVK / ÇEK) gösteriyordu ve TEYİT
// kovası hiç görünmüyordu — oysa teyit edilmemiş stok üzerinde alınan her karar
// (çek / likide et) yanlış olabilir, yani sıradaki değil İLK iştir. Ayrıca ÇEK
// kovası içinde LİKİDASYON (geri alınamaz markdown kararı) ile DEPO (geri
// alınabilir çekme) tek başlık altında düzleşiyordu; satır bazında rozetle ayrıldı.
//
// SUNUM MODU (DemoMask) KISITI: maskeleme yalnız YAPRAK düğümlere ve metni 48
// karakterden kısa olanlara uygulanır. Bu yüzden her satırın firma / ürün / sayı
// parçaları AYRI span'lerde durur; birleşik uzun metin yazılsa sunumda para sızar.
import type { CSSProperties } from "react";
import { colorOf, fmtInt, fmtCompact, fmtHafta, fmtDate } from "@/lib/format";
import { GECIKME_ROZET } from "@/lib/compute";

// Aksiyon renkleri /yonlendirme'deki ACT haritasıyla BİREBİR aynı (tek doğruluk
// kaynağı orası; burada yeni hex uydurulmadı).
const ACT: Record<string, { kisa: string; c: string }> = {
  SEVK: { kisa: "SEVK", c: "#1FF80B" },
  DEPO: { kisa: "DEPO", c: "#f8b00b" },
  TRANSFER: { kisa: "VER", c: "#0bd1f8" },
  LIKIDASYON: { kisa: "LİKİDE", c: "#ff5555" },
  TEYİT: { kisa: "TEYİT", c: "#c084fc" },
  ERIT: { kisa: "ERİT", c: "#7d927d" },
  ASKIDA: { kisa: "ASKIDA", c: "#f8b00b" },
  DAĞIT: { kisa: "DAĞIT", c: "#0bd1f8" },
};
const CEK = ["DEPO", "TRANSFER", "LIKIDASYON"];

interface Route {
  sku_name: string;
  retailer: string;
  action: string;
  qty: number;
  value: number;
  reason?: string;
  coverage?: number | null;
  velocity?: number;
  target?: number;
  dest?: { retailer: string; qty: number } | null;
  noPrice?: boolean;
  stale?: boolean;
  last_seen?: string | null;
  // Veri yaşı alanları — motor her satırda gönderiyor.
  dataWeek?: string | null;
  gecikmeHf?: number;
  qtyHam?: number;
  sevkUst?: number;
  askidaFiil?: string | null;
  kapi?: string | null;
  // 8 haftalık NET etki (raf eğrisiyle; motor SEVK/TRANSFER satırında gönderiyor).
  etki8?: number;
}

// Firma rozeti — ürün adından ve sayıdan AYRI yaprak (bkz. sunum modu notu).
function Firma({ r }: { r: string }) {
  const c = colorOf(r);
  return (
    <span
      className="mono text-[11px] px-1.5 py-0.5 rounded shrink-0"
      style={{ color: c, border: `1px solid ${c}40`, background: c + "14" }}
    >
      {r}
    </span>
  );
}

function Rozet({ metin, renk }: { metin: string; renk: string }) {
  return (
    <span
      className="mono text-[11px] px-1.5 py-0.5 rounded shrink-0"
      style={{ color: renk, border: `1px solid ${renk}40` }}
    >
      {metin}
    </span>
  );
}

// Bir grup: başlık + satırlar. KALEMİ OLMAYAN GRUP HİÇ RENDER EDİLMEZ (başlık dahil) —
// "0 kalem" yazmak bir karar sayfasının en yanıltıcı boş durumudur.
function Grup({
  baslik,
  fiil,
  renk,
  satirlar,
  altSatir,
  href,
  gecikme,
  takvimHaftasi,
  yanki,
}: {
  baslik: string;
  fiil: string;
  renk: string;
  satirlar: Route[];
  altSatir?: { a: string; b?: string };
  href: string;
  gecikme: Record<string, number>;
  takvimHaftasi: string;
  // Hüküm karesinde başlık, ana sayfadaki rozetle aynı 360 ms'lik sönümü yapar.
  yanki?: boolean;
}) {
  if (!satirlar.length) return null;
  const id = `grup-${fiil}`;
  return (
    <section role="group" aria-labelledby={id} className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 mb-1.5 min-w-0">
        <h3
          id={id}
          className={`mono text-[11px] tracking-wider min-w-0${yanki ? " cx-yanki" : ""}`}
          style={{ color: renk, "--cx-hale": renk + "99" } as CSSProperties}
        >
          {baslik}
        </h3>
        <a
          href={href}
          className="mono text-[11px] text-txt-dim hover:text-neon rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon"
        >
          tümü &rarr;
        </a>
      </div>
      {altSatir && (
        <div className="mb-1.5 flex flex-wrap gap-x-2">
          <span className="mono text-[11px] text-txt-dim">{altSatir.a}</span>
          {altSatir.b && (
            <span className="mono text-[11px] text-txt-dim">{altSatir.b}</span>
          )}
        </div>
      )}
      <div className="space-y-1">
        {satirlar.map((r, i) => {
          const hf = gecikme[r.retailer] ?? 0;
          const a = ACT[r.action];
          // KIRPMA İKİ SAYIYLA: raporlanan adet BİRİNCİL kalır, düzeltilmiş sayı
          // onun yanında durur. Çıplak tahmin basmak, tedarikçi raporuyla
          // çelişen bir sayıyı asıl sayı gibi gösterirdi.
          const kirpildi = r.qtyHam != null && r.qtyHam > r.qty;
          return (
            <div
              key={i}
              className={`${i >= 2 ? "hidden sm:flex" : "flex"} flex-col sm:flex-row sm:items-center gap-x-2 gap-y-0.5 text-sm min-w-0`}
            >
              <div className="flex items-center gap-2 min-w-0 sm:flex-1">
                <Firma r={r.retailer} />
                <span className="truncate min-w-0">{r.sku_name}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:shrink-0 sm:justify-end pl-1 sm:pl-0 min-w-0">
                {/* ÇEK kovasında satırın GERÇEK fiili: depoya mı, likidasyona mı, transfer mi */}
                {CEK.includes(r.action) && a && (
                  <Rozet
                    metin={
                      a.kisa +
                      (r.action === "TRANSFER" && r.dest
                        ? `→${r.dest.retailer}`
                        : "")
                    }
                    renk={a.c}
                  />
                )}
                {/* Rapor gecikmesi SATIRIN KENDİSİNDE. EŞİK 2 HAFTA: medyan rapor
                    aralığı 1 hafta olduğu için eski `hf >= 1` eşiği ana sayfada
                    görünen 10 satırın 10'una rozet basıyordu — sinyal değeri sıfır.
                    Aynı gerekçe /api/stores'ta da yazılı (STALE_WEEKS = 2). */}
                {hf >= GECIKME_ROZET && (
                  <Rozet metin={`VERİ ${hf} HF ESKİ`} renk="#f8b00b" />
                )}
                {/* SEVK satırlarında value tasarım gereği 0 (sevk edilecek malın raf
                    değeri yok, henüz rafta değil) → "₺0" basmak bilgi değil gürültü.
                    Ölçümde üç kez tekrarlanan dizge olarak çıktı. */}
                {/* SEVK'in büyüklüğü raf değeri değil, yapılmazsa kaçacak NET satış. */}
                {r.action === "SEVK" && (r.etki8 ?? 0) > 0 && (
                  <span
                    className="mono text-[11px] tabular-nums"
                    style={{ color: renk }}
                  >
                    ~{fmtCompact(r.etki8!)}/8hf
                  </span>
                )}
                {r.noPrice ? (
                  <Rozet metin="FİYAT YOK" renk="#7d927d" />
                ) : r.value > 0 ? (
                  <span className="mono text-[11px] text-txt-dim tabular-nums">
                    {fmtCompact(r.value)}
                  </span>
                ) : null}
                {kirpildi && (
                  <span className="mono text-[11px] tabular-nums text-txt-dim">
                    {fmtInt(r.qtyHam!)} →
                  </span>
                )}
                <span
                  className="mono text-[11px] tabular-nums"
                  style={{ color: renk }}
                >
                  {fmtInt(r.qty)} ad
                </span>
                {/* "veri 07 Eyl 2026" ekranda görünen 10 satırın 10'unda aynı
                    dizgeydi; okunmayı bırakmıştı. Tarih artık YALNIZ sapmada
                    basılır: hafta takvim haftasıysa "güncel", değilse gerçek
                    tarih. Koşul TAM EŞİTLİK — 1 hafta geride olan satıra
                    "güncel" yazmak veri yaşını gizlerdi. */}
                {r.dataWeek && (
                  <span className="mono text-[11px] text-txt-dim">
                    veri {fmtHafta(r.dataWeek, takvimHaftasi)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {satirlar.length > 2 && (
          <div className="sm:hidden mono text-[11px] text-txt-dim">
            +{satirlar.length - 2} daha
          </div>
        )}
      </div>
    </section>
  );
}

// BU HAFTA işi (routing summary.buHafta) — bu bileşenin okuduğu alanlar.
type Is = {
  fiil: string;
  retailer: string;
  kaynak: string | null;
  sku_name: string;
  qty: number;
  etki8: number;
  sonTarih: string | null;
};

// BU HAFTA grubu: yönlendirme ekranının başındaki listenin ilk beşi. Satır yapısı
// Grup'la aynı (firma / ürün / sayılar ayrı yapraklar — sunum modu kısıtı).
function BuHafta({
  isler,
  asOf,
  yanki,
}: {
  isler: Is[];
  asOf: string | null;
  yanki?: boolean;
}) {
  const renk = "#1FF80B";
  return (
    <section role="group" aria-labelledby="grup-buhafta" className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 mb-1.5 min-w-0">
        <h3
          id="grup-buhafta"
          className={`mono text-[11px] tracking-wider min-w-0${yanki ? " cx-yanki" : ""}`}
          style={{ color: renk, "--cx-hale": renk + "99" } as CSSProperties}
        >
          BU HAFTA — gönder
        </h3>
        <a
          href="/yonlendirme?mode=denge"
          className="mono text-[11px] text-txt-dim hover:text-neon rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon"
        >
          tümü &rarr;
        </a>
      </div>
      <div className="space-y-1">
        {isler.map((b, i) => {
          const hemen =
            b.sonTarih != null && asOf != null && b.sonTarih <= asOf;
          return (
            <div
              key={i}
              className={`${i >= 3 ? "hidden sm:flex" : "flex"} flex-col sm:flex-row sm:items-center gap-x-2 gap-y-0.5 text-sm min-w-0`}
            >
              <div className="flex items-center gap-2 min-w-0 sm:flex-1">
                <Firma r={b.retailer} />
                <span className="truncate min-w-0">{b.sku_name}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:shrink-0 sm:justify-end pl-1 sm:pl-0 min-w-0">
                {b.kaynak && (
                  <Rozet metin={`${b.kaynak} fazlasından`} renk="#0bd1f8" />
                )}
                {b.fiil === "DAĞIT" && (
                  <Rozet metin="D&R deposundan" renk="#0bd1f8" />
                )}
                <span
                  className="mono text-[11px] tabular-nums"
                  style={{ color: renk }}
                >
                  {fmtInt(b.qty)} ad
                </span>
                {b.etki8 > 0 && (
                  <span className="mono text-[11px] tabular-nums text-txt-dim">
                    ~{fmtCompact(b.etki8)}/8hf
                  </span>
                )}
                {b.sonTarih && (
                  <span
                    className="mono text-[11px]"
                    style={{ color: hemen ? "#ff5555" : "#f8b00b" }}
                  >
                    {hemen ? "hemen" : fmtDate(b.sonTarih)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {isler.length > 3 && (
          <div className="sm:hidden mono text-[11px] text-txt-dim">
            +{isler.length - 3} daha
          </div>
        )}
      </div>
    </section>
  );
}

// VERİYİ KENDİ ÇEKMEZ: routing ucu ~4 sn sürüyor ve ana sayfa BANT 1 (hüküm) ile
// BANT 2 (kartlar) için aynı yanıta zaten ihtiyaç duyuyor. Bileşen kendi fetch'ini
// yapsaydı aynı ağır uç iki kez çağrılırdı.
export function Kararlar({
  d,
  hata,
  gecikme,
  takvimHaftasi,
  yanki,
}: {
  d: { routes: Route[]; summary: any } | null;
  hata: boolean;
  gecikme: Record<string, number>;
  takvimHaftasi: string;
  // Hükmün fiili — yalnız imza karesinde verilir (bkz. page.tsx hukumAtesi).
  yanki?: "teyit" | "sevk" | "cek";
}) {
  if (hata) {
    return (
      <div className="card card-flat p-3">
        <div className="mono text-xs text-amber-400">
          KARAR MOTORU YANIT VERMEDİ
        </div>
        <a
          href="/yonlendirme"
          className="mono text-[11px] neon-text rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon"
        >
          yönlendirme sayfasına git &rarr;
        </a>
      </div>
    );
  }
  if (!d) {
    // İskelet. "Yapılacak iş yok" ASLA basılmaz — motor hâlâ çalışıyor olabilir.
    return (
      <div className="card card-flat p-3">
        <div className="mono text-[11px] text-txt-dim tracking-wider mb-2">
          KARAR MOTORU ÇALIŞIYOR…
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[0, 1].map((k) => (
            <div key={k} className="space-y-1">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-5 rounded bg-ink-2" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const R = d.routes;
  const s = d.summary ?? {};
  const al = (act: string, n: number) =>
    R.filter((r) => r.action === act)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, n);

  const teyit = al("TEYİT", 2);
  // SEVK etkiye göre (2026-10-29): adede göre sıralanınca 4.000 adetlik yavaş
  // kalem, rafı boşalmış hızlı kalemin önüne geçiyordu.
  const sevk = R.filter((r) => r.action === "SEVK")
    .sort((a, b) => (b.etki8 ?? 0) - (a.etki8 ?? 0) || b.qty - a.qty)
    .slice(0, 3);
  // BU HAFTA (motorun summary.buHafta'sı): aciliyet + 8 hf etkiyle sıralı, aynı
  // ürünün aktar+gönder parçaları tek iş. Varsa SEVK grubunun yerini alır.
  const buHafta: Is[] = (s?.buHafta ?? []).slice(0, 5);
  // ÇEK 3 satır: 29.10'dan beri yalnız ölü ya da 26 haftayı aşan stok çekiliyor;
  // ana sayfada yapılacak işlerin önüne geçecek büyüklükte bir kova değil.
  const cek = R.filter((r) => CEK.includes(r.action))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  // Likidasyon ÇEK içinde eriyip kaybolmasın: geri alınamaz bir para kararı.
  const likN =
    s?.likidasyon?.n ?? R.filter((r) => r.action === "LIKIDASYON").length;
  const likPsf =
    s?.likidasyon?.psf ??
    R.filter((r) => r.action === "LIKIDASYON").reduce(
      (a, r) => a + (r.value || 0),
      0,
    );

  // ── LİKİDASYONUN NİYE DÜŞTÜĞÜ ──
  // Kanıt kapısı ve askı devreye girince tasfiye kalemi 239'dan 198'e indi. Bu
  // düşüş ekranda gerekçesiz kalırsa "sorun çözüldü" diye okunur; oysa mal hâlâ
  // rafta, yalnız indirimle yok edilmiyor. Üç bileşen de summary'den TÜRETİLİR
  // (elle yazılmaz), yoksa sayılar bir gün ayrışır.
  const kapi = s?.likidasyonKapisi;
  const eritN = kapi?.erit?.eritN ?? s?.erit?.n ?? 0;
  const sevkeDonenN = kapi?.erit?.sevkeDonenN ?? 0;
  const askidaN = s?.veri?.askida?.n ?? 0;
  const korunanPsf =
    (kapi?.erit?.rafPsf ?? 0) + (kapi?.kismi?.geriBirakilanPsf ?? 0);

  if (!teyit.length && !sevk.length && !cek.length && !buHafta.length) {
    return (
      <div className="card card-flat p-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mono text-xs text-txt-dim">
          Bu hafta eşiği aşan kalem yok.
        </span>
        <a
          href="/yonlendirme?mode=denge"
          className="mono text-[11px] neon-text rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon"
        >
          tüm liste &rarr;
        </a>
      </div>
    );
  }

  return (
    <div className="card card-flat p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 mb-2">
        <h2 className="mono text-[11px] text-txt-dim tracking-wider">
          BUGÜN YAPILACAKLAR
        </h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          {/* Senaryo damgası: MODE_MULT (koruma 1,3 / denge 1,0 / agresif 0,7) doğrudan
              hedef stoğu çarpar, yani buradaki HER sayı bir senaryonun çıktısıdır. */}
          <Rozet metin={s?.modeLabel ?? "Dengeli senaryo"} renk="#7d927d" />
          <span className="mono text-[11px] text-txt-dim">
            her firmanın son raporu
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-5 gap-y-3">
        <div className="space-y-3 min-w-0">
          <Grup
            baslik="TEYİT AL — telefon edilecek"
            fiil="teyit"
            renk="#c084fc"
            satirlar={teyit}
            href="/yonlendirme?mode=denge&a=TEY%C4%B0T"
            gecikme={gecikme}
            takvimHaftasi={takvimHaftasi}
            yanki={yanki === "teyit"}
          />
          {buHafta.length > 0 ? (
            <BuHafta
              isler={buHafta}
              asOf={s?.veri?.asOf ?? null}
              yanki={yanki === "sevk"}
            />
          ) : (
            <Grup
              baslik="SEVK ET — raf boşalıyor"
              fiil="sevk"
              renk="#1FF80B"
              satirlar={sevk}
              href="/yonlendirme?mode=denge&a=SEVK"
              gecikme={gecikme}
              takvimHaftasi={takvimHaftasi}
              yanki={yanki === "sevk"}
            />
          )}
        </div>
        <div className="min-w-0 space-y-1.5">
          <Grup
            baslik="ÇEK — ölü ya da 26 haftayı aşan stok"
            fiil="cek"
            renk="#f8b00b"
            satirlar={cek}
            href="/yonlendirme?mode=denge&a=cek"
            gecikme={gecikme}
            takvimHaftasi={takvimHaftasi}
            yanki={yanki === "cek"}
            altSatir={
              likN > 0
                ? {
                    a: `içinde ${fmtInt(likN)} likidasyon`,
                    b: fmtCompact(likPsf),
                  }
                : undefined
            }
          />
          {(eritN > 0 || askidaN > 0 || sevkeDonenN > 0) && (
            <div className="flex flex-wrap items-baseline gap-x-2 pt-1 border-t border-line/60">
              <span className="mono text-[11px] text-txt-dim">
                tasfiyeden çıkan:
              </span>
              {eritN > 0 && (
                <a
                  href="/yonlendirme?mode=denge&a=ERIT"
                  className="mono text-[11px] rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon"
                  style={{ color: ACT.ERIT.c }}
                >
                  {fmtInt(eritN)} hâlâ satıyor
                </a>
              )}
              {sevkeDonenN > 0 && (
                <span
                  className="mono text-[11px]"
                  style={{ color: ACT.SEVK.c }}
                >
                  {fmtInt(sevkeDonenN)} sevke döndü
                </span>
              )}
              {askidaN > 0 && (
                <a
                  href="/yonlendirme?mode=denge&a=ASKIDA"
                  className="mono text-[11px] rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon"
                  style={{ color: ACT.ASKIDA.c }}
                >
                  {fmtInt(askidaN)} rapor bekliyor
                </a>
              )}
              {korunanPsf > 0 && (
                <span className="mono text-[11px] tabular-nums text-txt-dim">
                  {fmtCompact(korunanPsf)} raf değeri korundu
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
