"use client";

// ═══════════════════════ KANAL ŞERİDİ ═══════════════════════
//
// Ana sayfada trend grafiğinin HEMEN ÜSTÜNDE duran beş kart. Grafik "ağ zaman
// içinde ne yaptı" sorusunu cevaplıyor; bu şerit onun altyazısı: hangi kanalın
// verisi güncel, hangi kanal adet ve TL olarak ne yaptı.
//
// NEDEN KURULDU: aynı bilgi eskiden ana sayfada İKİ ayrı bantta duruyordu —
// "VERİ DURUMU" (tarihler + gecikme) ve "FİRMA BAZINDA HAFTALIK DEĞİŞİM"
// (yüzdeler). İkisi farklı kaynaklardan besleniyor, farklı sırada diziliyor ve
// aynı kanal için iki ayrı hikâye anlatıyordu. Tek kart hepsini taşır.
//
// EN ÖNEMLİ KURAL — BAYAT KANALDA HÜKÜM RENGİ YOK:
// Verisi 2+ hafta geride kalan kanalın yüzdesi YEŞİL/KIRMIZI basılmaz. Rakam
// yanlış değil; yanlış olan onu bugünün sinyaliymiş gibi sunmak. Bayat kartın
// yüzdesi nötr gridir ve altında hangi iki haftanın kıyaslandığı yazar.
// Sistemdeki şikâyet tam buydu: veri ne olursa olsun yorum üretiliyordu.
//
// İKİ AYRI EŞİK, KARIŞTIRILMAZ — denetimde yakalanan hata buydu:
//   "GÜNCEL" (durum satırı)  → gecikmeHf === 0, TAM EŞİTLİK. 1 hafta geride olan
//       kanal güncel DEĞİLDİR ve tarihini gösterir. Eskiden rozet `gecikmeHf < 2`
//       olan her kanala "GÜNCEL" basıyordu; 31 Ağustos verisi 7 Eylül'ünkiyle
//       aynı tazelikte görünüyordu.
//   `bayat` (renk kapısı)    → gecikmeHf >= 2, yüzdenin yorumlanabilirlik eşiği.
// Biri "tarihi yazayım mı", diğeri "hüküm vereyim mi" sorusunu cevaplar.
//
// TARİH TEKRARI: aynı kartta tarih EN FAZLA BİR KEZ geçer. Durum satırı tarihi
// taşır; kıyas satırı tarih değil MESAFE yazar ("bir önceki haftaya göre"),
// çünkü orada sorulan şey "hangi iki tarih" değil "neye göre".

import Link from "next/link";
import { fmtInt, fmtMoney, fmtDate, colorOf } from "@/lib/format";
import { kanalAdi, slugOf, type KanalOzet } from "@/lib/kanal";
import { FlipIzgara } from "@/components/hareket/FlipIzgara";

const YESIL = "#1FF80B";
const KIRMIZI = "#ff5555";
const AMBER = "#f8b00b";
const NOTR = "#7d927d";

// İşaretsiz büyüklük — yön zaten ▲/▼ ile veriliyor.
const buyukluk = (n: number) => `${Math.abs(n).toFixed(1).replace(".", ",")}%`;

function Oran({ deger, bayat, etiket }: { deger: number | null; bayat: boolean; etiket: string }) {
  if (deger == null) {
    return (
      <div className="flex items-baseline gap-1">
        <span className="mono text-[10px] text-txt-dim tracking-wider">{etiket}</span>
        <span className="mono text-[11px] text-txt-dim">kıyas yok</span>
      </div>
    );
  }
  // Bayat kanalda renk NÖTR — bkz. dosya başındaki kural. Kapı `bayat` (2+ hafta),
  // `guncel` DEĞİL: 1 hafta geride olan kanalın yüzdesi hâlâ okunabilir bir sinyal,
  // gri basmak onu gereksizce sessizleştirirdi.
  const renk = bayat ? NOTR : deger >= 0 ? YESIL : KIRMIZI;
  return (
    <div className="flex items-baseline gap-1">
      <span className="mono text-[10px] text-txt-dim tracking-wider">{etiket}</span>
      <span className="mono text-sm tabular-nums" style={{ color: renk }}>
        {deger >= 0 ? "▲" : "▼"} {buyukluk(deger)}
      </span>
    </div>
  );
}

function Kart({ o, takvimHaftasi }: { o: KanalOzet; takvimHaftasi: string }) {
  const renk = colorOf(o.retailer);
  const veriYok = o.dataWeek == null;
  // DURUM SATIRI — kartın tek tarih taşıyan yeri.
  //
  // "GÜNCEL" TAKVİME ÇAPALIDIR, gecikmeHf'e DEĞİL. gecikmeHf `referansHafta`ya
  // göre ölçülüyor ve referans, hafta seçicisinden geçmiş bir hafta seçilince
  // O HAFTAYA kayıyor; koşul gecikmeHf===0 olsaydı 10 Ağustos seçili iken o
  // haftayı raporlamış her kanal yeşil "güncel" basardı. (Denetimde üç ayrı
  // mercek bağımsız olarak buldu; dosyanın kendi notu da bunu söylüyordu.)
  //   takvim haftası → "güncel" (yeşil; tarih yok, çapa şerit başlığında)
  //   1 hf geride    → "31 Ağu 2026 · 1 hf geride" (nötr: normal kadans, alarm değil)
  //   2+ hf geride   → aynısı AMBER (yorum kapısı kapanır)
  //   geçmiş hafta seçili → yalnız tarih, hüküm yok
  const durum = veriYok
    ? { m: "veri yok", c: AMBER }
    : o.dataWeek === takvimHaftasi
      ? { m: "güncel", c: YESIL }
      : { m: `${fmtDate(o.dataWeek!)}${o.gecikmeHf > 0 ? ` · ${o.gecikmeHf} hf geride` : ""}`,
          c: o.bayat ? AMBER : NOTR };

  // KIYAS KÜNYESİ — tarih değil MESAFE. "31 Ağu ↔ 07 Eyl" okuyucuya iki tarihi
  // çıkarıp fark aldırıyordu; mesafe zaten sorulan şey. Mesafe 1'den büyükse
  // (firma hafta atlamış) sol uç tarihiyle yazılır, çünkü orası artık haberdir.
  const kunye = o.prevWeek == null || o.araHafta == null
    ? "tek haftalık veri · kıyas yok"
    : o.araHafta === 1
      ? "bir önceki haftaya göre"
      : `${o.araHafta} hafta öncesine göre · ${fmtDate(o.prevWeek)}`;

  return (
    <Link
      href={`/kanal/${slugOf(o.retailer)}`}
      data-flip={o.retailer}
      className="card card-flat p-3 block hover:border-neon/40 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon"
      style={o.bayat && !veriYok ? { borderColor: AMBER + "40" } : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="mono text-[12px] font-bold truncate" style={{ color: renk }}>
          {kanalAdi(o.retailer)}
        </span>
      </div>
      {/* Durum + tarih TEK SATIRDA. Ayrı rozet + ayrı tarih satırı aynı şeyi iki
          kez söylüyordu; birleşince hem tekrar gitti hem 1 haftalık gecikme
          "GÜNCEL" diye yuvarlanmaktan kurtuldu. */}
      <div className="mono text-[11px] mt-0.5" style={{ color: durum.c }}>{durum.m}</div>

      {veriYok ? (
        /* "Hiç rapor gelmedi" DEĞİL: kanallar farklı tarihlerde başlıyor ve
           özet seçili haftaya kadar kırpılıyor, yani erken bir hafta seçilince
           bu dal "o tarihte henüz başlamamıştı" anlamına da geliyor. */
        <div className="mono text-[11px] text-txt-dim mt-2">Seçili haftaya kadar bu kanaldan rapor yok.</div>
      ) : (
        <>
          <div className="mt-2 space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="mono text-sm tabular-nums truncate">
                {o.net == null ? "—" : fmtMoney(o.net)}
              </span>
              <Oran deger={o.netWow} bayat={o.bayat} etiket="TL" />
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="mono text-[11px] tabular-nums text-txt-dim truncate">
                {fmtInt(o.adet)} adet
              </span>
              <Oran deger={o.adetWow} bayat={o.bayat} etiket="AD" />
            </div>
          </div>

          {/* KIYASIN KÜNYESİ — bkz. `kunye`. "geçen hafta" demek yalan olabilir:
              firmalar hafta atlıyor, iki rapor arası 2-3 hafta olabiliyor. */}
          <div className="mono text-[10px] text-txt-dim mt-2 pt-1.5 border-t border-line/60">
            {kunye}
          </div>
          {o.bayat && o.prevWeek != null && (
            <div className="mono text-[10px] mt-0.5" style={{ color: AMBER }}>
              Bu oran bugünün değil, kanalın kendi son iki haftasının kıyası.
            </div>
          )}
        </>
      )}
    </Link>
  );
}

export function KanalSeridi({
  ozetler, referansHafta, takvimHaftasi, notlar,
}: {
  ozetler: KanalOzet[];
  referansHafta: string;
  // TAKVİM haftası — "güncel" kelimesinin çapası. referansHafta geçmiş bir hafta
  // seçilince o haftaya kayar; "güncel" ASLA ona bağlanmaz, yoksa Ağustos'a bakan
  // kullanıcıya Ağustos verisi "güncel" diye yazılırdı (denetimde yakalandı).
  takvimHaftasi: string;
  notlar?: React.ReactNode;
}) {
  // GÜNCEL OLANLAR ÖNCE. Sıralama ciroya göre yapılmıyor: bu şeridin işi
  // "kim büyük" değil, "neye güvenebilirim" sorusunu cevaplamak.
  const sirali = [...ozetler].sort(
    (a, b) => (a.gecikmeHf ?? 99) - (b.gecikmeHf ?? 99) || (b.net ?? 0) - (a.net ?? 0)
  );
  const bayat = sirali.filter((o) => o.bayat);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="mono text-[11px] text-txt-dim tracking-wider">KANALLAR</span>
        <span className="mono text-[11px] text-txt-dim">
          her kanal KENDİ son iki haftasını kıyaslar · karar haftası {fmtDate(referansHafta)}
        </span>
        {bayat.length > 0 && (
          <span className="mono text-[11px]" style={{ color: AMBER }}>
            {bayat.map((o) => kanalAdi(o.retailer)).join(", ")} güncel değil
          </span>
        )}
      </div>
      {/* Sıra tazelik öncelikli. Hafta değişince bir kanal öne geçer ya da geriye
          düşerse kartlar eski yerinden yenisine 180 ms kayar; sayılar ve çerçeve
          aynı karede yeni değerini alır. Aynı sıra hiçbir hareket üretmez. */}
      <FlipIzgara imza={sirali.map((o) => o.retailer).join("|")}
        className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
        {sirali.map((o) => <Kart key={o.retailer} o={o} takvimHaftasi={takvimHaftasi} />)}
      </FlipIzgara>
      {notlar}
    </div>
  );
}
