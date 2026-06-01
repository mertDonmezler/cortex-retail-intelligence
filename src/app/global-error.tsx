"use client";
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="tr"><body style={{ background: "#0a0e0a", color: "#d8e8d8", fontFamily: "monospace", padding: 40, textAlign: "center" }}>
      <h2 style={{ color: "#1FF80B" }}>Sistem hatası</h2>
      <p>{process.env.NODE_ENV !== "production" ? error.message : "Beklenmeyen bir hata oluştu, lütfen tekrar dene."}</p>
      {error.digest && <p style={{ fontSize: 11, opacity: 0.6 }}>Ref: {error.digest}</p>}
      <button onClick={reset} style={{ marginTop: 20, padding: "8px 20px", background: "#1FF80B", color: "#0a0e0a", border: 0, borderRadius: 8, fontWeight: "bold", cursor: "pointer" }}>Tekrar dene</button>
    </body></html>
  );
}
