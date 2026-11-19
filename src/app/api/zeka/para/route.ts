import { NextRequest, NextResponse } from "next/server";
import { paraOzeti } from "@/lib/zeka/araclar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?kanal=&barkod= → asistan panelinin "Masada para" kartı.
// Model çağrısı YOK, ücretsiz: yönlendirme motorunun önerilerinin TL karşılığı
// (lib/zeka/araclar.ts paraOzeti — analistin para_firsatlari aracıyla aynı hesap).
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  try {
    const d = await paraOzeti({ kanal: q.get("kanal") ?? undefined, barkod: q.get("barkod") ?? undefined });
    return NextResponse.json(d);
  } catch (e: any) {
    console.error("zeka/para hatası:", e);
    return NextResponse.json({ error: "Para özeti hesaplanamadı." }, { status: 500 });
  }
}
