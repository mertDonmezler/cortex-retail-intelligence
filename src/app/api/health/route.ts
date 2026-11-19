import { NextRequest, NextResponse } from "next/server";
import {
  sonTamamlanmisHafta,
  gecikmeHaftasi,
  kararGecikmesi,
  kademeOf,
  GECIKME_ROZET,
} from "@/lib/compute";
import { isWeek } from "@/lib/params";
import { supabase, fetchAllRows } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 30;

// ── MODÜL-İÇİ MEMO (yalnız süreç belleği, 300 s) ──
// Ölçüldü: soğuk /api/health 8,1 s (6 sayım + weekly_summary + örnek sorgusu).
// Ana sayfa her açılışta çağırdığı için aynı hafta için tekrar hesaplanmasın;
// ikinci istek ~0,01 s'ye iniyor. TTL 300 s: veri haftada bir yükleniyor.
// ÖNBELLEK SÜREÇ-İÇİDİR — `revalidate = 0` ve dinamik davranış korunuyor, HTTP/Next
// katmanında hiçbir şey önbelleğe alınmıyor. Anahtar SEÇİLİ HAFTA (parametre yoksa
// boş dizge = "en güncel"), `?fresh=1` bypass eder.
const MEMO_TTL = 300_000;
const memo = new Map<string, { at: number; payload: any }>();

// ISO hafta kapısı: `?week=` doğrudan sorguya giriyor. Geçersiz değer sessizce
// yok sayılır ve en güncel hafta kullanılır (bozuk bir bağlantı yüzünden tüm
// sağlık raporunu düşürmek en kötü seçenek). Biçim + TAKVİM kontrolü artık
// paylaşılan `lib/params.isWeek`te — aynı kural 8 uçta daha kullanılıyor.

// VERİ SAĞLIĞI BEKÇİSİ — denetim bulgularını kalıcı, otomatik izlemeye çevirir.
// Ham satır çekmez; PostgREST head+count ile ucuz sayım yapar (+ küçük örnekler).
type Severity = "high" | "med" | "low" | "info";
interface Issue {
  id: string;
  severity: Severity;
  label: string;
  count: number;
  hint: string;
  examples?: string[];
}

// ── SKOR TABANI: ELLE YAZILMAZ, TÜRETİLİR ──
// Burada bir süre `const MIN_SCORE = 40` duruyordu ve iki yeni issue (askida,
// import_celiski) eklenince SESSİZCE YANLIŞA DÖNDÜ: gerçek taban 12'ye indi ama
// yanıt hâlâ 40 yayınlıyordu, yani eşik kuran tarafa yanlış bilgi veriyordu.
// Aynı hatanın tekrarını imkânsız kılmak için ceza tablosu artık TEK KAYNAK:
// her issue'nun şiddeti buradan okunuyor (push satırlarında elle yazılmıyor) ve
// taban aynı tablodan hesaplanıyor. Yeni bir issue eklenirken bu haritaya
// yazılmazsa `sev()` derleme anında hata verir — sessiz kayma olamaz.
const CEZA = { high: 20, med: 8, low: 2, info: 0 } as const;
const SIDDET = {
  null_value: "high",
  stale: "high",
  askida: "high",
  import_celiski: "med",
  gaps: "med",
  neg_stock: "med",
  neg_sales: "info",
  toyzz_ean: "info",
  uzun_hafta: "info",
  placeholder: "low",
  mojibake: "low",
} as const;
type IssueId = keyof typeof SIDDET;
const sev = (id: IssueId): Issue["severity"] => SIDDET[id];
// Hepsi birlikte tetiklenirse: high×3 = 60 · med×3 = 24 · low×2 = 4 · info×2 = 0
// → 88, yani taban 12.
const MIN_SCORE = Math.max(
  0,
  100 -
    (Object.keys(SIDDET) as IssueId[]).reduce(
      (a, id) => a + CEZA[SIDDET[id]],
      0,
    ),
);

// BEKCI KENDI ARIZASINI YUTMAZ.
// PostgREST istemcisi ag hatasinda BILE reject etmiyor; {data:null, error:{...}}
// donuyor. Eski surum hem catch'e guveniyor hem `count ?? 0` ile hatayi 0'a
// ceviriyordu: Supabase erisilemezken skor 100/100 ve "sorun yok" cikiyordu —
// yani bekci, bozuk oldugunda her seyin iyi oldugunu soyluyordu.
async function count(q: any): Promise<number> {
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}
const f = () =>
  supabase.from("fact_weekly").select("*", { count: "exact", head: true });

// ISO Pazartesi haftaları arasını 7'şer gün adımla (eksik hafta tespiti).
function weeksBetween(min: string, max: string): string[] {
  const out: string[] = [];
  const d = new Date(min + "T00:00:00Z");
  const end = new Date(max + "T00:00:00Z");
  let guard = 0;
  while (d <= end && guard++ < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

async function build(weekParam: string | null) {
  const [
    nullVal,
    negStock,
    negSales,
    placeholder,
    mojibake,
    toyzzPending,
    wsRes,
    dfRes,
  ] = await Promise.all([
    count(f().is("sales_value", null).gt("sales_qty", 0)),
    count(f().lt("stock_qty", 0)),
    count(f().lt("sales_qty", 0)),
    count(f().ilike("sku_name", "%KULLANILMAYACAK%")),
    count(f().ilike("sku_name", "%?%")),
    count(
      supabase
        .from("product_alias")
        .select("*", { count: "exact", head: true })
        .eq("retailer", "Toyzz")
        .eq("status", "suggested"),
    ),
    // weekly_summary ARTIK PARALELDE: nullValueWeek'in "en güncel hafta"ya
    // ihtiyacı var, o da bu sorgudan çıkıyor. Eskiden sıralı bekliyordu.
    supabase.from("weekly_summary").select("retailer,week_start,week_end"),
    // last_import HİÇBİR KAPIYI BESLEMEZ (Nezih'te last_import 2026-06-24 ↔
    // last_week 2026-08-03; 24 Haziran'da yüklenen dosya 3 Ağustos haftasını
    // içeremez). Yalnız İKİSİ ARASINDAKİ ÇELİŞKİYİ raporlamak için okunuyor —
    // bugüne kadar sessizce yok sayılan bir tutarsızlık.
    supabase.from("data_freshness").select("retailer,last_import,last_week"),
  ]);

  // Okuma hatasi sessizce "veri yok"a donusmesin: iki toplu sorgunun error
  // alani da acikca kontrol edilir (yukaridaki count() ile ayni gerekce).
  if (wsRes.error) throw wsRes.error;
  if (dfRes.error) throw dfRes.error;

  // Örnekler (yalnız sorun varsa, küçük)
  let nullValEx: string[] = [];
  if (nullVal > 0) {
    const { data } = await supabase
      .from("fact_weekly")
      .select("retailer,sku_name,week_start,sales_qty")
      .is("sales_value", null)
      .gt("sales_qty", 0)
      .order("sales_qty", { ascending: false })
      .limit(3);
    nullValEx = (data ?? []).map(
      (r: any) =>
        `${r.retailer} · ${String(r.sku_name).slice(0, 40)} · ${r.week_start} (${r.sales_qty} adet)`,
    );
  }

  // Tazelik + eksik hafta (weekly_summary küçük: ~firma×hafta)
  const ws = wsRes.data as
    { retailer: string; week_start: string; week_end?: string }[] | null;
  // 7 GÜNDEN UZUN "HAFTA": week_end − week_start ≠ 6 gün. Bugün tek örnek var
  // (Huppaluppo 2026-06-29 → 08-02, aylık dosyadan türetilmiş 34 günlük kalıntı).
  // Bilgi düzeyinde raporlanır: skoru düşürmez, ama görünmez de kalmaz.
  const uzunHafta: string[] = [];
  for (const r of ws ?? []) {
    if (!r.week_end) continue;
    const gun = Math.round(
      (Date.parse(r.week_end) - Date.parse(r.week_start)) / 864e5,
    );
    if (gun !== 6)
      uzunHafta.push(
        `${r.retailer} · ${r.week_start} → ${r.week_end} (${gun + 1} gün)`,
      );
  }
  const byRet = new Map<string, string[]>();
  let networkLatest = "";
  for (const r of ws ?? []) {
    (byRet.get(r.retailer) ?? byRet.set(r.retailer, []).get(r.retailer)!).push(
      r.week_start,
    );
    if (r.week_start > networkLatest) networkLatest = r.week_start;
  }
  // ── TAZELİK ÇAPASI: AĞ DEĞİL TAKVİM ──
  // Eski kural `latest < networkLatest` idi. Beş firma da göndermeyi bıraksa
  // hepsinin `latest === networkLatest` olur, `stale` boşalır, high issue'nun
  // −20'si kalkar ve SKOR 20 PUAN YÜKSELİR. Yani sistem tamamen kör kaldığında
  // "sağlık mükemmel" derdi. Takvim çapası (son tamamlanmış hafta) bunu
  // imkânsız kılar: veri durdukça gecikme her hafta büyür, skor düşer.
  //
  // EŞİK 1 → GECIKME_ROZET (2): firmaların rapor aralığının medyanı 1 hafta,
  // yani 1 haftalık gecikme normal kadanstır. Eski eşikle bugün 4 firmanın 4'ü
  // "bayat" işaretleniyordu — /api/stores'un STALE_WEEKS=2 gerekçesiyle uyumsuz.
  const takvimHaftasi = sonTamamlanmisHafta(new Date());
  const stale: string[] = [];
  let gapTotal = 0;
  const gapEx: string[] = [];
  const askida: string[] = [];
  for (const [ret, weeks] of byRet) {
    const sorted = [...new Set(weeks)].sort();
    const latest = sorted[sorted.length - 1];
    const gecikmeHf = gecikmeHaftasi(latest, takvimHaftasi);
    const kad0 = kademeOf(kararGecikmesi(sorted, takvimHaftasi));
    // BIR FIRMA IKI KEZ CEZALANDIRILMAZ: aski (3+ hf) zaten bayatligin (2+ hf)
    // siddetli halidir. Ikisini birlikte saymak ayni sessizligi -40 puan
    // yapiyordu; her firma tek kovaya girer.
    if (gecikmeHf >= GECIKME_ROZET && kad0.likidasyonAcik) {
      stale.push(
        `${ret} · ${gecikmeHf} hafta geride (son: ${latest}, takvim: ${takvimHaftasi})`,
      );
    }
    // ASKI: /api/routing'e bağımlılık kurmadan, elimizdeki hafta serisinden aynı
    // saf fonksiyonlarla türetilir (ek sorgu yok). Karar üretiminin durduğu
    // firmanın sağlık skoruna NEGATİF girmesi şart — aksi halde sessizlik
    // "sorun yok" diye okunur.
    if (!kad0.likidasyonAcik) {
      askida.push(`${ret} · ${kad0.durum} (son: ${latest}, ${gecikmeHf} hf)`);
    }
    const expected = weeksBetween(sorted[0], latest);
    const have = new Set(sorted);
    const miss = expected.filter((w) => !have.has(w));
    if (miss.length) {
      gapTotal += miss.length;
      gapEx.push(
        `${ret}: ${miss.length} eksik (${miss.slice(0, 2).join(", ")}${miss.length > 2 ? "…" : ""})`,
      );
    }
  }

  // last_import ↔ last_week çelişkisi (yalnız raporlanır).
  const importCelisi: string[] = [];
  for (const d of (dfRes.data ?? []) as any[]) {
    if (
      d.last_import &&
      d.last_week &&
      String(d.last_import).slice(0, 10) < String(d.last_week)
    ) {
      importCelisi.push(
        `${d.retailer} · yükleme ${String(d.last_import).slice(0, 10)} < veri haftası ${d.last_week}`,
      );
    }
  }

  const issues: Issue[] = [];
  if (nullVal > 0)
    issues.push({
      id: "null_value",
      severity: sev("null_value"),
      label: "Satış var ama ciro NULL (sessiz ciro kaybı)",
      count: nullVal,
      hint: "Kaynak PSF/fiyat eşlemesi eksik — bu kalemler ciroda görünmez.",
      examples: nullValEx,
    });
  if (stale.length)
    issues.push({
      id: "stale",
      severity: sev("stale"),
      label: `Bayat perakendeci (${GECIKME_ROZET}+ hafta geride)`,
      count: stale.length,
      hint: "Bu firma(lar) son haftaları göndermemiş; takvim haftasına göre ölçüldü.",
      examples: stale,
    });
  if (askida.length)
    issues.push({
      id: "askida",
      severity: sev("askida"),
      label: "Firmada karar üretimi askıda",
      count: askida.length,
      hint: "Veri bu firmada geri alınamaz karar (tasfiye) için fazla eski — rapor istenmeli.",
      examples: askida,
    });
  if (importCelisi.length)
    issues.push({
      id: "import_celiski",
      severity: sev("import_celiski"),
      label: "Yükleme tarihi veri haftasıyla çelişiyor",
      count: importCelisi.length,
      hint: "last_import, last_week'ten eski — yükleme kaydı güvenilmez (hiçbir karar bu alanı okumuyor).",
      examples: importCelisi,
    });
  if (gapTotal > 0)
    issues.push({
      id: "gaps",
      severity: sev("gaps"),
      label: "Eksik hafta (veri serisinde boşluk)",
      count: gapTotal,
      hint: "Aradaki bazı haftaların verisi hiç yüklenmemiş.",
      examples: gapEx,
    });
  if (negStock > 0)
    issues.push({
      id: "neg_stock",
      severity: sev("neg_stock"),
      label: "Negatif stok",
      count: negStock,
      hint: "Fiziksel olarak anlamsız; kaynak/ETL düzeltmesi veya 0'a sabitleme.",
    });
  if (negSales > 0)
    issues.push({
      id: "neg_sales",
      severity: sev("neg_sales"),
      label: "Negatif satış (iade/düzeltme)",
      count: negSales,
      hint: "Gerçek iade/düzeltme satırları — veri doğru, bilgi amaçlı.",
    });
  if (placeholder > 0)
    issues.push({
      id: "placeholder",
      severity: sev("placeholder"),
      label: "Placeholder SKU (***KULLANILMAYACAK***)",
      count: placeholder,
      hint: "Kaynak listeden gelen ölü kayıt; raporlardan elenmeli.",
    });
  if (mojibake > 0)
    issues.push({
      id: "mojibake",
      severity: sev("mojibake"),
      label: "Şüpheli karakterli ad (mojibake / ?)",
      count: mojibake,
      hint: "Türkçe karakter kodlama bozukluğu; aynı ürün farklı yazımlara bölünebilir.",
    });
  if (uzunHafta.length)
    issues.push({
      id: "uzun_hafta",
      severity: sev("uzun_hafta"),
      label: "7 günden uzun hafta (türetilmiş / birleştirilmiş kayıt)",
      count: uzunHafta.length,
      hint: "Bu satır bir takvim haftası değil; trend ve aylık özette işaretlenir, karar üretmez.",
      examples: uzunHafta,
    });
  if (toyzzPending > 0)
    issues.push({
      id: "toyzz_ean",
      severity: sev("toyzz_ean"),
      label: "Toyzz EAN önerisi onay bekliyor",
      count: toyzzPending,
      hint: "/eslesme sayfasında aday seçip onayla → firmalar-arası birleşir.",
    });

  // Skor: ceza tablosundan (yukarıdaki CEZA) — burada ikinci kez yazılmıyor.
  let score = 100;
  for (const i of issues) score -= CEZA[i.severity] ?? 0;
  score = Math.max(0, Math.min(100, score));

  // ── FİYATSIZ SATIRLAR, TEK HAFTA ──
  // Kümülatif `null_value` sayısı (143) tüm geçmişi kapsıyor ve manşetle
  // kıyaslanamaz. Manşetin yanında duracak sayı SEÇİLİ HAFTAYA ait olmalı.
  //
  // `?week=` PARAMETRESİ ZORUNLU: bu alan hafta seçicisine bağlı bir yüzeyde
  // gösterilecek. Parametre olmadan sabit "en güncel hafta" dönerse, kullanıcı
  // geçmiş bir hafta seçtiğinde manşet o haftayı, iki satır aşağıdaki ölçüm
  // boşluğu başka bir haftayı gösterir — kapatılmak istenen sessiz kapsam
  // çelişkisinin birebir aynısı, bu kez tek kartın içinde.
  //
  // TL YAZILMAZ, ADET YAZILIR: bu satırlarda birim fiyat bilinmiyor, TL uydurmak
  // olurdu. Adet manşetin adediyle doğrudan kıyaslanabilir.
  //
  // SORGU: tek sayfalı çekim (yalnız `sales_qty` kolonu). Satır sayısı ve adet
  // toplamı aynı sonuçtan çıkıyor; head+count ile sayım yapıp adedi ayrı sorguyla
  // toplamak iki tur demekti ve PostgREST'te SUM yok. Bir haftada bu küme onlarca
  // satır (ölçülen: 22), yani çekim ucuz. `order("id")` sayfalama kararlılığı için
  // (fact_weekly'nin benzersiz anahtarı).
  const nvWeek = isWeek(weekParam) ? weekParam : networkLatest || null;
  let nullValueWeek: { week: string | null; rows: number; qty: number } = {
    week: nvWeek,
    rows: 0,
    qty: 0,
  };
  if (nvWeek) {
    try {
      const nvRows = await fetchAllRows<{ sales_qty: number | string | null }>(
        (from, to) =>
          supabase
            .from("fact_weekly")
            .select("sales_qty")
            .is("sales_value", null)
            .gt("sales_qty", 0)
            .eq("week_start", nvWeek)
            .order("id")
            .range(from, to),
      );
      nullValueWeek = {
        week: nvWeek,
        rows: nvRows.length,
        qty: nvRows.reduce((s, r) => s + (Number(r.sales_qty) || 0), 0),
      };
    } catch (e) {
      // Ölçüm boşluğunu ölçen sorgu düşerse tüm sağlık raporu düşmesin.
      console.error("health nullValueWeek hatası:", e);
    }
  }

  return {
    score,
    minScore: MIN_SCORE, // ulaşılabilir taban: eşik kuran taraf `< 40` yazmasın
    latestWeek: networkLatest || null,
    retailers: { total: byRet.size, stale: stale.length },
    issues,
    nullValueWeek,
  };
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const weekParam = sp.get("week");
  const fresh = sp.get("fresh") === "1";
  const key = isWeek(weekParam) ? weekParam : "";
  try {
    const hit = memo.get(key);
    if (!fresh && hit && Date.now() - hit.at < MEMO_TTL)
      return NextResponse.json(hit.payload);
    // BİR KEZ YENİDEN DENE. build() ~450 bin satırlık fact_weekly'de paralel 6 tam
    // sayım yapıyor (ikisi ilike '%…%' taraması); soğuk başlangıçta ilk deneme
    // veritabanı zaman aşımına düşüp boş mesajlı hata veriyordu (29.10: canlıda
    // yayın sonrası 1 kez, yerelde ana sayfa yüklenirken 1 kez; ikinci istek 200).
    // Bekçi arızasını YUTMAZ: ikinci deneme de düşerse 500 aynen döner.
    let payload;
    try {
      payload = await build(weekParam);
    } catch (ilk) {
      console.error("health ilk deneme düştü, yeniden deneniyor:", ilk);
      payload = await build(weekParam);
    }
    memo.set(key, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (e: any) {
    console.error("health hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
