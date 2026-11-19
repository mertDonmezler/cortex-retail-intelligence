import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";
import { RETAILERS } from "@/lib/normalizers/types";
import { isWeek, isRetailer, badRequest, optionalWeek } from "@/lib/params";

export const runtime = "nodejs";
export const revalidate = 0;
// Vercel varsayılanı 10 sn; matview soğukken iki haftalık özet okuması bunu
// zorlayabiliyor. Ağır route'lar 60 kullanıyor, buna 30 yeterli.
export const maxDuration = 30;

// Haftalık durum mailini hazır metin olarak üretir (dashboard "Haftalık Mail"
// butonu). HER HAFTA AYNI İSKELET çıkar — bölümler sabit, sıra sabit; söyleyecek
// bir şeyi olmayan bölüm düşer, yerine başka bir şey gelmez:
//
//   SATIŞ            kanal başına net kazanç + adet + kendi WoW'u, ciroya göre
//   BU HAFTA         motorun kararı (sevk / çek / raf kapsamı)
//   VERİ DURUMU      kim raporlamadı, kaç hafta geride, hangi haftalar bekleniyor
//
// KURALLAR:
//  • tablo NET kazanç (netFactor) ve adet; duran stok BRÜT PSF, ikisi toplanmaz;
//  • WoW yalnız İKİ HAFTADA DA verisi olan firmalar üzerinden (elmayla elma —
//    eksik firma toplam büyümeyi çarpıtmasın);
//  • RAPORLAMAYAN FİRMA TABLODA YOKTUR. Ayrı bir bölümde, kaç hafta geride
//    olduğu ve hangi haftaların beklendiğiyle birlikte yazılır. "Bu hafta
//    göndermedi" (1 hafta, olağan kadans) ile "N haftadır göndermiyor" (kronik)
//    iki ayrı cümledir; ikisini aynı şekilde yazmak kronik boşluğu normalleştirir.
//
// MOTOR ÖZETİ İSTEMCİDEN GELİR (POST gövdesi). Ana sayfa /api/routing yanıtını
// zaten yüklüyor; aynı 977 satırlık motoru mail için ikinci kez çalıştırmak ya da
// mantığını burada kopyalamak yerine hazır özet taşınıyor. Özet yoksa BU HAFTA
// bölümü sessizce düşer, mailin kalanı çalışır.
const AY = [
  "",
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];

function trRange(startIso: string, endIso: string): string {
  const s = new Date(startIso + "T00:00:00Z");
  const e = new Date(endIso + "T00:00:00Z");
  const sm = AY[s.getUTCMonth() + 1],
    em = AY[e.getUTCMonth() + 1];
  return sm === em
    ? `${s.getUTCDate()}-${e.getUTCDate()} ${em}`
    : `${s.getUTCDate()} ${sm}-${e.getUTCDate()} ${em}`;
}

const TL = (n: number) => Math.round(n).toLocaleString("tr-TR");
// Büyük tutar: mailde 34.437.020 okunmuyor, "34,4 mn" okunuyor. Eşik 1 milyon.
const TLk = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? (n / 1_000_000).toFixed(1).replace(".", ",") + " mn"
    : TL(n);
// Ondalık: Türkçe metinde virgül.
const ond = (n: number, basamak = 1) => n.toFixed(basamak).replace(".", ",");
// Uzun cümleyi mail genişliğinde sarmalar. Tek uzun satır mail istemcisinde
// rastgele yerden kırılıyor ve hizalı bloğun yanında dağınık duruyor.
const sar = (metin: string, en = 78): string[] => {
  const out: string[] = [];
  let sat = "";
  for (const k of metin.split(" ")) {
    if (sat && (sat + " " + k).length > en) {
      out.push(sat);
      sat = k;
    } else sat = sat ? sat + " " + k : k;
  }
  if (sat) out.push(sat);
  return out;
};
// "2026-08-10" → "10 Ağustos". Mailde ISO tarih okunmaz.
const trGun = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()} ${AY[d.getUTCMonth() + 1]}`;
};
const pct = (cur: number, prev: number) =>
  prev > 0 ? ((cur - prev) / prev) * 100 : 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  return uret(searchParams.get("week"), null);
}

// Motor özeti gövdede gelir; içeriği yalnız OKUNUR, hiçbir yere yazılmaz.
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  let ozet: any = null;
  try {
    ozet = (await req.json())?.ozet ?? null;
  } catch {
    /* gövdesiz POST da geçerli */
  }
  return uret(searchParams.get("week"), ozet);
}

async function uret(week: string | null, ozet: any) {
  // Yalnız biçim değil TAKVİM kontrolü: "2026-99-99" regex'ten geçip 500 üretiyordu.
  if (!isWeek(week))
    return badRequest("week gerekli ve geçerli tarih olmalı (YYYY-MM-DD)");
  try {
    const prevWeek = new Date(week + "T00:00:00Z");
    prevWeek.setUTCDate(prevWeek.getUTCDate() - 7);
    const prevIso = prevWeek.toISOString().slice(0, 10);
    const endIso = (() => {
      const d = new Date(week + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 6);
      return d.toISOString().slice(0, 10);
    })();

    const { data, error } = await supabase
      .from("weekly_summary")
      .select("retailer, week_start, sales_qty, sales_value")
      .in("week_start", [week, prevIso]);
    if (error) throw error;

    type Agg = { net: number; qty: number };
    const cur = new Map<string, Agg>(),
      prev = new Map<string, Agg>();
    for (const r of data ?? []) {
      const net = Number(r.sales_value ?? 0) * netFactor(r.retailer);
      const agg = { net, qty: Number(r.sales_qty) };
      if (r.week_start === week) cur.set(r.retailer, agg);
      else prev.set(r.retailer, agg);
    }
    if (cur.size === 0) {
      return NextResponse.json(
        { error: "Bu hafta için veri yok" },
        { status: 404 },
      );
    }

    const rows = [...cur.entries()].sort((a, b) => b[1].net - a[1].net);
    const missing = RETAILERS.filter((r) => !cur.has(r));
    const totNet = rows.reduce((a, [, v]) => a + v.net, 0);
    const totQty = rows.reduce((a, [, v]) => a + v.qty, 0);

    // WoW — yalnız iki haftada da olan firmalar (elmayla elma).
    const both = rows.filter(([r]) => prev.has(r));
    const curB = both.reduce((a, [, v]) => a + v.net, 0);
    const prevB = both.reduce((a, [r]) => a + prev.get(r)!.net, 0);
    const wow = both.length >= 2 && prevB > 0 ? pct(curB, prevB) : null;
    const movers = both
      .map(([r, v]) => ({ r, d: pct(v.net, prev.get(r)!.net) }))
      .filter((m) => isFinite(m.d))
      .sort((a, b) => b.d - a.d);

    const range = trRange(week, endIso);
    const tamKadro = missing.length === 0;
    const isim = (r: string) => (r === "DR" ? "D&R" : r);
    // "A, B ve C" — Türkçe doğal listeleme (tek öğede olduğu gibi).
    const listTr = (a: string[]) =>
      a.length <= 1
        ? (a[0] ?? "")
        : `${a.slice(0, -1).join(", ")} ve ${a[a.length - 1]}`;

    // ── Metin ────────────────────────────────────────────────────────────────
    // Sabit iskelet: MANŞET → KANALLAR → okuma cümlesi → İŞ LİSTESİ → VERİ →
    // birim notu → imza. Söyleyecek şeyi olmayan bölüm düşer, yerine başka bir
    // şey gelmez; 52 hafta boyunca aynı sırayla üretilir.
    const L: string[] = [];
    L.push(
      `Konu: Mythos Haftalık | ${range} | ${TL(totNet)} TL net, ${TL(totQty)} adet` +
        (wow != null ? ` (${wow >= 0 ? "+" : "-"}%${ond(Math.abs(wow))})` : ""),
    );
    L.push("");
    L.push("Merhaba,");
    L.push("");
    L.push(
      `${range} haftası kapandı. Ağ geneli` +
        (tamKadro
          ? " (5 firma):"
          : ` (${rows.length} firma, ${missing.map(isim).join(" ve ")} hariç):`),
    );
    L.push("");
    L.push(
      `    ${TL(totNet)} TL net kazanç  ·  ${TL(totQty)} adet` +
        (wow != null
          ? `  ·  önceki haftaya göre ${wow >= 0 ? "+" : "-"}%${ond(Math.abs(wow))}`
          : ""),
    );
    L.push("");

    // ── KANALLAR ──
    L.push("KANALLAR");
    const adW = Math.max(...rows.map(([r]) => isim(r).length), 6);
    const tlW = Math.max(
      ...rows.map(([, v]) => TL(v.net).length),
      TL(totNet).length,
    );
    const adetW = Math.max(
      ...rows.map(([, v]) => TL(v.qty).length),
      TL(totQty).length,
    );
    const satir = (ad: string, net: number, qty: number, d: number | null) =>
      `    ${ad.padEnd(adW)}  ${TL(net).padStart(tlW)} TL   ${TL(qty).padStart(adetW)} adet` +
      (d == null
        ? ""
        : `   ${(d >= 0 ? "+" : "-") + "%" + ond(Math.abs(d))}`.padStart(10));
    for (const [r, v] of rows) {
      const pv = prev.get(r);
      L.push(
        satir(
          isim(r),
          v.net,
          v.qty,
          pv && pv.net > 0 ? pct(v.net, pv.net) : null,
        ),
      );
    }
    L.push("    " + "-".repeat(adW + tlW + adetW + 22));
    L.push(satir("TOPLAM", totNet, totQty, wow));
    L.push("");

    // ── OKUMA CÜMLESİ — mekanik, tablodan doğrudan çıkar. ──
    // Uç durumlar bilinçli: hepsi büyüdüğünde "iki kanal daraldı" demek, tek
    // kanal kaldığında "en güçlü/en zayıf" demek yalan olurdu.
    const kiyasli = rows.filter(([r]) => {
      const pv = prev.get(r);
      return pv && pv.net > 0;
    });
    if (kiyasli.length >= 2) {
      const artan = kiyasli
        .filter(([r, v]) => pct(v.net, prev.get(r)!.net) > 0)
        .map(([r]) => isim(r));
      const azalan = kiyasli
        .filter(([r, v]) => pct(v.net, prev.get(r)!.net) < 0)
        .map(([r]) => isim(r));
      const enTl = rows[0] ? isim(rows[0][0]) : null;
      const enAdet = [...rows].sort((a, b) => b[1].qty - a[1].qty)[0];
      const c: string[] = [];
      if (artan.length && azalan.length) {
        c.push(
          `${artan.length} kanal büyüdü (${artan.join(", ")}), ${azalan.length} kanal daraldı (${azalan.join(", ")}).`,
        );
      } else if (artan.length) {
        c.push(`${artan.length} kanalın hepsi büyüdü.`);
      } else if (azalan.length) {
        c.push(`${azalan.length} kanalın hepsi daraldı.`);
      }
      if (enTl && enAdet && isim(enAdet[0]) !== enTl) {
        c.push(`Net kazançta ${enTl}, adette ${isim(enAdet[0])} önde.`);
      } else if (enTl) {
        c.push(`Hem net kazançta hem adette ${enTl} önde.`);
      }
      if (c.length) {
        L.push(...sar(c.join(" "), 78));
        L.push("");
      }
    }

    // ── İŞ LİSTESİ — yalnız GERÇEK eylemler numaralanır. ──
    // Raf kapsamı bir eylem değil, bir durum: numarasız bağlam satırı olarak
    // altta durur. "Rapor iste" ise gerçek bir iştir ve listeye girer.
    const sv = ozet?.sevkKritik ?? ozet?.sevk;
    const ck = ozet?.cek;
    const kp = ozet?.kapsam;
    const veriByRet: any[] = ozet?.veri?.byRetailer ?? [];
    const gecikenler = missing
      .map((r) => ({ r, v: veriByRet.find((x: any) => x.retailer === r) }))
      .filter((x) => (x.v?.gecikmeHf ?? 0) >= 2);

    const isler: string[] = [];
    const et = (x: string) => x.padEnd(11);
    // Bu hafta listesi varsa sevk satırı ONA bağlanır: eski ölçüt (kapsam ≤2 hf)
    // aynı mailde "4 kalem / 1.369 TL" ile listenin "8 kalem / 328 bin TL"sini
    // yan yana basıyordu.
    const bhSevk: any[] = Array.isArray(ozet?.buHafta) ? ozet.buHafta : [];
    if (bhSevk.length)
      isler.push(
        `${et("Sevk et")}${String(bhSevk.length).padStart(4)} kalem  - 8 haftada ~${TL(ozet?.raf?.buHaftaEtki8 ?? 0)} TL net satış (liste aşağıda)`,
      );
    else if (sv?.n > 0)
      isler.push(
        `${et("Sevk et")}${String(sv.n).padStart(4)} kalem  - haftalık ${TL(sv.haftalikNet ?? 0)} TL net karşılık`,
      );
    if (ck?.n > 0)
      isler.push(
        `${et("Raftan çek")}${String(ck.n).padStart(4)} kalem  - ${TLk(ck.psf ?? 0)} TL raf değeri bağlı (brüt PSF)`,
      );
    if (gecikenler.length)
      isler.push(
        `${et("Rapor iste")} ${gecikenler.map((x) => isim(x.r)).join(", ")} — bekleyen haftalar aşağıda`,
      );
    if (isler.length) {
      L.push("CORTEX İŞ LİSTESİ");
      isler.forEach((x, i) => L.push(`  ${i + 1}  ${x}`));
      if (kp?.hafta != null) {
        L.push(
          `     Raf kapsamı ${ond(Number(kp.hafta))} hafta · motorun hedef eşiği ${kp.esik ?? 8} hafta.`,
        );
      }
      L.push("");
    }

    // ── BU HAFTA YAPILACAKLAR (2026-10-29) ──
    // Yönlendirme ekranının başındaki listenin aynısı (motor sıralayıp gönderiyor:
    // önce son tarihi bu hafta olanlar, sonra 8 haftalık NET etki). Mail eskiden
    // yalnız "Sevk et N kalem" diyordu; hangi ürünün nereye kaç adet gideceği yoktu.
    // Kanal adına ek getirilmez ("D&R'a / Huppaluppo'ya" ek adla değişir).
    const bh: any[] = Array.isArray(ozet?.buHafta) ? ozet.buHafta : [];
    if (bh.length) {
      const asOf: string | null = ozet?.veri?.asOf ?? null;
      const gun = (iso: string) =>
        new Date(iso + "T12:00:00Z").toLocaleDateString("tr-TR", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        });
      L.push(
        `BU HAFTA YAPILACAKLAR — 8 haftada ~${TL(ozet?.raf?.buHaftaEtki8 ?? 0)} TL net satış`,
      );
      bh.forEach((b) => {
        const ne =
          b.sonTarih == null
            ? ""
            : asOf != null && b.sonTarih <= asOf
              ? " · hemen"
              : ` · en geç ${gun(b.sonTarih)}`;
        L.push(
          `  ${String(b.sira).padStart(2)}  ${b.fiil} · ${isim(b.retailer)} · ${TL(b.qty)} adet · ${b.sku_name}`,
        );
        sar(`${b.gerekce}${ne} · ~${TL(b.etki8 ?? 0)} TL net`, 72).forEach(
          (s) => L.push(`      ${s}`),
        );
      });
      if (bh.some((b) => b.depoNotu)) {
        L.push(
          "      D&R maddeleri: D&R deposu görünmüyor; depoda mal varsa önce mağazalara dağıtılması yeter.",
        );
      }
      L.push("");
    }

    // ── VERİ DURUMU ──
    // Raporlamayan firma yukarıdaki tabloda YOK. "Bu hafta göndermedi" (olağan
    // kadans) ile "N haftadır göndermiyor" (kronik) iki ayrı cümledir.
    if (tamKadro) {
      L.push("VERİ DURUMU");
      L.push("    Beş firma da bu haftanın verisini gönderdi.");
      L.push("");
    } else {
      for (const r of missing) {
        const v = veriByRet.find((x: any) => x.retailer === r);
        const hf = v?.gecikmeHf;
        if (hf != null && hf >= 2) {
          // toUpperCase() Türkçe'de "Nezih" → "NEZIH" yapar (noktalı İ kaybolur);
          // locale'li sürüm "NEZİH" verir. margins.ts'teki katlama hatasının aynası.
          L.push(
            `${isim(r).toLocaleUpperCase("tr")} - VERİ YOK (satış düşüşü değil, rapor gelmiyor)`,
          );
          L.push(
            `    Elimizdeki son veri ${trGun(v.dataWeek)}; ${hf} haftadır dosya gelmedi.`,
          );
          if (v?.eksikHaftalar?.length) {
            L.push(
              `    Bekleyen haftalar: ${v.eksikHaftalar.map(trGun).join(", ")}.`,
            );
          }
          if (v?.askida?.n > 0) {
            L.push(
              `    Bu süre boyunca ${isim(r)}'in ${TL(v.askida.n)} kalemi / ${TL(v.askida.qty)} adedi hiçbir karara girmiyor.`,
            );
          }
          L.push(
            `    Yukarıdaki toplamlar ${isim(r)}'siz; performansı hakkında bu tabloda hüküm yok.`,
          );
        } else {
          L.push("VERİ DURUMU");
          L.push(
            `    ${isim(r)} bu haftanın verisini henüz göndermedi; geldiğinde tablo güncellenir.`,
          );
        }
        L.push("");
      }
    }

    // ── Kalıcı birim notu. İki birim her hafta karışma riski taşıyor. ──
    L.push(
      ...sar(
        "Not: net kazanç = raf fiyatı x (1 - kanal marjı) / 1,20, yani bize kalan tutar." +
          (ck?.n > 0
            ? " Raf değeri brüt PSF'tir; farklı bir birimdir, net kazançla toplanmaz."
            : ""),
        78,
      ),
    );
    L.push("");
    L.push(
      "Bu özet her hafta, hafta kapanışının ardından aynı yapıyla gönderilir.",
    );
    L.push(
      "SKU kırılımı ve geçmiş haftalar: https://mythos-web-five.vercel.app",
    );
    L.push("");
    L.push("Saygılarımla,");
    L.push("Mert Dönmezler");
    L.push("Mythos Cards");

    return NextResponse.json({
      week,
      range,
      missing,
      text: L.join("\n"),
      totals: { net: totNet, qty: totQty, retailers: rows.length },
    });
  } catch (e: any) {
    console.error("weekly-report hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
