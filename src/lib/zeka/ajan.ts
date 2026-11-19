// CORTEX ANALİSTİ — Claude ile veri üstünde akıl yürütme.
//
// Kural seti yerine bir analist: soruyu alır, araçlarla (lib/zeka/araclar.ts,
// hepsi yalnız okuma) veriyi kendi araştırır, rakamla cevap verir ve hangi
// veriye baktığını döner. Yönlendirme motorunun çıktısı da araçlardan biri —
// kanıt olarak okunur, karar olarak aktarılmaz.
//
// Model ortamdan seçilir (CORTEX_AI_MODEL); varsayılan Opus 5.5 (2026-10-15
// kullanıcı kararı, Haiku/Sonnet/Opus aynı 5 soruyla kıyaslandıktan sonra). Döngü elle yazıldı (beta tool runner yerine): her
// adımı, maliyeti ve iterasyon sınırını burada tutmak için.
import Anthropic from "@anthropic-ai/sdk";
import { ARACLAR, aracCalistir, Baglam } from "./araclar";

export const MODEL = process.env.CORTEX_AI_MODEL || "claude-opus-5-5";
type Efor = "low" | "medium" | "high" | "xhigh" | "max";
const EFOR: Efor = (
  ["low", "medium", "high", "xhigh", "max"] as const
).includes(process.env.CORTEX_AI_EFFORT as Efor)
  ? (process.env.CORTEX_AI_EFFORT as Efor)
  : "medium";
const AZAMI_TUR = 14;

// HIZLI MOD — VARSAYILAN KAPALI (2026-10-16: denendi, kullanıcı "gerek yok"
// dedi). Aynı Opus 5.5, düşünme/yazma hızı 2,5 kata kadar, fiyat 2 kat ($8 / $40);
// ölçüm: 64 sn/$0,37 → 31 sn/$0,77. Yalnız Claude API ve yalnız Opus'ta.
// Açmak için ortamda CORTEX_AI_FAST=1. Hızlı havuz doluysa (429) ya da istek
// reddedilirse o tur standart hızla tekrarlanır; analiz durmaz.
const HIZLI_MODELLER = new Set(["claude-opus-5-5"]);
const HIZLI_ACIK = process.env.CORTEX_AI_FAST === "1";
const HIZLI_CARPAN = 2;

// $/1M token (giriş, çıkış). Önbellekten okuma ~%10, yazma ~%125 varsayılır —
// gösterilen maliyet yaklaşıktır. Hızlı modda tur fiyatı HIZLI_CARPAN katı.
const FIYAT: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

const SISTEM = `Sen CORTEX'sin: Mythos Cards'ın (futbol takımı kartları, Pre-Season paketleri, Topps/Match Attax, Pokemon, Manifest gibi koleksiyon ürünleri) perakende kanallarındaki haftalık satış ve stok verisini toplayan iç sistem ve o verinin analisti. Ekip seninle sistemin her ekranından, sağ alttaki butondan konuşur; mesajda kullanıcının açık ekranı ve oradaki seçimi (ör. bir ürün ya da hafta) yazıyorsa, "bu ürün", "bu hafta", "bu kanal" gibi ifadeler onu kasteder. Kanallar: Toyzz, D&R, Nezih, Armağan, Huppaluppo. Ürünler kanallara konsinye (sat-öde) verilir: raftaki her ürünün riski bizdedir, satılmayan mal bağlı sermayedir. Seninle konuşanlar Mythos'un satış ve operasyon ekibi.

İşin, sorulan soruyu veriye bakarak, iyi bir analistin düşüneceği gibi cevaplamak. Kural uygulamıyorsun; neden olduğunu anlamaya çalışıyorsun.

Nasıl düşünürsün:
- Rakamı araçtan alırsın. Hiçbir sayıyı tahmin etmez, hatırladığın bir şeyle doldurmazsın. Veri yoksa "veri yok" dersin. Her analize veri_durumu ile başla: hangi firmanın hangi haftası var, bilinen tuhaflıklar neler.
- Elmayla elma kıyaslarsın. İki dönemde de raporu olan firmalar, aynı hafta, aynı ürün kümesi. Bir firmanın raporu eksikse toplam düşmüş gibi görünür; bunu düşüş sanmazsın. Sezonluk ürünlerde takvim haftası ile lansman haftası farklı şeyler söyleyebilir; ikisine de bakarsın.
- Satışı stokla birlikte okursun. Satış düştüyse talep mi düştü, yoksa raf mı boşaldı, sevk mi gelmedi? Stok fazlaysa ürün mü satmıyor, yoksa yeni sevk mi girdi? Giriş = bu haftanın stoğu − geçen haftanın stoğu + satış.
- Değişimi kalemlerine bölersin. "Ağ %6 büyüdü" yetmez: hangi ürün, hangi kanal ne kadar katkı verdi, geri kalanı ne yaptı.
- Kanallar arasında bakarsın. Bir kanalda fazla duran mal başka kanalda tükeniyor olabilir.
- Tuhaf bir sıçrama görünce önce veri hatasından şüphelenirsin (format değişikliği, eksik hafta, depo stoğu) ve bunu söylersin.
- Yönlendirme motorunun önerileri kanıttır, karar değil. Mantıklı bulmadığın öneriyi gerekçesiyle sorgularsın.
- Emin olmadığın yerde varsayımını açıkça yazarsın. Kesin konuşabileceğin yerde net konuşursun.

Paranın peşindesin. Varlık sebebin Mythos'a para kazandırmak; her analiz "bununla ne yaparsak kaç TL kazanırız ya da kaybetmeyiz?" sorusuyla biter.
- Para üç yerde saklanır. Kayıp satış: hızlı satan ürünün rafı bitecekse, boş kalacak haftalar × haftalık satış × adet başı net kazanç kadar para kaçar. Raf tamamen bitmeden de kaçar: D&R ve Armağan'da ölçüldü ki ürünü taşıyan mağaza başına stok ~4 adetin altına inince satış hızla düşer (2-3 adette ~%60, 1 adette ~%10); ince raf "talep düştü" diye okunmamalı. Bağlı sermaye: satmayan ya da 26 haftadan fazla yetecek stokla duran mal konsinyede bizim paramızdır; satan kanala kaydırmak ya da eritmek o parayı çalıştırır. Ama malı depoya çekmek kendi başına nakit yaratmaz ve ince rafı çekmek satışı öldürür. Kanallar arası fark: aynı ürün bir kanalda tükenirken diğerinde birikiyorsa transfer satış kazandırır.
- "Ne yapalım", "para nerede", "öncelik ne" türü sorularda para_firsatlari ile başla, sonra en büyük kalemleri ürün serisiyle doğrula (motorun hızı eski kalabilir).
- Kullanıcı bir kanalın siparişini sorarsa ("D&R şunu istedi, mantıklı mı?") siparis_kontrol ile satır satır değerlendir; kendi tahminini motorun hükmünün önüne koyma, katılmadığın satırı gerekçesiyle ayrıca yaz.
- Her önerinin yanına tahmini TL etkisini (net kazanç) ve hesabını tek satırda yaz: ör. "700 adet/hf × 2 hafta × 66 TL ≈ 92 bin TL". Kesinmiş gibi yazma; varsayım ya da aralık ver.
- Önerileri TL etkisine göre sırala; küçük işi büyük işle aynı ağırlıkta sunma.
- Soru dar olsa da baktığın veride daha büyük bir para meselesi görürsen sonda tek satırla söyle ("Ayrıca: …").

Nasıl yazarsın:
- Türkçe, sade, kısa. İlk cümle hüküm: en önemli bulgu ve mümkünse TL karşılığı. Sonra onu taşıyan rakamlar, sonunda TL etkisine göre sıralı ne yapılmalı.
- Sayılar Türkçe biçimde: 1.234 adet, %12,5, 1,2 milyon TL. Para "net kazanç" demektir (bize kalan tutar), aksi belirtilmedikçe.
- Başlık kullanma; gerektiğinde kısa madde listesi kullan. Kalın yazıyı yalnız en önemli rakam için kullan.
- Öneri yazıyorsan somut ol: hangi firma, hangi ürün, kaç adet, neden.
- Tablo dökme; seçilmiş rakamları cümle içinde ver.`;

const NOT_ISTEMI = (
  hafta: string | null,
) => `${hafta ? `${hafta} haftası` : "En yeni tamamlanmış hafta"} için ekibe gidecek haftalık analist notunu yaz.

Önce kendin araştır: veri durumu, haftanın özeti ve bir önceki haftayla kıyas, büyümeyi ya da düşüşü taşıyan ürünler, sezonluk ürünlerin (özellikle Pre-Season) durumu ve mümkünse geçen yılla kıyası, para fırsatları (kayıp satış riski, bağlı sermaye, transfer), yönlendirme motorunun önerileri ve veri eksikleri.

Not şu sırayla olsun, kısa tut:
1. Tek cümlelik özet: ağın net kazancı, adedi, haftalık değişim (hangi firmalarla kıyaslandığını belirt).
2. Haftanın hikâyesi: değişimi taşıyan 2-3 kalem, rakamlarla; geri kalan portföy ne yaptı.
3. Kanallar: her firma için bir satır.
4. Para masada: kaçmak üzere olan satış ve rafta bağlı duran sermaye, TL ile.
5. Riskler: sezon ve veri kalitesi.
6. Bu hafta yapılacaklar: en fazla 4 somut madde, TL etkisine göre sıralı (firma, ürün, adet, tahmini TL, gerekçe).`;

export type Mesaj = { rol: "user" | "assistant"; metin: string };
export type AnalizSonucu = {
  cevap: string;
  araclar: { ad: string; girdi: unknown; hata?: string }[];
  model: string;
  tur: number;
  kullanim: {
    giris: number;
    cikis: number;
    onbellekOku: number;
    onbellekYaz: number;
    maliyetUsd: number;
  };
  durum: "tamam" | "kesildi" | "red" | "sinir" | "durduruldu";
  /** Kaç tur hızlı modda çalıştı (0 = hiç). */
  hizliTur: number;
};

// CANLI AKIŞ — asistan paneli beklerken ne olduğunu görsün diye:
//   metin → modelin yazdığı metin parçası (son turda cevabın kendisi)
//   tur   → bir araştırma turu araç çağrısıyla bitti; o ana kadarki metin ara nottur
//   arac  → bir araç çalışmaya başladı
export type Olay =
  | { t: "metin"; d: string }
  | { t: "tur" }
  | { t: "arac"; ad: string; girdi: unknown };

export function anahtarVarMi(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** İstekle model seçilebilir — yalnız bu liste (maliyet sınırı belli kalsın). */
export const IZINLI_MODELLER = Object.keys(FIYAT);

export async function analizEt(
  girdi: {
    soru?: string;
    gecmis?: Mesaj[];
    not?: { hafta: string | null };
    model?: string;
    ekran?: string;
  },
  secenek: {
    olay?: (o: Olay) => void;
    sinyal?: AbortSignal;
    baglam?: Baglam;
  } = {},
): Promise<AnalizSonucu> {
  const { olay, sinyal } = secenek;
  const model =
    girdi.model && IZINLI_MODELLER.includes(girdi.model) ? girdi.model : MODEL;
  const client = new Anthropic();
  const baglam = secenek.baglam ?? new Baglam();
  const bugun = new Date().toISOString().slice(0, 10);
  const istem = girdi.not
    ? NOT_ISTEMI(girdi.not.hafta)
    : String(girdi.soru ?? "");

  // Geçmiş yalnız metin: önceki turların araç çağrıları taşınmaz (her soru
  // kendi araştırmasını yapar). İlk mesaj user olmalı; ardışık aynı rol API'de
  // birleştirilir.
  const gecmis = (girdi.gecmis ?? []).filter((m) => m.metin?.trim()).slice(-10);
  while (gecmis.length && gecmis[0].rol !== "user") gecmis.shift();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...gecmis.map((m) => ({ role: m.rol, content: m.metin })),
    {
      role: "user",
      content: `Bugün: ${bugun}${girdi.ekran ? `\nKullanıcının açık ekranı: ${girdi.ekran}` : ""}\n\n${istem}`,
    },
  ];

  const kullanim = {
    giris: 0,
    cikis: 0,
    onbellekOku: 0,
    onbellekYaz: 0,
    maliyetUsd: 0,
  };
  const araclar: AnalizSonucu["araclar"] = [];
  const [fGiris, fCikis] = FIYAT[model] ?? FIYAT["claude-opus-5-5"];
  let hizli = HIZLI_ACIK && HIZLI_MODELLER.has(model);
  let hizliTur = 0;
  // Maliyet tur tur toplanır: bir analizde hızlı ve standart turlar karışabilir.
  let maliyet = 0;
  const sonuc = (
    cevap: string,
    tur: number,
    durum: AnalizSonucu["durum"],
  ): AnalizSonucu => {
    kullanim.maliyetUsd = Math.round(maliyet * 10000) / 10000;
    return { cevap, araclar, model, tur, kullanim, durum, hizliTur };
  };

  // Kullanıcı "Durdur"a basarsa (ya da bağlantı koparsa) o ana kadarki
  // harcamayla birlikte döner; tamamlanan turların token'ı kayda geçer.
  const durdu = (tur: number) => sonuc("Durduruldu.", tur, "durduruldu");

  for (let tur = 1; tur <= AZAMI_TUR; tur++) {
    if (sinyal?.aborted) return durdu(tur - 1);
    // Sunucu tarafı yedek model: güvenlik filtresi bir isteği nadiren reddederse
    // API aynı isteği uygun modelle aynı çağrı içinde yeniden çalıştırır
    // ("default" = kategoriye göre sunucunun seçtiği yedek). Yedeği olmayan
    // modelde (Haiku) istek tek modelle çalışır, davranış değişmez.
    // Akışla çağrılır: metin parçaları geldikçe panele iletilir.
    const akis = client.beta.messages.stream(
      {
        model,
        max_tokens: 16000,
        betas: [
          "server-side-fallback-2026-07-01",
          ...(hizli ? ["fast-mode-2026-02-01" as const] : []),
        ],
        fallbacks: "default",
        ...(hizli ? { speed: "fast" as const } : {}),
        system: [
          { type: "text", text: SISTEM, cache_control: { type: "ephemeral" } },
        ],
        tools: ARACLAR,
        output_config: { effort: EFOR },
        messages,
      },
      { signal: sinyal, ...(hizli ? { maxRetries: 0 } : {}) },
    ); // hızlıda bekleyip yeniden denemek yerine standarda düş
    if (olay) akis.on("text", (d) => olay({ t: "metin", d }));
    let r: Anthropic.Beta.BetaMessage;
    try {
      r = await akis.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError || sinyal?.aborted)
        return durdu(tur - 1);
      // Hızlı havuz dolu/meşgul ya da hızlı istek reddedildi → bu tur ve
      // sonrası standart hızla (standart yolun olağan yeniden denemeleriyle).
      // Hızlı modun kendi hız sınırı var; standart Opus havuzu ayrıdır.
      // Kimlik hataları (401/403) standartta da düzelmez, olduğu gibi atılır.
      if (
        hizli &&
        e instanceof Anthropic.APIError &&
        e.status !== 401 &&
        e.status !== 403
      ) {
        console.warn(
          `zeka: hızlı mod kullanılamadı (${e.status}), standart hıza geçiliyor:`,
          e.message,
        );
        hizli = false;
        tur--;
        continue;
      }
      throw e;
    }
    kullanim.giris += r.usage.input_tokens;
    kullanim.cikis += r.usage.output_tokens;
    kullanim.onbellekOku += r.usage.cache_read_input_tokens ?? 0;
    kullanim.onbellekYaz += r.usage.cache_creation_input_tokens ?? 0;
    const carpan = r.usage.speed === "fast" ? HIZLI_CARPAN : 1;
    if (carpan > 1) hizliTur++;
    maliyet +=
      (carpan *
        (r.usage.input_tokens * fGiris +
          (r.usage.cache_read_input_tokens ?? 0) * fGiris * 0.1 +
          (r.usage.cache_creation_input_tokens ?? 0) * fGiris * 1.25 +
          r.usage.output_tokens * fCikis)) /
      1e6;

    if (r.stop_reason === "refusal") {
      return sonuc(
        "Bu soruyu yanıtlayamadım. Soruyu farklı biçimde sormayı dene.",
        tur,
        "red",
      );
    }
    if (r.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: r.content });
      continue;
    }
    const istekler = r.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    if (r.stop_reason === "tool_use" && istekler.length) {
      // Tam içerik geri eklenir (düşünme ve yedek-model blokları dahil) — geçmiş yalnız sona eklenir.
      messages.push({ role: "assistant", content: r.content });
      olay?.({ t: "tur" });
      const yanitlar = await Promise.all(
        istekler.map(
          async (t): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            olay?.({ t: "arac", ad: t.name, girdi: t.input });
            try {
              const icerik = await aracCalistir(baglam, t.name, t.input);
              araclar.push({ ad: t.name, girdi: t.input });
              return {
                type: "tool_result",
                tool_use_id: t.id,
                content: icerik,
              };
            } catch (e: any) {
              const hata = String(e?.message ?? e).slice(0, 500);
              araclar.push({ ad: t.name, girdi: t.input, hata });
              return {
                type: "tool_result",
                tool_use_id: t.id,
                is_error: true,
                content: hata,
              };
            }
          },
        ),
      );
      messages.push({ role: "user", content: yanitlar });
      continue;
    }
    const metin = r.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (r.stop_reason === "max_tokens")
      return sonuc(
        metin + "\n\n(Cevap uzunluk sınırında kesildi.)",
        tur,
        "kesildi",
      );
    return sonuc(metin || "Bir cevap üretemedim.", tur, "tamam");
  }
  return sonuc(
    "Araştırma adım sınırına ulaştı; soruyu daraltıp tekrar dene.",
    AZAMI_TUR,
    "sinir",
  );
}
