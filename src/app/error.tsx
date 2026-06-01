"use client";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card p-10 text-center max-w-lg mx-auto mt-10">
      <div className="text-2xl mb-2 neon-text mono">! HATA</div>
      <div className="font-semibold">Bir şeyler ters gitti</div>
      <p className="text-txt-dim text-sm mt-2 mono">
        {process.env.NODE_ENV !== "production"
          ? error.message
          : "Beklenmeyen bir hata oluştu, lütfen tekrar dene."}
      </p>
      {error.digest && <p className="text-txt-dim text-[11px] mt-1 mono">Ref: {error.digest}</p>}
      <button onClick={reset}
        className="mt-6 mono text-sm px-5 py-2 rounded-lg bg-neon text-ink font-bold hover:bg-neon-dim">
        Tekrar dene
      </button>
    </div>
  );
}
