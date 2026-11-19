// ── İSTEK PARAMETRESİ DOĞRULAMA — TEK KAYNAK ──
//
// NEDEN: 8 uç (compare, sku, sku-detail, store-detail, overview, rankings,
// export, weekly-report) bozuk bir `week`/`a`/`b` değerini doğrudan sorguya
// geçiriyordu; Postgres `date` ayrıştırması düşünce yanıt 500 "Sunucu hatası"
// oluyordu (ölçüldü: 8/8 uç). Kullanıcı bozuk bir bağlantıya tıkladığında
// "sunucu çöktü" görüyor, Vercel logunda da gerçek hatalar bu gürültünün
// arasında kayboluyordu. /api/health'te doğru kalıp (biçim + TAKVİM kontrolü)
// zaten vardı ama paylaşılmıyordu — buraya taşındı.
//
// TAKVİM KONTROLÜ ŞART: "2026-13-99" biçim düzenine uyar ama tarih değildir;
// yalnız regex ile geçer ve yine 500 üretir.
import { NextResponse } from "next/server";
import { RETAILERS } from "@/lib/normalizers/types";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Geçerli bir ISO gün mü (biçim + takvim)? */
export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Hafta parametresi: geçerli gün olmalı. (Pazartesi zorunluluğu YOK —
 *  weekly_summary'de yalnız Pazartesi var, Pazartesi olmayan değer boş küme
 *  döndürür; bu bir hata değil, yalnızca veri yokluğudur.) */
export const isWeek = isYmd;

/** Bilinen perakendeci mi? Bilinmeyen ad boş sonuç yerine 400 almalı — aksi
 *  halde "Yok" gibi bir yazım hatası sessizce boş ekran üretir. */
export function isRetailer(s: unknown): s is string {
  return typeof s === "string" && (RETAILERS as readonly string[]).includes(s);
}

/** Tek biçimli 400. Mesaj kullanıcıya yardımcı, iç ayrıntı taşımaz. */
export function badRequest(msg: string): NextResponse {
  return NextResponse.json({ error: msg }, { status: 400 });
}

/**
 * Opsiyonel hafta parametresi: yoksa `undefined`, varsa geçerli olmalı.
 * Geçersizse `null` döner — çağıran 400 basar.
 */
export function optionalWeek(raw: string | null): string | undefined | null {
  if (raw == null || raw === "") return undefined;
  return isWeek(raw) ? raw : null;
}
