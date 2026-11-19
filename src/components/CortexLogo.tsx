import type { CSSProperties } from "react";

// CORTEX işareti. Dinlenmede eski satır içi SVG ile piksel piksel aynıdır;
// kollar ayrı path'lere bölündü ama tek <g> içinde .7 opaklıkla birleşir.
// Beş uç düğüm beş kanaldır. <html data-mesgul> varken saat yönünde tek tek
// yanar (globals.css → cx-tara); hook yok, sunucu bileşeninde de kullanılır.
const UCLAR: [number, number][] = [[16, 7], [24, 12], [24, 20], [8, 20], [8, 12]];

export function CortexLogo({ boyut = 26, className = "" }: { boyut?: number; className?: string }) {
  return (
    <svg className={"cx-logo " + className} width={boyut} height={boyut} viewBox="0 0 32 32" aria-hidden="true">
      <path className="cx-altigen" d="M16 2 L28 9 V23 L16 30 L4 23 V9 Z" fill="none"
        stroke="#1FF80B" strokeWidth="1.5" opacity="0.4" />
      <circle cx="16" cy="16" r="3" fill="#1FF80B" />
      <g className="cx-kollar" opacity="0.7" stroke="#1FF80B" strokeWidth="1.2">
        {UCLAR.map(([x, y], i) => (
          <path key={i} className="kol" style={{ "--n": i } as CSSProperties} d={`M16 16 L${x} ${y}`} />
        ))}
      </g>
      {UCLAR.map(([x, y], i) => (
        <circle key={i} className="uc" style={{ "--n": i } as CSSProperties} cx={x} cy={y} r="1.6" fill="#1FF80B" />
      ))}
    </svg>
  );
}
