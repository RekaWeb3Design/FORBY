import {useLayoutEffect, useRef} from "react";
import type {Chip, ChipId} from "./foby";

const CHIP_GAP = 6; // px along the arc

type ChipsProps = {
  chips: Chip[];
  cx: number; // arc centre (the orb centre) in window px
  cy: number;
  radius: number; // radius of the chip centres
  onPick: (id: ChipId) => void;
};

// Horizontal chips on an arc concentric with the ring, centred at 12 o'clock.
// Widths come from the labels; each chip sits at the arc position of its accumulated width.
export default function Chips({chips, cx, cy, radius, onPick}: ChipsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const key = chips.map((c) => c.id).join("|");

  useLayoutEffect(() => {
    const els = refs.current.slice(0, chips.length);
    const widths = els.map((el) => el?.offsetWidth ?? 0);
    const total = widths.reduce((a, b) => a + b, 0) + CHIP_GAP * (widths.length - 1);
    let s = -total / 2;
    els.forEach((el, i) => {
      const th = (s + widths[i] / 2) / radius;
      s += widths[i] + CHIP_GAP;
      if (!el) return;
      el.style.left = `${(cx + radius * Math.sin(th)).toFixed(1)}px`;
      el.style.top = `${(cy - radius * Math.cos(th)).toFixed(1)}px`;
      el.style.visibility = "visible";
    });
  }, [key, cx, cy, radius, chips.length]);

  return (
    <>
      {chips.map((chip, i) => (
        <button
          key={`${key}-${chip.id}`}
          ref={(el) => {refs.current[i] = el;}}
          className="chip"
          data-hit=""
          onClick={() => onPick(chip.id)}
        >
          {chip.label}
        </button>
      ))}
    </>
  );
}
