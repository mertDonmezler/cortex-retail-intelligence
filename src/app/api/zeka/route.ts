import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { analizEt, anahtarVarMi, MODEL, IZINLI_MODELLER, type Mesaj } from "@/lib/zeka/ajan";
import { Baglam, veriImzasi } from "@/lib/zeka/araclar";
import { oturumAnahtari, kotaDurumu, kotaAl, kotaKapat, buAyHarcama, notBul, notBellegeYaz, puanVer } from "@/lib/zeka/kota";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Analist birkaç araç turu atar; Opus'ta tipik 20-80 sn.
export const maxDuration = 300;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// GET                                    → durum + bu oturumun kalan hakkı + bu ayın harcaması
// POST {soru, gecmis?, ekran?, akis?}    → "CORTEX'e sor"
// POST {not: true, hafta?, yenile?, akis?} → haftalık analist notu; aynı veriyle
//                                          yazılmış not varsa kayıttan gelir (ücretsiz, hak düşmez)
// PATCH {id, puan: 1 | -1 | null}        → cevaba geri bildirim
// KOTA: oturum başına 10 dakikada 10 soru (lib/zeka/kota.ts); aşılırsa 429.
//
// akis: true → yanıt NDJSON akışı (asistan paneli bunu kullanır):
//   {t:"basla", kota} · {t:"metin", d} · {t:"tur"} · {t:"arac", ad, girdi} · … · {t:"son", …sonuç} | {t:"hata", error}
// Kota dolu, kayıtlı not ya da doğrulama hatası akış açılmadan düz JSON döner.
// Panel "Durdur"a basınca bağlantı kapanır; analiz o turda durur, o ana kadarki
// harcama kayda geçer.
export async function GET(req: NextRequest) {
  const kota = anahtarVarMi() ? await kotaDurumu(supabaseAdmin(), oturumAnahtari(req)) : null;
  return NextResponse.json({ hazir: anahtarVarMi(), model: MODEL, kota });
}

function hataYaniti(e: unknown): { mesaj: string; status: number } {
  if (e instanceof Anthropic.AuthenticationError) return { mesaj: "API anahtarı geçersiz.", status: 502 };
  if (e instanceof Anthropic.RateLimitError) return { mesaj: "Analist şu an yoğun; birazdan tekrar dene.", status: 429 };
  if (e instanceof Anthropic.APIError) {
    console.error("zeka API hatası:", e.status, e.message);
    return { mesaj: `Analist hatası (${e.status}).`, status: 502 };
  }
  console.error("zeka hatası:", e);
  return { mesaj: "Analiz sırasında bir hata oluştu.", status: 500 };
}

export async function POST(req: NextRequest) {
  if (!anahtarVarMi()) {
    return NextResponse.json({ error: "Analist henüz bağlı değil: sunucuda ANTHROPIC_API_KEY tanımlı değil." }, { status: 503 });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 }); }

  const not = body?.not === true;
  const akis = body?.akis === true;
  const soru = typeof body?.soru === "string" ? body.soru.trim().slice(0, 2000) : "";
  const hafta = typeof body?.hafta === "string" && ISO.test(body.hafta) ? body.hafta : null;
  if (!not && !soru) return NextResponse.json({ error: "Soru boş" }, { status: 400 });
  const gecmis: Mesaj[] = Array.isArray(body?.gecmis)
    ? body.gecmis
        .filter((m: any) => (m?.rol === "user" || m?.rol === "assistant") && typeof m?.metin === "string")
        .slice(-10)
        .map((m: any) => ({ rol: m.rol, metin: m.metin.slice(0, 6000) }))
    : [];
  // Model kıyası için: yalnız izinli liste (ajan.ts IZINLI_MODELLER); aksi varsayılan.
  const model = typeof body?.model === "string" && IZINLI_MODELLER.includes(body.model) ? body.model : undefined;
  // Asistanın açık olduğu ekran ve oradaki seçim (ör. "Ürün karşılaştırma · ürün: …").
  const ekran = typeof body?.ekran === "string" ? body.ekran.slice(0, 600) : undefined;

  const db = supabaseAdmin();
  const oturum = oturumAnahtari(req);
  const baglam = new Baglam();

  // Haftalık not: aynı veriyle (ve aynı modelle) yazılmış not varsa kayıttan.
  let anahtar: string | undefined;
  if (not) {
    anahtar = `${hafta ?? "son"}|${model ?? MODEL}|${await veriImzasi(baglam)}`;
    if (body?.yenile !== true) {
      const k = await notBul(db, anahtar);
      if (k) {
        return NextResponse.json({
          cevap: k.cevap, araclar: [], model: k.model, tur: 0, sureMs: 0, durum: "tamam", id: k.id,
          kullanim: { giris: 0, cikis: 0, onbellekOku: 0, onbellekYaz: 0, maliyetUsd: 0 },
          kayitli: { ts: k.ts, maliyetUsd: k.maliyetUsd, aracSayisi: k.aracSayisi },
          kota: await kotaDurumu(db, oturum),
        });
      }
    }
  }

  const hak = await kotaAl(db, oturum, not ? "not" : "soru", not ? "haftalık not" : soru, model ?? MODEL, anahtar);
  if (!hak.izin) {
    const dk = Math.ceil(hak.kota.sifirlanmaSn / 60);
    return NextResponse.json(
      { error: `10 dakikada en fazla ${hak.kota.limit} soru sorulabiliyor. ${dk} dakika sonra tekrar sorabilirsin.`, kota: hak.kota },
      { status: 429, headers: { "Retry-After": String(hak.kota.sifirlanmaSn) } }
    );
  }

  const bas = Date.now();
  const calistir = async (olay?: (o: object) => void, sinyal?: AbortSignal) => {
    const sonuc = await analizEt(not ? { not: { hafta }, model } : { soru, gecmis, model, ekran }, { olay, sinyal, baglam });
    const sureMs = Date.now() - bas;
    await kotaKapat(db, hak.id, {
      durum: sonuc.durum, model: sonuc.model, aracSayisi: sonuc.araclar.length, turSayisi: sonuc.tur,
      giris: sonuc.kullanim.giris, cikis: sonuc.kullanim.cikis, onbellek: sonuc.kullanim.onbellekOku,
      maliyetUsd: sonuc.kullanim.maliyetUsd, sureMs, cevap: sonuc.cevap,
    });
    if (not && anahtar && sonuc.durum === "tamam") {
      notBellegeYaz(anahtar, { id: hak.id, ts: new Date().toISOString(), cevap: sonuc.cevap, model: sonuc.model, maliyetUsd: sonuc.kullanim.maliyetUsd, aracSayisi: sonuc.araclar.length });
    }
    console.log(`zeka: ${sonuc.model} · ${sonuc.durum} · ${sonuc.tur} tur (hızlı ${sonuc.hizliTur}) · ${sonuc.araclar.length} araç · $${sonuc.kullanim.maliyetUsd} · ${sureMs} ms`);
    return { ...sonuc, sureMs, id: hak.id, kota: { ...hak.kota, buAyUsd: await buAyHarcama(db) } };
  };
  const hatayiKapat = async (e: unknown) => {
    await kotaKapat(db, hak.id, { durum: "hata", sureMs: Date.now() - bas });
    return hataYaniti(e);
  };

  if (!akis) {
    try { return NextResponse.json(await calistir()); }
    catch (e) { const h = await hatayiKapat(e); return NextResponse.json({ error: h.mesaj }, { status: h.status }); }
  }

  const kodla = new TextEncoder();
  const iptal = new AbortController();
  req.signal?.addEventListener?.("abort", () => iptal.abort());
  const akisGovdesi = new ReadableStream<Uint8Array>({
    async start(c) {
      let acik = true;
      const yaz = (o: object) => {
        if (!acik) return;
        try { c.enqueue(kodla.encode(JSON.stringify(o) + "\n")); } catch { acik = false; }
      };
      yaz({ t: "basla", kota: hak.kota });
      try { yaz({ t: "son", ...(await calistir(yaz, iptal.signal)) }); }
      catch (e) { const h = await hatayiKapat(e); yaz({ t: "hata", error: h.mesaj }); }
      if (acik) { acik = false; try { c.close(); } catch { /* bağlantı zaten kapandı */ } }
    },
    cancel() { iptal.abort(); },
  });
  return new Response(akisGovdesi, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}

export async function PATCH(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 }); }
  const id = Number(body?.id);
  const puan = body?.puan === 1 || body?.puan === -1 ? body.puan : body?.puan === null ? null : undefined;
  if (!Number.isInteger(id) || id <= 0 || puan === undefined) return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  const ok = await puanVer(supabaseAdmin(), id, oturumAnahtari(req), puan);
  return NextResponse.json({ ok });
}
