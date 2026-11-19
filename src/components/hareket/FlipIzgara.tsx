"use client";
import { Component, createRef, type ReactNode } from "react";
import { SURE, EGRI, azaltilmisHareket } from "@/lib/hareket";

// SIRA DEĞİŞİMİNDE KONUM SÜREKLİLİĞİ (FLIP).
// Yalnız `imza` (çocukların sırası) değiştiğinde ölçer; aynı sıra, pencere
// boyutu ya da yeniden render hiçbir ölçüm ve hareket üretmez. Kayan tek şey
// translate'tir: içerik (sayılar, renkler, çerçeve) aynı karede yeni değerini
// alır. Çocukların kök öğesi data-flip={kimlik} taşır.
type Props = { imza: string; className?: string; children: ReactNode };
type Anlik = Map<string, DOMRect>;

export class FlipIzgara extends Component<Props> {
  private kap = createRef<HTMLDivElement>();
  private oynayan: Animation[] = [];

  private cocuklar(): HTMLElement[] {
    const k = this.kap.current;
    return k ? Array.from(k.querySelectorAll<HTMLElement>(":scope > [data-flip]")) : [];
  }

  getSnapshotBeforeUpdate(prev: Props): Anlik | null {
    if (prev.imza === this.props.imza) return null;
    // Kayma sürerken yeni sıra gelirse: getBoundingClientRect transform'u
    // içerdiği için ölçüm o anki GÖRSEL konumdur; oradan yeniden hedeflenir.
    const m: Anlik = new Map();
    for (const el of this.cocuklar()) m.set(el.dataset.flip!, el.getBoundingClientRect());
    return m;
  }

  componentDidUpdate(_p: Props, _s: unknown, once: Anlik | null) {
    if (!once || azaltilmisHareket()) return;
    for (const a of this.oynayan) a.cancel();
    this.oynayan = [];
    for (const el of this.cocuklar()) {
      const eski = once.get(el.dataset.flip!);
      if (!eski) continue;
      const yeni = el.getBoundingClientRect();
      const dx = eski.left - yeni.left;
      const dy = eski.top - yeni.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      this.oynayan.push(el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: SURE.gecis, easing: EGRI },
      ));
    }
  }

  componentWillUnmount() {
    for (const a of this.oynayan) a.cancel();
  }

  render() {
    return <div ref={this.kap} className={this.props.className}>{this.props.children}</div>;
  }
}
