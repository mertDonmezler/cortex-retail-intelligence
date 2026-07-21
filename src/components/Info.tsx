// Yerinde metrik açıklaması — "bu sayı nereden geliyor?" sorusunu, sayfa
// değiştirmeden, hover/uzun-bas ile yanıtlayan minik ⓘ. Native title kullanır:
// sıfır bağımlılık, her yüzeyde çalışır.
export function Info({ text }: { text: string }) {
  return (
    <span
      title={text}
      aria-label={text}
      className="cursor-help text-txt-dim/60 hover:text-neon ml-1 text-[10px] align-middle select-none"
    >
      ⓘ
    </span>
  );
}
