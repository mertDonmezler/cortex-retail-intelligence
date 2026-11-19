"use client";

// Erişim kaydı — "siteye kaç kez girildi, ne zaman, hatalı deneme var mı".
// Dashboard'ın en altında katlı bölüm olarak durur (yeni sayfa/nav açılmadı).
// KİMLİK NOTU: şu an tek ortak PIN kullanıldığı için "kim" bilinmiyor; kişi
// bazlı PIN'e geçilirse aynı kayıtta isim de görünür (tablo hazır).
import { useEffect, useState } from "react";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";

interface Entry { id: number; ts: string; event: string; user_label: string | null; ip: string | null; user_agent: string | null }
interface Data {
  days: number;
  summary: { logins: number; failed: number; activeDays: number; uniqueIps: number; lastLogin: string | null };
  perDay: { day: string; count: number }[];
  recent: Entry[];
}

const EV: Record<string, { label: string; color: string }> = {
  login_ok: { label: "giriş", color: "#1FF80B" },
  login_fail: { label: "HATALI PIN", color: "#ff5555" },
  logout: { label: "çıkış", color: "#7d927d" },
};

// Uzun user-agent'tan okunur cihaz/tarayıcı özeti. Tarayıcı dışı istemcilerde
// (curl, script, bot) kalıp tutmaz → "? · ?" yerine ham değerin kısası gösterilir;
// beklenmedik erişimi gizlemek yerine görünür kılar.
function device(ua: string | null): string {
  if (!ua) return "—";
  const os = /Windows/i.test(ua) ? "Windows" : /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Linux/i.test(ua) ? "Linux" : null;
  const br = /Edg\//i.test(ua) ? "Edge" : /OPR\//i.test(ua) ? "Opera"
    : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari"
    : /Firefox\//i.test(ua) ? "Firefox" : null;
  if (!os && !br) return ua.slice(0, 24); // tarayıcı değil → ham istemci adı
  return `${os ?? "?"} · ${br ?? "?"}`;
}

export function AccessLog() {
  const [d, setD] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchJson("/api/access-log").then(setD).catch(() => setFailed(true));
  }, []);

  if (failed) return <div className="mono text-xs text-txt-dim">Erişim kaydı okunamadı.</div>;
  if (!d) return <div className="mono text-xs text-txt-dim">Yükleniyor…</div>;

  const max = Math.max(...d.perDay.map((p) => p.count), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={`GİRİŞ (${d.days} GÜN)`} value={fmtInt(d.summary.logins)} />
        <Stat label="AKTİF GÜN" value={fmtInt(d.summary.activeDays)} />
        <Stat label="FARKLI IP" value={fmtInt(d.summary.uniqueIps)} />
        <Stat
          label="HATALI PIN"
          value={fmtInt(d.summary.failed)}
          color={d.summary.failed > 0 ? "#ff5555" : undefined}
          sub={d.summary.failed > 0 ? "kontrol et" : "sorun yok"}
        />
      </div>

      {d.summary.lastLogin && (
        <div className="mono text-[11px] text-txt-dim">
          Son giriş: <span className="text-txt">{fmtDateTime(d.summary.lastLogin)}</span>
        </div>
      )}

      {/* Gün bazında giriş yoğunluğu */}
      {d.perDay.length > 0 && (
        <div>
          <div className="mono text-[10px] text-txt-dim tracking-wider mb-2">GÜNLÜK GİRİŞ</div>
          <div className="flex items-end gap-[3px] h-14">
            {d.perDay.map((p) => (
              <div key={p.day} className="flex-1 min-w-[3px] rounded-t bg-neon/70 hover:bg-neon hover:transition-colors"
                style={{ height: `${(p.count / max) * 100}%` }}
                title={`${p.day}: ${p.count} giriş`} />
            ))}
          </div>
        </div>
      )}

      {/* Son hareketler */}
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr><th>Zaman</th><th>Olay</th><th>IP</th><th>Cihaz</th></tr>
          </thead>
          <tbody>
            {d.recent.length === 0 ? (
              <tr><td colSpan={4} className="mono text-xs text-txt-dim py-4 text-center">Henüz kayıt yok.</td></tr>
            ) : d.recent.map((r) => {
              const e = EV[r.event] ?? { label: r.event, color: "#7d927d" };
              return (
                <tr key={r.id}>
                  <td className="mono text-xs whitespace-nowrap">{fmtDateTime(r.ts)}</td>
                  <td>
                    <span className="mono text-[10px] px-1.5 py-0.5 rounded"
                      style={{ color: e.color, border: `1px solid ${e.color}40`, background: e.color + "14" }}>
                      {e.label}
                    </span>
                    {r.user_label && <span className="mono text-xs ml-2">{r.user_label}</span>}
                  </td>
                  <td className="mono text-xs text-txt-dim">{r.ip ?? "—"}</td>
                  <td className="mono text-xs text-txt-dim">{device(r.user_agent)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mono text-[10px] text-txt-dim">
        Tek ortak PIN kullanıldığı için kayıtta kişi adı yok — yalnızca giriş sayısı,
        zamanı, IP ve cihaz görünür. Kişi bazlı PIN'e geçilirse isim de bu tabloda çıkar.
      </p>
    </div>
  );
}

function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="card p-3">
      <div className="mono text-[10px] text-txt-dim tracking-wider">{label}</div>
      <div className="text-xl font-bold mono mt-1" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="mono text-[10px] text-txt-dim">{sub}</div>}
    </div>
  );
}
