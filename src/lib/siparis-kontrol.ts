// ── SİPARİŞ KONTROLÜ (2026-10-29) ───────────────────────────────────────────
// Kanaldan gelen siparişi (D&R RPT, Toyzz…) yönlendirme motorunun hedefleriyle
// satır satır karşılaştırır. "Alınan sipariş stoklara göre mantıklı mı?" sorusu
// her seferinde elle cevaplanıyordu ve bir kez yanlış cevaplandı (22 Ekim D&R:
// eski bir depo stoğu güncel sanılınca Hileli'ye "fazla" denmişti). Kural artık
// tek yerde ve motorla AYNI: hedef stok T = max(asgari raf, kapsam × talep),
// çekme ufku K = max(T, ufuk × talep).
//
// SAF MODÜL: DB'ye dokunmaz. /yonlendirme sayfası motorun yanıtını zaten
// yüklüyor; kontrol tarayıcıda o satırlarla (`urunler`: kanalın TÜM ürünleri)
// yapılır, ek istek yok.
import { katla, aile, takim, sezon } from "./urun-ailesi";

export type SiparisSatiri = {
  ham: string;
  barkod: string | null;
  ad: string;
  adet: number;
};

// /api/routing `urunler` satırının bu modülün okuduğu alanları.
export type MotorSatiri = {
  retailer: string;
  sku_name: string;
  barkod: string;
  season: string;
  stock: number;
  velocity: number;
  target: number;
  action: string;
  talep?: number;
  talepUst?: number; // raf inceyse iyimser talep (ret eşiği bundan kurulur)
  rafEsik?: number;
  magaza?: number | null;
  depo?: number; // kanalın kendi deposu (şimdilik yalnız D&R, aynı hafta)
};

export type Hukum =
  | "MANTIKLI"
  | "AZ"
  | "FAZLA"
  | "COK_FAZLA"
  | "ESKI_SEZON"
  | "SATIS_YOK"
  | "BULUNAMADI";

export type KontrolSonucu = {
  satir: SiparisSatiri;
  motor: MotorSatiri | null;
  hukum: Hukum;
  oneri: number | null; // motorun önerdiği sipariş adedi
  sonraHf: number | null; // sipariş sonrası kaç haftalık stok
  sonraMagazaBasi: number | null; // sipariş sonrası taşıyan mağaza başı stok
  gerekce: string;
};

export const HUKUM_AD: Record<Hukum, string> = {
  MANTIKLI: "Mantıklı",
  AZ: "Az",
  FAZLA: "Fazla",
  COK_FAZLA: "Çok fazla",
  ESKI_SEZON: "Eski sezon",
  SATIS_YOK: "Satış yok",
  BULUNAMADI: "Bulunamadı",
};

const sayiTr = (n: number) =>
  n.toLocaleString("tr-TR", { maximumFractionDigits: 1 });
// "1.200" (binlik nokta) → 1200; ondalıklı ("352,89") ya da harfli parça sayı değildir.
function tamSayi(p: string): number | null {
  const t = p.trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ""));
  if (/^\d+$/.test(t)) return Number(t);
  return null;
}
// Tin'lerde fatura barkodu "-1..-4" ekiyle geliyor (5053307076952-3); CORTEX'te tek EAN.
const barkodMu = (p: string): string | null => {
  const m = p.trim().match(/^(\d{8,14})(-\d{1,2})?$/);
  return m ? m[1] : null;
};
const BASLIK = {
  barkod: /^(barkod|barcode|ean|gtin)/,
  // Ad kolonu İKİ KADEME: D&R (SAP) dosyasında "Malzeme" = D&R'ın malzeme KODU,
  // "Malzeme kısa metni" = ürün adı. Önce gerçek ad başlıkları; "malzeme" ile
  // başlayan çıplak kolon ancak hiçbiri yoksa (kod kolonunu ad sanmamak için).
  ad: /(urun|ürün|stok ad|stok_ad|kısa metn|kisa metn|metin|aciklama|açıklama|tanim|tanım|kalem tan|isim|^ad$|^ad )/,
  adYedek: /^malzeme/,
  adet: /(miktar|adet|siparis|sipariş|qty|quantity)/,
};

/**
 * SheetJS `sheet_to_json(ws, { header: 1, raw: true })` çıktısını sekmeli metne
 * çevirir. HAM DEĞER şart: Excel EAN'ı biçimli metinde "8.68482E+12" gösteriyor
 * (D&R sipariş dosyası) ve barkod kaybolur; ham sayı 13 hanede güvenli tam sayıdır.
 */
export function tabloMetni(satirlar: unknown[][]): string {
  return satirlar
    .map((r) =>
      r
        .map((c) =>
          typeof c === "number" && Number.isSafeInteger(c)
            ? String(c)
            : c == null
              ? ""
              : String(c).replace(/[\t\r\n]+/g, " "),
        )
        .join("\t"),
    )
    .join("\n");
}

/**
 * Yapıştırılan siparişi satırlara ayırır. Excel'den kopyalanan tablo (sekme ile
 * ayrılmış) başlık satırı taşıyorsa kolonlar başlıktan bulunur; yoksa her satırda
 * barkod = 8-14 haneli ilk parça, adet = son tam sayı parça (barkod değil),
 * ad = kalan metin.
 */
export function siparisAyristir(metin: string): SiparisSatiri[] {
  // GÖRÜNMEZ KARAKTER: SAP'ın ürettiği D&R sipariş dosyasının ilk satırı boş
  // görünüyor ama sıfır genişlikli karakter taşıyor; trim() onu silmediği için o
  // satır başlık sanılıyor, gerçek başlık veri okunuyordu (22 Ekim dosyası).
  const satirlar = metin
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/ /g, " ")
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s.trim());
  if (!satirlar.length) return [];
  const sekmeli = satirlar.some((s) => s.includes("\t"));
  const parca = (s: string) =>
    (sekmeli ? s.split("\t") : s.split(/\s{2,}|;|\|/)).map((x) => x.trim());
  const kolonlar = (satir: string) => {
    const ilk = parca(satir).map((x) => x.toLocaleLowerCase("tr"));
    return {
      barkod: ilk.findIndex((x) => BASLIK.barkod.test(x)),
      ad: ((i) => (i >= 0 ? i : ilk.findIndex((x) => BASLIK.adYedek.test(x))))(
        // "Ürün Kodu", "Ürün Id", "Ürün No" ad değildir; SAP'ın "Ad 1"i satıcı/tesis adı.
        ilk.findIndex(
          (x) =>
            BASLIK.ad.test(x) &&
            !BASLIK.barkod.test(x) &&
            !/kod|\bid\b|\bno\b|^ad \d/.test(x),
        ),
      ),
      adet: ilk.findIndex((x) => BASLIK.adet.test(x)),
    };
  };
  // BAŞLIK İLK 10 SATIRDA ARANIR (ilk dolu satır olmak zorunda değil): barkod/ad/
  // adet anahtar kelimelerinden en az ikisi, adet şart. Öncesi atılır.
  let basIdx = -1;
  let kolon = { barkod: -1, ad: -1, adet: -1 };
  for (let i = 0; i < Math.min(10, satirlar.length); i++) {
    const k = kolonlar(satirlar[i]);
    if (
      [k.barkod, k.ad, k.adet].filter((j) => j >= 0).length >= 2 &&
      k.adet >= 0
    ) {
      basIdx = i;
      kolon = k;
      break;
    }
  }
  const baslikVar = basIdx >= 0;
  const govde = baslikVar ? satirlar.slice(basIdx + 1) : satirlar;
  const out: SiparisSatiri[] = [];
  for (const ham of govde) {
    const p = parca(ham);
    let barkod: string | null = null,
      adet: number | null = null,
      ad = "";
    if (baslikVar) {
      barkod = kolon.barkod >= 0 ? barkodMu(p[kolon.barkod] ?? "") : null;
      adet = tamSayi(p[kolon.adet] ?? "");
      ad = kolon.ad >= 0 ? (p[kolon.ad] ?? "") : "";
    } else {
      // Sekmesiz düz metinde parçalar boşlukla da ayrılabilir: önce kalın ayraç,
      // tek parça kaldıysa tek boşluk.
      const ps = p.length > 1 ? p : ham.trim().split(/\s+/);
      const bi = ps.findIndex((x) => barkodMu(x) != null);
      if (bi >= 0) barkod = barkodMu(ps[bi]);
      let ai = -1;
      for (let i = ps.length - 1; i >= 0; i--) {
        if (i === bi) continue;
        const n = tamSayi(ps[i]);
        if (n != null) {
          adet = n;
          ai = i;
          break;
        }
      }
      ad = ps
        .filter((_, i) => i !== bi && i !== ai)
        .join(" ")
        .trim();
    }
    if (adet == null || adet <= 0) continue; // adetsiz satır (toplam, boş) atlanır
    if (!barkod && !ad) continue;
    // Excel'in toplam satırı ürün değildir (adı dolu olduğu için yukarıdan geçer).
    if (!barkod && /^(genel\s+)?toplam\b/i.test(katla(ad).toLowerCase()))
      continue;
    out.push({ ham, barkod, ad, adet });
  }
  return out;
}

const kelimeler = (s: string) =>
  katla(s)
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 1);

// Takım: urun-ailesi `takim()` ayrı yazılmış kodu tanır ("FB", "(FB)"); D&R adları
// bitişik ("FBPlsFtblcKartları") — o ön ek de yakalanır. İkisi farklı takım
// söylüyorsa ürün AYNI DEĞİLDİR, ad ne kadar benzerse benzesin.
function takimOf(ad: string): string {
  const t = takim(ad);
  if (t) return t;
  const a = katla(ad);
  const m = a.match(/(?:^|[^A-Z])(GS|FB|BJK|TS)(?=[A-Z])/);
  return m
    ? {
        GS: "Galatasaray",
        FB: "Fenerbahçe",
        BJK: "Beşiktaş",
        TS: "Trabzonspor",
      }[m[1]]!
    : "";
}
// İki ad aynı aileyi/takımı/sezonu söylemeli (biri bilinmiyorsa o ölçüt atlanır).
function uyumlu(a: string, b: string): boolean {
  const ta = takimOf(a),
    tb = takimOf(b);
  if (ta && tb && ta !== tb) return false;
  const aa = aile(a),
    ab = aile(b);
  if (aa !== "Diğer" && ab !== "Diğer" && aa !== ab) return false;
  const sa = sezon(a),
    sb = sezon(b);
  if (sa && sb && sa !== sb) return false;
  return true;
}

/**
 * Motor satırını bulur. BARKOD VARSA YALNIZ BARKOD: barkodu verilen ürün kanalda
 * yoksa adla en yakına düşmek yanlış ürünü kontrol ettirir (29.10: FB Pulse →
 * BJK Pulse). Barkodsuz satırda ad: takım/aile/sezon uyumlu adaylar arasında
 * kelime örtüşmesi (Jaccard) ≥ 0,5 ve ikinciden en az 0,15 önde olmalı.
 */
export function eslestir(
  satir: SiparisSatiri,
  adaylar: MotorSatiri[],
): MotorSatiri | null {
  if (satir.barkod)
    return adaylar.find((m) => m.barkod === satir.barkod) ?? null;
  const k = new Set(kelimeler(satir.ad));
  if (!k.size) return null;
  const skorlar: { m: MotorSatiri; skor: number }[] = [];
  for (const m of adaylar) {
    if (!uyumlu(satir.ad, m.sku_name)) continue;
    const mk = new Set(kelimeler(m.sku_name));
    if (!mk.size) continue;
    let ortak = 0;
    for (const w of k) if (mk.has(w)) ortak++;
    skorlar.push({ m, skor: ortak / (k.size + mk.size - ortak) });
  }
  skorlar.sort((x, y) => y.skor - x.skor);
  const [bir, iki] = skorlar;
  if (!bir || bir.skor < 0.5) return null;
  if (iki && bir.skor - iki.skor < 0.15) return null; // belirsiz: barkodla yapıştırılmalı
  return bir.m;
}

/**
 * Bir sipariş satırının hükmü. `ufukHf` motorun çekme ufku (summary.raf.ufukHf,
 * senaryoyla çarpılmış). Sıra ve eşikler:
 *   sipariş < ihtiyacın yarısı              → AZ (fark en az 1 hf talep ise)
 *   sipariş > ufuk × İYİMSER talep − stok  → ÇOK FAZLA
 *   sonrası > makul (16 hf) ve ihtiyaçtan fazla → FAZLA
 *   aksi                                    → MANTIKLI
 * İyimser talep yalnız ret eşiğinde: raf incelmiş üründe gerçek talep belirsiz,
 * siparişi haksız yere "çok fazla" diye reddetmek stoksuz ürünün satışını öldürür.
 */
export function siparisHukmu(
  satir: SiparisSatiri,
  m: MotorSatiri | null,
  ufukHf: number,
): KontrolSonucu {
  const bos = {
    satir,
    motor: m,
    oneri: null,
    sonraHf: null,
    sonraMagazaBasi: null,
  };
  if (!m)
    return {
      ...bos,
      hukum: "BULUNAMADI",
      gerekce: satir.barkod
        ? "Bu barkod bu kanalda CORTEX'te yok (yeni ürün olabilir)"
        : "Ad tek bir ürüne oturmadı — barkodla yapıştırın",
    };
  // Kanaldaki stok = mağaza rafı + (biliniyorsa) kanalın kendi deposu. Depodaki mal
  // da bizim konsinye malımız ve aynı talebe satılacak; sipariş onun ÜSTÜNE gelir.
  const depo = Math.max(0, m.depo ?? 0);
  const q = satir.adet,
    s = Math.max(0, m.stock) + depo;
  const d = Math.max(0, m.talep ?? m.velocity);
  const dUst = Math.max(d, m.talepUst ?? d);
  const sonraHf = d > 0 ? (s + q) / d : null;
  const sonraMagazaBasi = m.magaza ? (s + q) / m.magaza : null;
  const talepMetni =
    dUst > d
      ? `haftada ~${sayiTr(d)}–${sayiTr(dUst)} (raf ince, belirsiz)`
      : `haftada ~${sayiTr(d)}`;
  const stokMetni =
    depo > 0
      ? `stok ${sayiTr(m.stock)} mağaza + ${sayiTr(depo)} depo`
      : `stok ${sayiTr(s)}`;
  const ekBilgi = `${stokMetni}${m.magaza ? ` (mağaza başı ${sayiTr(Math.max(0, m.stock) / m.magaza)})` : ""} · ${talepMetni}`;
  if (dUst < 1) {
    return {
      ...bos,
      hukum: "SATIS_YOK",
      oneri: 0,
      sonraHf,
      sonraMagazaBasi,
      gerekce: `${ekBilgi}: satış yok denecek kadar az; ${s > 0 ? "mevcut stok bekliyor" : "yeni ürünse ilk haftaları bekle"}`,
    };
  }
  const eski = m.season === "ESKİ";
  if (eski && m.action !== "SEVK") {
    return {
      ...bos,
      hukum: "ESKI_SEZON",
      oneri: 0,
      sonraHf,
      sonraMagazaBasi,
      gerekce: `${ekBilgi}: eski sezon; mevcut stok satarak erimeli, yeni sipariş gereksiz`,
    };
  }
  // Motorla aynı hedefler (route.ts): eski sezonda asgari raf yok.
  const P = eski ? 0 : Math.max(0, m.rafEsik ?? 0);
  const T = Math.max(P, Math.ceil(m.target * d));
  const ihtiyac = Math.max(0, T - s);
  const tavanUst = Math.max(0, Math.max(T, Math.ceil(ufukHf * dUst)) - s);
  // MAKUL: sipariş sonrası stok sezon içinde olağan sayılacak düzeyde mi? Motorun
  // 8-10 haftalık ikmal hedefi ölçüt DEĞİL — perakendeci kendi döngüsüyle sipariş
  // veriyor ve konsinyede rafta duran mal (mağaza başı 7-10 adet) satışı artırıyor.
  // Asıl risk malın ufuk içinde satamaması. 16 hf (ufkun 16/26'sı, senaryoyla
  // ölçeklenir) 22 Ekim D&R siparişinin elle verilen hükümleriyle örtüşüyor.
  const makulHf = Math.round((ufukHf * 16) / 26);
  const makulTavan = Math.max(ihtiyac, Math.ceil(makulHf * d) - s);
  const sonra =
    `sipariş sonrası ${sayiTr(Math.round(sonraHf ?? 0))} hf` +
    (dUst > d
      ? ` (iyimser talepte ${sayiTr(Math.round((s + q) / dUst))} hf)`
      : "") +
    (sonraMagazaBasi != null ? `, mağaza başı ${sayiTr(sonraMagazaBasi)}` : "");
  if (q < ihtiyac * 0.5 && ihtiyac - q >= Math.ceil(d)) {
    return {
      ...bos,
      hukum: "AZ",
      oneri: ihtiyac,
      sonraHf,
      sonraMagazaBasi,
      gerekce: `${ekBilgi} · ${sonra} — hedefe (${sayiTr(T)} adet) yetmiyor; öneri ${sayiTr(ihtiyac)}`,
    };
  }
  if (q > tavanUst) {
    return {
      ...bos,
      hukum: "COK_FAZLA",
      oneri: makulTavan,
      sonraHf,
      sonraMagazaBasi,
      gerekce: `${ekBilgi} · ${sonra} — ${ufukHf} hf ufkunu aşıyor; makul en fazla ${sayiTr(makulTavan)}`,
    };
  }
  if (q > makulTavan) {
    return {
      ...bos,
      hukum: "FAZLA",
      oneri: makulTavan,
      sonraHf,
      sonraMagazaBasi,
      gerekce: `${ekBilgi} · ${sonra} — ${makulHf} haftanın üstü ama ${ufukHf} hf ufkunun içinde; makul en fazla ${sayiTr(makulTavan)}`,
    };
  }
  return {
    ...bos,
    hukum: "MANTIKLI",
    oneri: q,
    sonraHf,
    sonraMagazaBasi,
    gerekce: `${ekBilgi} · ${sonra}`,
  };
}

/** Siparişin tamamı: ayrıştır → eşleştir → hükümler + özet. */
export function siparisKontrol(
  metin: string,
  retailer: string,
  urunler: MotorSatiri[],
  ufukHf: number,
) {
  const adaylar = urunler.filter((r) => r.retailer === retailer);
  const sonuclar = siparisAyristir(metin).map((s) =>
    siparisHukmu(s, eslestir(s, adaylar), ufukHf),
  );
  const say = (h: Hukum) => sonuclar.filter((x) => x.hukum === h).length;
  return {
    sonuclar,
    ozet: {
      satir: sonuclar.length,
      siparisAdet: sonuclar.reduce((t, x) => t + x.satir.adet, 0),
      oneriAdet: sonuclar.reduce((t, x) => t + (x.oneri ?? x.satir.adet), 0),
      sayim: Object.fromEntries(
        (Object.keys(HUKUM_AD) as Hukum[]).map((h) => [h, say(h)]),
      ) as Record<Hukum, number>,
    },
  };
}
