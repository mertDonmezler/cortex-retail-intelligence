"use client";

import { useEffect, useRef, useState } from "react";

// Sayıyı 0'dan hedefe sayan animasyon (ease-out).
export function AnimatedNumber({
  value, duration = 900, format = (n: number) => Math.round(n).toLocaleString("tr-TR"),
}: { value: number; duration?: number; format?: (n: number) => string }) {
  const [display, setDisplay] = useState(0);
  const raf = useRef<number>();
  const startRef = useRef<number>();

  useEffect(() => {
    cancelAnimationFrame(raf.current!);
    startRef.current = undefined;
    const from = 0;
    const to = value;
    // Arka plandaki sekmede rAF kısılır/durur → sayı 0'da TAKILI kalır (sekmeye
    // dönünce de tetiklenmez). Gizliyken animasyonsuz yaz; her durumda süre sonunda
    // nihai değere oturtan bir zamanlayıcı güvencesi tut.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      setDisplay(to);
      return;
    }
    const settle = setTimeout(() => setDisplay(to), duration + 120);
    function tick(ts: number) {
      if (startRef.current === undefined) startRef.current = ts;
      const t = Math.min(1, (ts - startRef.current) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    }
    raf.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf.current!); clearTimeout(settle); };
  }, [value, duration]);

  return <>{format(display)}</>;
}
