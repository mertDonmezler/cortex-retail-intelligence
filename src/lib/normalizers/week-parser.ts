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

// Türkçe büyük İ, JS toLowerCase'inde bozulur: "HAZİRAN".toLowerCase() =
// "hazi̇ran" (i + birleşik nokta U+0307) — sözlükteki "haziran" ile EŞLEŞMEZ ve
// dosya sessizce yanlış haftaya (weekFromToday) düşer. Ay eşleştirmeden önce
// İ→i / I→ı çevir, kalan birleşik noktaları temizle.
// EXPORT: doğrudan test edilebilmesi için dışa açık (davranışı iç kullanımla aynı).
export function foldTr(s: string): string {
  return s.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase().replace(/̇/g, "");
}

// EXPORT: yıl sınırı davranışı tek başına test edilebilsin (bkz. scripts/test.ts §2b).
export function smartYear(targetMonth: number, fallbackYear?: number): number {
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

// ISO hafta numarasının Pazartesi'si (örn. 2026 W19 → 2026-05-04).
// EXPORT: Armağan'ın TEK tarihleme yolu bu; hizalama tek başına test edilir.
export function isoWeekMonday(year: number, wk: number): Date {
  const simple = new Date(Date.UTC(year, 0, 1 + (wk - 1) * 7));
  const dow = simple.getUTCDay();
  const monday = new Date(simple);
  const diff = dow <= 4 ? dow - 1 : dow - 8;
  monday.setUTCDate(simple.getUTCDate() - diff);
  return monday;
}

// Takvim geçerliliği — "31.04" / "32 Mart" gibi uydurma tarihler Postgres
// (date not null) insert'ini düşürüp dosyayı sessizce kaybettirmesin.
// EXPORT: aynı kontrol huppaluppo.ts'in dosya-içi tarih aralığında da kullanılır
// (tek kaynak) ve doğrudan test edilir.
export function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function range(
  y1: number, m1: number, d1: number, y2: number, m2: number, d2: number
): WeekRange | null {
  if (!isValidYmd(y1, m1, d1) || !isValidYmd(y2, m2, d2)) return null;
  const start = iso(y1, m1, d1), end = iso(y2, m2, d2);
  if (start > end) return null; // başlangıç bitişten sonra olamaz (hatalı/karışık aralık)
  return { start, end };
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

  const nameL = foldTr(name);
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

  // 3b) Gün aralığı + tek sayısal ay: "21-27.09.2026" ya da "21-27.09" (Nezih
  //     Eylül 2026'dan itibaren böyle adlandırıyor). Yıl yazılmamışsa geçmiş
  //     kuralıyla çıkarılır. Ay geçişi bu biçimde yazılamaz (27-03.10 gibi) →
  //     range() başlangıç > bitiş olduğu için null döner, sessizce yanlış hafta vermez.
  // Baştaki gün önünde rakam/nokta/alt çizgi OLAMAZ: "31.04-06.05" gibi geçersiz
  // iki-tarihli bir adın içindeki "04-06.05" parçası "4-6 Mayıs" diye yakalanmasın.
  // Aralık bir HAFTA gibi olmalı (5-7 gün): "rapor 2-3.1" ya da "v1-2.3" gibi
  // sürüm/sıra numaraları hafta sanılıp aylar önceki bir haftanın üzerine
  // yazılmasın. Yıl 4 ya da 2 hane ("21-27.09.25" → 2025); başka uzunluk eşleşmez.
  const oneNum = name.match(/(?<![\d._])(\d{1,2})\s*-\s*(\d{1,2})[._](\d{1,2})(?:[._](\d{4}|\d{2}))?(?![\d]|[._]\d)/);
  if (oneNum && +oneNum[2] - +oneNum[1] >= 5 && +oneNum[2] - +oneNum[1] <= 7) {
    const d1 = +oneNum[1], d2 = +oneNum[2], mo = +oneNum[3];
    if (mo >= 1 && mo <= 12) {
      const y = oneNum[4] ? (oneNum[4].length === 2 ? 2000 + +oneNum[4] : +oneNum[4]) : smartYear(mo);
      const r = range(y, mo, d1, y, mo, d2);
      if (r) return r;
    }
  }

  // 4) ISO hafta no: "w20_2026", "W-19 2026", "W-21" (yıl opsiyonel → çıkarımla)
  //    Armağan dosyaları "MYTHOS CARD W-19 2026 RAPOR" gibi adlandırılıyor.
  const wn = nameL.match(/\bw[-_\s]*(\d{1,2})(?:[-_\s]+(\d{4}))?/);
  if (wn) {
    const wk = +wn[1];
    if (wk >= 1 && wk <= 53) {
      let year = wn[2] ? +wn[2] : new Date().getFullYear();
      let monday = isoWeekMonday(year, wk);
      // Yıl yazılmamış ve hesaplanan hafta gelecekteyse, bir önceki yıla aittir
      // (haftalık veri her zaman geçmiştir).
      if (!wn[2] && monday.getTime() > Date.now()) {
        year -= 1;
        monday = isoWeekMonday(year, wk);
      }
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
    }
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

// Dosya adından çıkmazsa: SON TAMAMLANMIŞ hafta (bir önceki Pzt–Paz) — son çare.
// Haftalık satış/stok raporları geçmiş (biten) haftaya aittir; bu yüzden içinde
// bulunduğumuz YARIM haftaya değil, tamamlanmış haftaya yazılır. Tarihsiz dosyaların
// (ör. Nezih raporStokGC…) yanlışlıkla bir sonraki/yarım haftaya düşmesini önler.
// SAAT DİLİMİ: hesap BAŞTAN SONA UTC + sabit TR ofseti ile yapılır.
//
// Eski sürüm günü/tarihi YEREL getter'larla (getDay/getDate/setDate) okuyup
// sonucu toISOString() ile UTC'ye basıyordu; compute.ts'teki sonTamamlanmisHafta
// ise mutlak zamana 3 saat ekleyip tamamen getUTC* ile çalışıyor. İki çapa
// TZ=Europe/Istanbul'da 00:00-03:00 aralığında AYRIŞIYOR (ölçüldü: an
// 2026-09-14T22:30Z, yerel Salı 01:30 → iki fonksiyon iki farklı hafta veriyor).
// Sonucu ağır: tarihsiz bir dosya gece yüklenirse BİR HAFTA ÖNCESİNE yazılır ve
// yükleme DELETE+INSERT olduğu için o haftanın gerçek verisini siler.
export function weekFromToday(ofsetSaat = 3): WeekRange {
  const t = new Date(Date.now() + ofsetSaat * 3600_000);
  const pazartesiFarki = (t.getUTCDay() + 6) % 7; // Pazartesi = 0
  const monMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
    - (pazartesiFarki + 7) * 86_400_000;          // bir önceki haftanın Pazartesi'si
  return {
    start: new Date(monMs).toISOString().slice(0, 10),
    end: new Date(monMs + 6 * 86_400_000).toISOString().slice(0, 10),
  };
}
