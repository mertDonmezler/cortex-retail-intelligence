"use client";

// Mini trend çizgisi (saf SVG, bağımlılıksız).
export function Sparkline({
  data, width = 80, height = 24, color = "#1FF80B", fill = true,
}: { data: number[]; width?: number; height?: number; color?: string; fill?: boolean }) {
  if (!data || data.length < 2) {
    return <svg width={width} height={height} />;
  }
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = pts[pts.length - 1];

  return (
    <svg width={width} height={height} className="overflow-visible">
      {fill && <path d={area} fill={color} fillOpacity={0.08} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2} fill={color} />
    </svg>
  );
}
