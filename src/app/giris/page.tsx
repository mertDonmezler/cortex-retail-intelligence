"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

const LEN = 6;

export default function GirisPage() {
  return (
    <Suspense fallback={null}>
      <GirisForm />
    </Suspense>
  );
}

function GirisForm() {
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [digits, setDigits] = useState<string[]>(Array(LEN).fill(""));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  const pin = digits.join("");

  function setAt(i: number, v: string) {
    const next = [...digits];
    next[i] = v;
    setDigits(next);
  }

  function onChange(i: number, raw: string) {
    setErr(null);
    const v = raw.replace(/\D/g, "");
    if (!v) {
      setAt(i, "");
      return;
    }
    // Birden çok rakam (yapıştırma) → kutulara dağıt.
    if (v.length > 1) {
      const arr = [...digits];
      let j = i;
      for (const ch of v.split("")) {
        if (j >= LEN) break;
        arr[j] = ch;
        j++;
      }
      setDigits(arr);
      const last = Math.min(i + v.length, LEN - 1);
      refs.current[last]?.focus();
      if (arr.join("").length === LEN) submit(arr.join(""));
      return;
    }
    setAt(i, v);
    if (i < LEN - 1) refs.current[i + 1]?.focus();
    else {
      const full = [...digits];
      full[i] = v;
      if (full.join("").length === LEN) submit(full.join(""));
    }
  }

  function onKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      refs.current[i - 1]?.focus();
      setAt(i - 1, "");
    } else if (e.key === "ArrowLeft" && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < LEN - 1) {
      refs.current[i + 1]?.focus();
    } else if (e.key === "Enter" && pin.length === LEN) {
      submit(pin);
    }
  }

  async function submit(value: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.ok) {
        setErr(d?.error || "Hatalı PIN");
        setShake(true);
        setDigits(Array(LEN).fill(""));
        setTimeout(() => setShake(false), 500);
        refs.current[0]?.focus();
        return;
      }
      // Başarılı → istenen sayfaya dön (router cache'i atlamak için hard nav).
      window.location.assign(next.startsWith("/") ? next : "/");
    } catch {
      setErr("Bağlantı hatası, tekrar dene");
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-ink">
      <div className="w-full max-w-sm">
        {/* Logo + başlık */}
        <div className="flex flex-col items-center mb-8 select-none">
          <svg width="44" height="44" viewBox="0 0 32 32" className="mb-3">
            <path d="M16 2 L28 9 V23 L16 30 L4 23 V9 Z" fill="none" stroke="#1FF80B" strokeWidth="1.5" opacity="0.4" />
            <circle cx="16" cy="16" r="3" fill="#1FF80B" />
            <path d="M16 16 L16 7 M16 16 L24 12 M16 16 L24 20 M16 16 L8 20 M16 16 L8 12" stroke="#1FF80B" strokeWidth="1.2" opacity="0.7" />
            <circle cx="16" cy="7" r="1.6" fill="#1FF80B" />
            <circle cx="24" cy="12" r="1.6" fill="#1FF80B" />
            <circle cx="24" cy="20" r="1.6" fill="#1FF80B" />
            <circle cx="8" cy="20" r="1.6" fill="#1FF80B" />
            <circle cx="8" cy="12" r="1.6" fill="#1FF80B" />
          </svg>
          <div className="font-bold text-2xl tracking-[0.25em] neon-text">CORTEX</div>
          <div className="mono text-[10px] text-txt-dim tracking-wider mt-1">MYTHOS RETAIL INTELLIGENCE</div>
        </div>

        <div className={`card p-7 ${shake ? "animate-shake" : ""}`}>
          <div className="text-center mb-5">
            <div className="font-semibold">Güvenli Giriş</div>
            <p className="text-txt-dim text-sm mt-1">Devam etmek için 6 haneli PIN'i gir</p>
          </div>

          <div className="flex justify-center gap-2 mb-5" dir="ltr">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => { refs.current[i] = el; }}
                inputMode="numeric"
                autoComplete={i === 0 ? "one-time-code" : "off"}
                maxLength={1}
                value={d}
                disabled={busy}
                onChange={(e) => onChange(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                onFocus={(e) => e.target.select()}
                type={d ? "password" : "text"}
                className="w-11 h-14 text-center text-2xl mono rounded-lg bg-ink-2 border border-line outline-none focus:border-neon focus:ring-1 focus:ring-neon/40 transition-colors"
              />
            ))}
          </div>

          {err && <div className="text-red-400 mono text-xs text-center mb-3">{err}</div>}

          <button
            onClick={() => submit(pin)}
            disabled={busy || pin.length !== LEN}
            className="w-full py-3 rounded-lg font-semibold mono text-sm bg-neon/15 text-neon border border-neon/30 hover:bg-neon/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? "Kontrol ediliyor…" : "Giriş Yap"}
          </button>
        </div>

        <div className="text-center mono text-[10px] text-txt-dim mt-6 tracking-wider">
          © Unholy Labs / Mert Dönmezler
        </div>
      </div>
    </div>
  );
}
