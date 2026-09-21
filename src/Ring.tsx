import {useEffect, useRef} from "react";
import {ALARM_BRR_FROM, ALARM_CYCLE, FRAME_MS} from "./Face";
import type {Ui} from "./foby";
import {isOvertime, snapshot, type Session} from "./timer";

// Geometry in the Face's 200-unit viewBox (orb r = 90), so the ring scales with the orb
const RING_R = 104;
const RING_WIDTH = 5;
const CIRC = 2 * Math.PI * RING_R;

const TRACK_COLOR = "#888780";
const TRACK_OPACITY = 0.2;
const PROGRESS_COLOR = "#1D9E75";
const OVER_COLOR = "#D85A30";
const PAUSED_COLOR = "#888780";

const STOPWATCH_SEGMENT = 0.07; // share of the circumference
const STOPWATCH_LAP_MS = 60_000; // one turn per minute, moving continuously
const BREAK_HUE_CYCLE_MS = 4000;
const BREAK_SATURATION = 60;
const BREAK_LIGHTNESS = 50;
const ALARM_BASE_OPACITY = 0.35;

// Arc from/to as fractions of the circle, clockwise from 12 o'clock
type Arc = {color: string; from: number; to: number; opacity: number};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const arc = (color: string, from: number, to: number, opacity = 1): Arc => ({color, from, to, opacity});

const arcsFor = (ui: Ui, s: Session | null, t: number, now: number): Arc[] => {
  if (!s || (ui !== "run" && ui !== "paused" && ui !== "alarm" && ui !== "summary")) return [];

  // Alarm: full coral circle, dim, swelling up together with the face's brrr
  if (ui === "alarm") {
    const c = (t % ALARM_CYCLE) / ALARM_CYCLE;
    const pulse = c < ALARM_BRR_FROM ? 0 : Math.sin((Math.PI * (c - ALARM_BRR_FROM)) / (1 - ALARM_BRR_FROM));
    return [arc(OVER_COLOR, 0, 1, ALARM_BASE_OPACITY + (1 - ALARM_BASE_OPACITY) * pulse)];
  }

  // Paused: everything in solid grey, frozen (a paused session's snapshot does not move)
  const paused = ui === "paused";
  const tint = (color: string) => (paused ? PAUSED_COLOR : color);
  const snap = snapshot(s, now);

  // Summary: the final result, still (the session is stopped)
  if (ui === "summary") {
    if (s.mode === "pomodoro") return [arc(PROGRESS_COLOR, 0, 1)];
    if (s.mode === "stopwatch") {
      const p = (snap.elapsedMs % STOPWATCH_LAP_MS) / STOPWATCH_LAP_MS;
      return [arc(PROGRESS_COLOR, p - STOPWATCH_SEGMENT, p)];
    }
    if (snap.elapsedMs <= s.targetMs) return [arc(PROGRESS_COLOR, 0, clamp01(snap.elapsedMs / s.targetMs))];
    const over = ((snap.elapsedMs - s.targetMs) % s.targetMs) / s.targetMs;
    return [arc(PROGRESS_COLOR, 0, 1), arc(OVER_COLOR, 0, over)];
  }

  switch (s.mode) {
    case "stopwatch": {
      const p = (snap.elapsedMs % STOPWATCH_LAP_MS) / STOPWATCH_LAP_MS;
      return [arc(tint(PROGRESS_COLOR), p - STOPWATCH_SEGMENT, p)];
    }
    case "timer":
      return [arc(tint(PROGRESS_COLOR), 0, clamp01(snap.elapsedMs / s.targetMs))];
    case "goal": {
      if (!isOvertime(s, snap)) return [arc(tint(PROGRESS_COLOR), 0, clamp01(snap.elapsedMs / s.targetMs))];
      const lap = ((snap.elapsedMs - s.targetMs) % s.targetMs) / s.targetMs;
      return [arc(tint(PROGRESS_COLOR), 0, 1), arc(tint(OVER_COLOR), 0, lap)];
    }
    case "pomodoro": {
      const isBreak = snap.phase === "break";
      const total = isBreak ? s.breakMs : s.focusMs;
      const hue = ((t % BREAK_HUE_CYCLE_MS) / BREAK_HUE_CYCLE_MS) * 360;
      const color = isBreak ? `hsl(${hue.toFixed(0)} ${BREAK_SATURATION}% ${BREAK_LIGHTNESS}%)` : PROGRESS_COLOR;
      return [arc(tint(color), 0, clamp01(1 - snap.phaseRemainingMs / total))];
    }
  }
};

type RingProps = {
  ui: Ui;
  session: Session | null;
  left: number; // the orb's box in window px; the ring is drawn around it
  top: number;
  size: number;
};

// Progress ring around the orb. Animated at max 30 fps by writing attributes directly.
export default function Ring({ui, session, left, top, size}: RingProps) {
  const arcRefs = useRef<(SVGCircleElement | null)[]>([]);
  const inputRef = useRef({ui, session});
  inputRef.current = {ui, session};

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < FRAME_MS) return;
      last = t;
      const {ui: u, session: s} = inputRef.current;
      const arcs = arcsFor(u, s, t, Date.now());
      arcRefs.current.forEach((el, i) => {
        if (!el) return;
        const a = arcs[i];
        const len = a ? clamp01(a.to - a.from) * CIRC : 0;
        if (!a || len < 0.05) {
          el.setAttribute("visibility", "hidden");
          return;
        }
        el.setAttribute("visibility", "visible");
        el.setAttribute("stroke", a.color);
        el.setAttribute("opacity", a.opacity.toFixed(3));
        // Dash pattern period equals the circumference, so arcs starting before 12 o'clock wrap around
        el.setAttribute("stroke-dasharray", `${len.toFixed(2)} ${(CIRC - len).toFixed(2)}`);
        el.setAttribute("stroke-dashoffset", (-a.from * CIRC).toFixed(2));
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg
      className="ring"
      viewBox="0 0 200 200"
      style={{left, top, width: size, height: size}}
    >
      <g transform="rotate(-90 100 100)" fill="none" strokeWidth={RING_WIDTH}>
        <circle cx="100" cy="100" r={RING_R} stroke={TRACK_COLOR} strokeOpacity={TRACK_OPACITY} />
        {[0, 1].map((i) => (
          <circle key={i} ref={(el) => {arcRefs.current[i] = el;}} cx="100" cy="100" r={RING_R} visibility="hidden" />
        ))}
      </g>
    </svg>
  );
}
