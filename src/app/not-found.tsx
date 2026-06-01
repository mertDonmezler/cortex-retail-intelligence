import Link from "next/link";
export default function NotFound() {
  return (
    <div className="card p-10 text-center max-w-lg mx-auto mt-10">
      <div className="text-3xl mb-2 neon-text mono">404</div>
      <div className="font-semibold">Sayfa bulunamadı</div>
      <Link href="/" className="inline-block mt-6 mono text-sm neon-text">&larr; Dashboard'a dön</Link>
    </div>
  );
}
