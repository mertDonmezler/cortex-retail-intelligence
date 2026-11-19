"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Controls.tsx — CORTEX analiz arayüzü için tekrar-kullanılabilir kontrol
// bileşenleri. Amaç: her sayfanın (rankings, stok, sku, compare, stores…) aynı
// sıralama / arama / filtre / CSV / KPI kalıplarını kopyalayıp birbirinden
// kayması yerine TEK ve TUTARLI bir set kullanması.
//
// Kurallar:
//  • Yalnız `react` + `downloadCsv` import edilir; başka bağımlılık yok.
//  • Tema yalnızca mevcut sınıflarla kurulur (card, neon, neon-text, mono,
//    bg-ink-2, text-txt-dim, border-line, rounded…). Yeni renk/sınıf icat edilmez.
//  • Hepsi tipli ve null-güvenli; `strict` altında tsc-temiz derlenir.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState, type ReactNode } from "react";
import { downloadCsv } from "@/lib/csv";

export type SortDir = "asc" | "desc";
type Align = "left" | "right" | "center";

const alignClass = (a?: Align): string =>
  a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
// Başlık içindeki buton, hücrenin hizasını flex ile taklit eder (metin hizası
// buton üzerinde tek başına yetmez, buton blok genişliğinde olduğu için).
const justifyClass = (a?: Align): string =>
  a === "right" ? "justify-end" : a === "center" ? "justify-center" : "justify-start";

// KLAVYE ODAK HALKASI — tek kalıp, tüm interaktif primitiflerde aynı.
// Kalıp `SortableTh`ten kopyalandı (aşağıda satır içinde duruyor, orada
// bilinçli olarak elle yazılı bırakıldı ki o başlığın uzun sınıf dizgesi
// değişmesin). Neden yayıldı: `outline-none` tek başına bırakılan bir öge
// klavyeyle gezildiğinde HİÇ işaret vermiyor — ölçüldü, bu dosyadaki 8
// interaktif ögeden yalnız 1'i (SortableTh) odak halkası basıyordu, kalan 7'si
// (SearchBox, MultiChips'in 4 butonu, SegTabs, RangeMin, CsvBtn) sessizdi.
// `focus-visible` seçildi: fareyle tıklamada halka çıkmaz, yalnız klavye/AT
// gezintisinde çıkar, yani mevcut fare görünümü hiç değişmez.
const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neon";

// ════════════════════════════════════════════════════════════════════════════
// SortableTh — tıklanınca sıralayan tablo başlığı.
// Global `th` stili (uppercase, mono, dim) korunur; aktif kolonda neon vurgu ve
// yön oku (▲/▼) gösterilir, pasif kolonlarda soluk ↕ ipucu.
// ════════════════════════════════════════════════════════════════════════════
export function SortableTh({
  label,
  sortKey,
  active,
  dir,
  onClick,
  align,
}: {
  label: ReactNode;
  /** Bu başlığın temsil ettiği sıralama anahtarı; tık geri verilir. */
  sortKey: string;
  /** Şu an sıralama bu kolonda mı? */
  active: boolean;
  /** Aktif yön (active=false iken görsel olarak kullanılmaz). */
  dir: SortDir;
  /** Anahtarla birlikte tık bildirimi. */
  onClick: (key: string) => void;
  align?: Align;
}) {
  const arrow = active ? (dir === "asc" ? "▲" : "▼") : "↕";
  return (
    <th
      className={`select-none whitespace-nowrap ${alignClass(align)} ${active ? "text-neon" : ""}`}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {/* KLAVYE ERİŞİMİ. Eskiden sıralama `<th onClick>` ile kuruluydu: hücre
          odaklanamıyor, Enter/Space çalışmıyor, ekran okuyucu tıklanabilir
          olduğunu duyurmuyordu — yani sıralama YALNIZ fareyle yapılabiliyordu
          (ölçüldü: tüm sayfalarda 47 başlık). Gerçek bir <button> hepsini bir
          arada çözer: odak sırasına girer, Enter/Space'i tarayıcı kendisi
          tetikler, rolü doğal olarak duyurulur. `aria-sort` th'de kalır (ARIA
          onu hücrede bekler); buton yalnız etkileşimi taşır.
          Görsel sonuç aynı: buton satır-içi blok, hücre hizasını flex ile
          sürdürüyor ve tablo hizası bozulmuyor. */}
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        aria-label={
          typeof label === "string"
            ? `${label} kolonuna göre sırala${active ? (dir === "asc" ? " (şu an artan)" : " (şu an azalan)") : ""}`
            : undefined
        }
        // `font: inherit` şart: buton tarayıcı varsayılanı olan küçük/sans
        // tipografiyi getirir ve `th`nin mono+uppercase+aralıklı görünümünü
        // bozar. Tek satırda aile, boyut, kalınlık ve satır yüksekliğini devralır.
        style={{ font: "inherit", letterSpacing: "inherit" }}
        className={`inline-flex w-full items-center gap-1 ${justifyClass(align)} cursor-pointer
          text-inherit uppercase hover:transition-colors rounded-sm
          hover:text-neon focus:outline-none focus-visible:ring-1 focus-visible:ring-neon`}
      >
        {label}
        <span aria-hidden="true" className={active ? "text-neon" : "opacity-30"}>{arrow}</span>
      </button>
    </th>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// useSort — generic, null-güvenli sıralama kancası.
// Aynı key'e tekrar tıklayınca yön çevrilir; yeni key'e geçince metin alanları
// artan (asc), sayısal alanlar azalan (desc) varsayılanıyla başlar — CORTEX'in
// mevcut tablolarındaki davranışla aynı. null/undefined değerler yönden bağımsız
// olarak en sona düşer.
// ════════════════════════════════════════════════════════════════════════════
export function useSort<T>(
  rows: T[],
  initialKey?: keyof T & string,
  initialDir: SortDir = "desc"
): {
  sorted: T[];
  sortKey: string | null;
  dir: SortDir;
  toggle: (key: string) => void;
} {
  const [sortKey, setSortKey] = useState<string | null>(initialKey ?? null);
  const [dir, setDir] = useState<SortDir>(initialDir);

  const toggle = (key: string): void => {
    if (key === sortKey) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Metinde artan, sayıda azalan başlamak en sezgisel olanı (örn. en pahalı / en çok satan üste).
      setDir(typeof firstDefined(rows, key) === "number" ? "desc" : "asc");
    }
  };

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const factor = dir === "asc" ? 1 : -1;
    // Orijinal diziyi bozmadan kopyalayıp sırala.
    return [...rows].sort((a, b) => {
      const av = get(a, sortKey);
      const bv = get(b, sortKey);
      // null/undefined daima sona — yönden (factor) bağımsız.
      const an = av == null;
      const bn = bv == null;
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      return factor * cmp(av, bv);
    });
  }, [rows, sortKey, dir]);

  return { sorted, sortKey, dir, toggle };
}

// Bilinmeyen şekildeki satırdan alan okuma (record gibi davran, değilse undefined).
function get(row: unknown, key: string): unknown {
  if (row && typeof row === "object") return (row as Record<string, unknown>)[key];
  return undefined;
}

// İlk null/undefined olmayan değeri bul — yeni key'in sayısal mı metin mi olduğunu kestirmek için.
function firstDefined(rows: unknown[], key: string): unknown {
  for (const r of rows) {
    const v = get(r, key);
    if (v != null) return v;
  }
  return undefined;
}

// İki (null olmayan) değeri karşılaştır: sayılar farkla; tarih objeleri zamana
// göre; bool'lar 0/1; geri kalan her şey Türkçe yerele duyarlı metin
// karşılaştırmasıyla. null/undefined ayıklaması çağıran tarafta yapılır.
function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return 0;
    if (Number.isNaN(a)) return 1;
    if (Number.isNaN(b)) return -1;
    return a - b;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);

  return String(a).localeCompare(String(b), "tr", { numeric: true, sensitivity: "base" });
}

// ════════════════════════════════════════════════════════════════════════════
// SearchBox — 🔍 ikonlu stilli arama input'u (kontrollü).
// ════════════════════════════════════════════════════════════════════════════
export function SearchBox({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className ?? "w-full"}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-txt-dim text-sm">
        🔍
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Ara…"}
        className={`card mono text-sm w-full bg-ink-2 outline-none focus:border-neon pl-9 pr-3 py-2 ${FOCUS_RING}`}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MultiChips — çoklu-seçim chip satırı + "tümü / hiçbiri" kısayolları.
// colorOf verilirse seçili chip o renkte (kenar + soluk dolgu); verilmezse neon.
// ════════════════════════════════════════════════════════════════════════════
export function MultiChips<T extends string>({
  options,
  selected,
  onToggle,
  onAll,
  onNone,
  colorOf,
  label,
}: {
  options: readonly T[];
  selected: readonly T[];
  onToggle: (option: T) => void;
  onAll?: () => void;
  onNone?: () => void;
  /** Seçili chip rengi; yoksa neon kullanılır. */
  colorOf?: (option: T) => string;
  /** Satır başına küçük etiket (örn. "Firmalar:"). */
  label?: string;
}) {
  const sel = new Set<T>(selected);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {label && <span className="mono text-xs text-txt-dim mr-1">{label}</span>}
      {options.map((opt) => {
        const on = sel.has(opt);
        const c = colorOf?.(opt) ?? "#1FF80B";
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onToggle(opt)}
            className={`mono text-xs px-3 py-1.5 rounded-full border hover:transition-colors ${FOCUS_RING}`}
            style={
              on
                ? { color: c, borderColor: c + "80", background: c + "1a" }
                : { color: "#7d927d", borderColor: "#1f2a1f" }
            }
          >
            {on ? "✓ " : ""}
            {opt}
          </button>
        );
      })}
      {onAll && (
        <button
          type="button"
          onClick={onAll}
          className={`mono text-[11px] text-txt-dim hover:text-neon ml-1 hover:transition-colors rounded-sm ${FOCUS_RING}`}
        >
          tümü
        </button>
      )}
      {onNone && (
        <button
          type="button"
          onClick={onNone}
          className={`mono text-[11px] text-txt-dim hover:text-neon hover:transition-colors rounded-sm ${FOCUS_RING}`}
        >
          hiçbiri
        </button>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SegTabs — segment toggle (aktif sekme neon). Sıralama/görünüm/metrik seçimi
// gibi tek-seçimli küçük anahtarlar için.
// ════════════════════════════════════════════════════════════════════════════
export function SegTabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: readonly { id: T; label: ReactNode }[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex gap-1 flex-wrap ${className ?? ""}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`mono text-sm px-4 py-2 rounded-lg hover:transition-colors ${FOCUS_RING} ${
            active === t.id ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// RangeMin — sayısal "min" filtre input'u (örn. min hafta, min satış).
// ════════════════════════════════════════════════════════════════════════════
export function RangeMin({
  label,
  value,
  onChange,
  suffix,
  step = 1,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** Input sağına küçük birim etiketi (örn. "hf", "adet"). */
  suffix?: string;
  step?: number;
  min?: number;
}) {
  return (
    <label className="mono text-xs text-txt-dim flex items-center gap-2">
      {label}
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Math.max(min, Number.isFinite(n) ? n : min));
        }}
        className={`w-20 mono text-sm px-2 py-2 rounded-lg bg-ink-2 border border-line outline-none focus:border-neon text-txt ${FOCUS_RING}`}
      />
      {suffix && <span className="text-txt-dim">{suffix}</span>}
    </label>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// CsvBtn — downloadCsv'yi saran "⬇ CSV" butonu. rows boşsa otomatik disabled.
// cols, downloadCsv'nin beklediği { key, label } başlık dizisidir.
// ════════════════════════════════════════════════════════════════════════════
export function CsvBtn<T extends Record<string, unknown>>({
  filename,
  rows,
  cols,
  label = "⬇ CSV",
}: {
  filename: string;
  rows: T[];
  cols: { key: keyof T & string; label: string }[];
  label?: string;
}) {
  const empty = rows.length === 0;
  return (
    <button
      type="button"
      disabled={empty}
      onClick={() => {
        if (empty) return;
        // downloadCsv başlık tipi { key: string; label: string } — keyof daraltmasını gevşet.
        downloadCsv(filename, rows, cols as { key: string; label: string }[]);
      }}
      className={`mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon hover:transition-colors disabled:opacity-40 disabled:hover:border-line disabled:hover:text-txt-dim disabled:cursor-not-allowed ${FOCUS_RING}`}
    >
      {label}
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// StatCard — küçük KPI kartı (etiket + değer + opsiyonel alt satır).
// color verilirse değer o renkte; yoksa neon-text varsayılanı.
//
// İKİ EKLEME (dense, chip) TAMAMEN ADDITIVE'DİR. Kod tabanında 31 JSX çağrısı
// var (compare, insights, product, rankings, sku, stock-alerts, stok, stores,
// upload) ve hiçbiri bu iki prop'u geçmiyor; ikisi de verilmediğinde basılan
// HTML eskisiyle BAYT BAYT aynıdır (react-dom/server ile ölçüldü, 16 farklı
// prop kombinasyonunda fark 0). Bu yüzden yeni yoğun varyant, mevcut dokuz
// sayfanın görünümünü hiçbir şekilde değiştirmiyor.
// ════════════════════════════════════════════════════════════════════════════
export function StatCard({
  label,
  value,
  sub,
  color,
  dense = false,
  chip,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Değer rengi (hex/css); yoksa neon. */
  color?: string;
  /**
   * Yoğun varyant: dolgu p-4 → p-3, değer text-2xl → text-xl, rakamlar
   * `tabular-nums` ile eşit genişlikte. Dört kartın tek satırda 92 px'e
   * sığması için; sayısal kolonların dikey hizası da bununla düzeliyor.
   */
  dense?: boolean;
  /**
   * Değerin yanında birim rozeti — "PSF" (brüt raf değeri) / "NET" (akış).
   * Aynı ekranda brüt ve net tutar yan yana durduğunda hangisinin ne olduğu
   * yalnız alt satırdan okunuyordu; rozet bunu değerin kendisine yapıştırır.
   */
  chip?: { label: string; color: string };
}) {
  // Etiket/alt satır: varsayılanda text-[10px] (mevcut 31 çağrının görünümü
  // KORUNUR), dense'te text-[11px]. Neden: yeni yönetici özeti sayfası
  // tipografiyi 4 kademeye kilitliyor ve en küçük kademe 11 px — 10 px'lik
  // etiket o sayfada erişilebilirlik ölçütünü (11 px altı font = 0) düşürüyor.
  // Yani boyut farkı dense'in bir yan etkisi değil, amacının parçası.
  const smallTxt = dense ? "text-[11px]" : "text-[10px]";
  const valueCls =
    `${dense ? "text-xl tabular-nums" : "text-2xl"} font-bold mono mt-1 ${color ? "" : "neon-text"}`;
  const valueStyle = color ? { color } : undefined;

  return (
    <div className={`card ${dense ? "p-3" : "p-4"}`}>
      <div className={`mono ${smallTxt} text-txt-dim tracking-wider`}>{label}</div>
      {chip ? (
        // ROZETLİ KOLDA DEĞER AYRI BİR <span>'E ALINIR. Sebep sunum modu:
        // `DemoMask.tsx:107` yalnız YAPRAK düğümleri maskeliyor (children.length
        // === 0). Rozeti değer kabının içine kardeş olarak koysaydık kap artık
        // yaprak olmaz ve içindeki tutar sunumda MASKELENMEZ, yani para sızar.
        // Değer kendi yaprağında kalıyor, rozet ayrı yaprak.
        <div className={`${valueCls} flex items-baseline gap-1.5`}>
          <span style={valueStyle}>{value}</span>
          <span
            className="mono text-[11px] font-normal px-1.5 py-0.5 rounded border shrink-0"
            // MultiChips'in mevcut kalıbı: metin rengi tam, kenar +'40',
            // dolgu +'14' — yeni renk icat edilmiyor, çağıran ACT/RETAILER
            // haritasından bir renk geçiyor.
            style={{
              color: chip.color,
              borderColor: chip.color + "40",
              background: chip.color + "14",
            }}
          >
            {chip.label}
          </span>
        </div>
      ) : (
        <div className={valueCls} style={valueStyle}>
          {value}
        </div>
      )}
      {sub != null && sub !== "" && (
        <div className={`mono ${smallTxt} text-txt-dim mt-0.5`}>{sub}</div>
      )}
    </div>
  );
}
