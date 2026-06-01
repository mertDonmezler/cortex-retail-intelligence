// Dosya adından hafta tarihi çıkaran parser — Python base.py'nin portu.
// Desteklenen desenler:
//   "4-10_Mayıs", "23 - 29 Mart"          → tek Türkçe ay
//   "23 Şubat-1 Mart", "29 Aralık-4 Ocak" → iki Türkçe ay (yıl geçişi dahil)
//   "06.04-12.04", "06_04-12_04"          → sayısal ay (Nezih/DR-yeni)
//   "2026-05-04_to_2026-05-10"            → ISO
//   "w20_2026"                            → ISO hafta no

const TURKISH_MONTHS: Record<string, number> = {
  ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5,
  haziran: 6, temmuz: 7, ağustos: 8, agustos: 8, eylül: 9, eylul: 9,
  ekim: 10, kasım: 11, kasim: 11, aralık: 12, aralik: 12,
};

function smartYear(targetMonth: number, fallbackYear?: number): number {
  const now = new Date();
  const fy = fallbackYear ?? now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  // Haftalık satış verisi geçmişe aittir: hedef ay içinde bulunduğumuz aydan
  // ileri ise (ör. Haziran'dayken "Aralık") bir önceki yıla aittir.
  return targetMonth > currentMonth ? fy - 1 : fy;
}

function iso(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

// Takvim geçerliliği — "31.04" / "32 Mart" gibi uydurma tarihler Postgres
// (date not null) insert'ini düşürüp dosyayı sessizce kaybettirmesin.
function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function range(
  y1: number, m1: number, d1: number, y2: number, m2: number, d2: number
): WeekRange | null {
  if (!isValidYmd(y1, m1, d1) || !isValidYmd(y2, m2, d2)) return null;
  return { start: iso(y1, m1, d1), end: iso(y2, m2, d2) };
}

export interface WeekRange {
  start: string;
  end: string;
}

export function parseWeekFromFilename(filename: string): WeekRange | null {
  const name = filename.replace(/\.xlsx?$/i, "");

  // 1) ISO aralık
  const isoMatch = name.match(
    /(\d{4})-(\d{2})-(\d{2}).{0,8}?(\d{4})-(\d{2})-(\d{2})/
  );
  if (isoMatch) {
    const r = range(+isoMatch[1], +isoMatch[2], +isoMatch[3], +isoMatch[4], +isoMatch[5], +isoMatch[6]);
    if (r) return r;
  }

  const nameL = name.toLowerCase();
  const monthsAlt = Object.keys(TURKISH_MONTHS).join("|");

  // 2a) İki Türkçe ay (ay/yıl geçişi)
  const twoMonth = nameL.match(
    new RegExp(`(\\d{1,2})\\s*(${monthsAlt})\\s*-\\s*(\\d{1,2})\\s*(${monthsAlt})`)
  );
  if (twoMonth) {
    const d1 = +twoMonth[1], mo1 = TURKISH_MONTHS[twoMonth[2]];
    const d2 = +twoMonth[3], mo2 = TURKISH_MONTHS[twoMonth[4]];
    const y1 = smartYear(mo1);
    const y2 = mo2 < mo1 ? y1 + 1 : y1;
    const r = range(y1, mo1, d1, y2, mo2, d2);
    if (r) return r;
  }

  // 2b) Tek Türkçe ay
  for (const [mName, mNum] of Object.entries(TURKISH_MONTHS)) {
    const re = new RegExp(`(\\d{1,2})[\\s_]*-[\\s_]*(\\d{1,2})[\\s_]+${mName}`);
    const m = nameL.match(re);
    if (m) {
      const y = smartYear(mNum);
      const r = range(y, mNum, +m[1], y, mNum, +m[2]);
      if (r) return r;
    }
  }

  // 3) Sayısal ay: "06.04-12.04" veya "06_04-12_04"
  const numMatch = name.match(/(\d{1,2})[._](\d{1,2})\s*-\s*(\d{1,2})[._](\d{1,2})/);
  if (numMatch) {
    const d1 = +numMatch[1], mo1 = +numMatch[2];
    const d2 = +numMatch[3], mo2 = +numMatch[4];
    if (mo1 >= 1 && mo1 <= 12 && mo2 >= 1 && mo2 <= 12) {
      const y1 = smartYear(mo1);
      const y2 = mo2 < mo1 ? y1 + 1 : y1;
      const r = range(y1, mo1, d1, y2, mo2, d2);
      if (r) return r;
    }
  }

  // 4) ISO hafta no: w20_2026
  const wn = nameL.match(/w(\d{1,2})[\s_-]*(\d{4})/);
  if (wn) {
    const year = +wn[2], wk = +wn[1];
    // ISO haftanın Pazartesi'si
    const simple = new Date(Date.UTC(year, 0, 1 + (wk - 1) * 7));
    const dow = simple.getUTCDay();
    const monday = new Date(simple);
    const diff = dow <= 4 ? dow - 1 : dow - 8;
    monday.setUTCDate(simple.getUTCDate() - diff);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
      start: monday.toISOString().slice(0, 10),
      end: sunday.toISOString().slice(0, 10),
    };
  }

  return null;
}

// Kanonik hafta: başlangıcı ISO hafta Pazartesi'sine hizalar (bitiş = +6 gün).
// Perakendeciler aynı haftayı farklı günle etiketleyebilir (ör. DR Salı, Toyzz
// Pazartesi). Hepsini Pazartesi'ye çekince aynı hafta tek grupta birleşir.
export function canonicalWeek(range: WeekRange): WeekRange {
  const d = new Date(range.start + "T00:00:00Z");
  if (isNaN(d.getTime())) return range;
  const back = (d.getUTCDay() + 6) % 7; // Pazartesi'ye kaç gün geri (Pzt=0 … Paz=6)
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() - back);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return { start: mon.toISOString().slice(0, 10), end: sun.toISOString().slice(0, 10) };
}

// Dosya adından çıkmazsa: bugünün haftası (Pzt–Paz) — son çare
export function weekFromToday(): WeekRange {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // Pazartesi = 0
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}
