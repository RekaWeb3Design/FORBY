import {useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject} from "react";
import {cursorPosition, getCurrentWindow} from "@tauri-apps/api/window";
import type {Motion} from "./motion";

export type FaceState = "idle" | "focus" | "pause" | "break" | "alarm" | "overtime";

type FaceProps = {
  state: FaceState;
  color?: string;
  readingAnimation?: boolean;
  // Show the hover smile regardless of the cursor (summary)
  smile?: boolean;
  // Optional drag/fling state, read every frame without re-rendering
  motion?: RefObject<Motion>;
  // Global cursor position relative to the window (logical px), reported on every poll
  onCursor?: (x: number, y: number) => void;
};

type Shape = FaceState | "hover" | "focusRead" | "whoa";

type Feature = {
  lon: number;
  lat: number;
  node: ReactNode;
  blink: "normal" | "slow" | "none";
  side?: 0 | 1;
  alarmEye?: boolean;
  brrMouth?: boolean;
};

// Timing (ms)
const FRAME_MS = 1000 / 30;
const POLL_MS = 50;
const BLINK_MIN = 2500;
const BLINK_RAND = 4000;
const SLOW_BLINK_MIN = 15000;
const SLOW_BLINK_RAND = 10000;
const ALARM_CYCLE = 3400;
const ALARM_BRR_FROM = 0.65;
const OVERTIME_CYCLE = 20000;
const READ_CYCLE = 4200;

// Gaze
const MAX_YAW = 0.62;
const MAX_PITCH = 0.5;
const LOOK_RANGE_PX = 400;
const SMOOTHING = 0.18;

// Motion reactions (speeds in logical px/ms)
const MOTION_SMOOTHING = 0.35;
const LAG_GAIN = 0.3;
const LAG_MAX = 0.5;
const STRETCH_GAIN = 0.11;
const STRETCH_MAX = 0.22;
const STRETCH_THIN = 0.5;
const WHOA_ON = 1.8;
const WHOA_OFF = 1.2;
const IMPACT_MS = 240;
const IMPACT_SQUASH = 0.2;
const TAP_MS = 320;
const TAP_SQUASH = 0.12;

const R = 90;
const DEG = Math.PI / 180;
const DEFAULT_COLOR = "#EDEBE4";

const pill = (h: number, w = 14) => (
  <rect className="fc" x={-w / 2} y={-h / 2} width={w} height={h} rx={Math.min(w, h) / 2} />
);
const smile = <path className="ln" strokeWidth={5} d="M-6 0 A6 6 0 0 0 6 0" />;
const closedEye = <path className="ln" strokeWidth={6} d="M-9 -2 A9 9 0 0 0 9 -2" />;
const happyEye = <path className="ln" strokeWidth={7} d="M-8 4 A8 8 0 0 1 8 4" />;
const whoaMouth = <circle className="ln" strokeWidth={3.5} r={4.5} />;
const alarmMouth = (
  <>
    <g className="calm"><circle className="fc" r={5} /></g>
    <g className="brrm"><path className="ln" strokeWidth={4} d="M-11 0 Q-8.25 -4 -5.5 0 T0 0 T5.5 0 T11 0" /></g>
  </>
);

const f = (lon: number, lat: number, node: ReactNode, opts: Partial<Feature> = {}): Feature => ({
  lon: lon * DEG,
  lat: lat * DEG,
  node,
  blink: "normal",
  ...opts,
});

const SHAPES: Record<Shape, Feature[]> = {
  idle: [f(-13, -6, pill(34)), f(13, -6, pill(34))],
  hover: [f(-13, -7, pill(26)), f(13, -7, pill(26)), f(0, 13, smile, {blink: "none"})],
  focus: [f(-13, -11, pill(22), {blink: "slow"}), f(13, -11, pill(22), {blink: "slow"})],
  focusRead: [f(-12, -5, pill(24, 13)), f(12, -5, pill(24, 13))],
  pause: [f(-13, -3, closedEye, {blink: "none"}), f(13, -3, closedEye, {blink: "none"})],
  break: [f(-13, -4, happyEye, {blink: "none"}), f(13, -4, happyEye, {blink: "none"}), f(0, 14, smile, {blink: "none"})],
  alarm: [
    f(-13, -9, pill(44), {blink: "none", alarmEye: true}),
    f(13, -9, pill(44), {blink: "none", alarmEye: true}),
    f(0, 17, alarmMouth, {blink: "none", brrMouth: true}),
  ],
  whoa: [
    f(-13, -9, pill(44), {blink: "none"}),
    f(13, -9, pill(44), {blink: "none"}),
    f(0, 17, whoaMouth, {blink: "none"}),
  ],
  overtime: [
    f(-13, -5, pill(28), {side: 0}),
    f(13, -5, pill(28), {side: 1}),
    f(0, 15, <path className="ln" strokeWidth={4} d="M-8 0 H8" />, {blink: "none"}),
  ],
};

const STYLE = `
.foby .fc{fill:currentColor}
.foby .ln{fill:none;stroke:currentColor;stroke-linecap:round}
.foby[data-brr="1"] .calm{display:none}
.foby:not([data-brr="1"]) .brrm{display:none}
.foby:not([data-brr="1"]) .brr-lines{display:none}
`;

const ramp = (x: number, a: number, b: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));
const ease = (x: number) => x * x * (3 - 2 * x);

const hexToRgb = (hex: string): [number, number, number] => {
  const safe = /^#[0-9a-f]{6}$/i.test(hex) ? hex : DEFAULT_COLOR;
  return [1, 3, 5].map((i) => parseInt(safe.slice(i, i + 2), 16)) as [number, number, number];
};

const mix = (hex: string, t: number) =>
  "#" + hexToRgb(hex)
    .map((v) => (t > 0 ? v + (255 - v) * t : v * (1 + t)))
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
    .join("");

const makePalette = (color: string) => {
  const [r, g, b] = hexToRgb(color);
  const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
  return {
    top: mix(color, 0.14),
    bottom: mix(color, -0.2),
    feature: light ? "#1F1E1C" : "#F7F5EF",
    highlight: light ? 0.55 : 0.28,
    rim: light ? 0.3 : 0.45,
  };
};

// Orthographic projection of a point on the sphere after rotating it by yaw/pitch.
const project = (lon: number, lat: number, yaw: number, pitch: number) => {
  const x = Math.sin(lon) * Math.cos(lat);
  const y = Math.sin(lat);
  const z = Math.cos(lon) * Math.cos(lat);
  const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
  const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
  const y2 = y * Math.cos(pitch) + z1 * Math.sin(pitch);
  const z2 = -y * Math.sin(pitch) + z1 * Math.cos(pitch);
  return {x: x1, y: y2, z: z2};
};

const featureTransform = (feat: Feature, yaw: number, pitch: number, jx = 0, jy = 0) => {
  const p = project(feat.lon, feat.lat, yaw, pitch);
  const ang = Math.atan2(p.y, p.x) / DEG;
  const squash = Math.max(p.z, 0.02);
  return {
    transform: `translate(${(100 + R * p.x + jx).toFixed(2)} ${(100 + R * p.y + jy).toFixed(2)}) rotate(${ang.toFixed(1)}) scale(${squash.toFixed(3)} 1) rotate(${(-ang).toFixed(1)})`,
    visible: p.z >= 0.05,
  };
};

export default function Face({state, color = DEFAULT_COLOR, readingAnimation = false, smile = false, motion, onCursor}: FaceProps) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState(false);
  const [whoa, setWhoa] = useState(false);

  const shape: Shape = whoa
    ? "whoa"
    : (state === "idle" && hover) || smile ? "hover" : state === "focus" && readingAnimation ? "focusRead" : state;
  const features = SHAPES[shape];
  const palette = useMemo(() => makePalette(color), [color]);

  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const zzRef = useRef<SVGGElement>(null);
  const outerRefs = useRef<(SVGGElement | null)[]>([]);
  const innerRefs = useRef<(SVGGElement | null)[]>([]);
  const lineRefs = useRef<(SVGPathElement | null)[]>([]);

  const shapeRef = useRef<Shape>(shape);
  shapeRef.current = shape;
  const lookRef = useRef({yaw: 0, pitch: 0});
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const blinkRef = useRef(1);
  const slowBlinkRef = useRef(1);
  const extRef = useRef({motion, onCursor});
  extRef.current = {motion, onCursor};
  const velRef = useRef({x: 0, y: 0});
  const whoaRef = useRef(false);

  // Hover on the parent .orb (the SVG itself ignores pointer events so dragging keeps working)
  useEffect(() => {
    const host = svgRef.current?.parentElement;
    if (!host) return;
    const enter = () => setHover(true);
    const leave = () => setHover(false);
    host.addEventListener("mouseenter", enter);
    host.addEventListener("mouseleave", leave);
    return () => {
      host.removeEventListener("mouseenter", enter);
      host.removeEventListener("mouseleave", leave);
    };
  }, []);

  // Blinks: a normal rhythm and a much rarer one for focus
  useEffect(() => {
    const timers: number[] = [];
    const schedule = (ref: {current: number}, min: number, rand: number, closedMs: number) => {
      const run = () => {
        ref.current = 0.08;
        timers.push(window.setTimeout(() => {ref.current = 1;}, closedMs));
        timers.push(window.setTimeout(run, min + Math.random() * rand));
      };
      timers.push(window.setTimeout(run, min));
    };
    schedule(blinkRef, BLINK_MIN, BLINK_RAND, 130);
    schedule(slowBlinkRef, SLOW_BLINK_MIN, SLOW_BLINK_RAND, 180);
    return () => timers.forEach((id) => clearTimeout(id));
  }, []);

  // Global cursor tracking via Tauri (physical pixels, works across monitors with different scaling)
  useEffect(() => {
    const win = getCurrentWindow();
    let busy = false;
    let cancelled = false;
    let warned = false;

    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const [cursor, inner, scale] = await Promise.all([cursorPosition(), win.innerPosition(), win.scaleFactor()]);
        const svg = svgRef.current;
        if (cancelled || !svg) return;
        const rect = svg.getBoundingClientRect();
        const cx = inner.x + (rect.left + rect.width / 2) * scale;
        const cy = inner.y + (rect.top + rect.height / 2) * scale;
        const dx = (cursor.x - cx) / scale;
        const dy = (cursor.y - cy) / scale;
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / LOOK_RANGE_PX);
        lookRef.current = {yaw: (dx / d) * k * MAX_YAW, pitch: (dy / d) * k * MAX_PITCH};
        extRef.current.onCursor?.((cursor.x - inner.x) / scale, (cursor.y - inner.y) / scale);
      } catch (err) {
        if (!warned) {
          console.error("FOBY: cursor tracking failed", err);
          warned = true;
        }
        lookRef.current = {yaw: 0, pitch: 0};
      } finally {
        busy = false;
      }
    };

    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Animation loop, capped at 30 fps; writes attributes directly instead of re-rendering React
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let readStart = -1;

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < FRAME_MS) return;
      last = t;

      const svg = svgRef.current;
      if (!svg) return;
      const s = shapeRef.current;
      const feats = SHAPES[s];

      let gy = lookRef.current.yaw;
      let gp = lookRef.current.pitch;

      if (s === "focus") {
        gy = 0;
        gp = 0.06;
      }

      if (s === "focusRead") {
        if (readStart < 0) readStart = t;
        const ft = t - readStart;
        const line = Math.floor(ft / READ_CYCLE) % 3;
        const c = (ft % READ_CYCLE) / READ_CYCLE;
        const read = c < 0.8 ? c / 0.8 : 1;
        gy = c < 0.8 ? -0.28 + 0.56 * read : 0.28 - 0.56 * ((c - 0.8) / 0.2);
        gp = 0.42 + line * 0.05;
        lineRefs.current.forEach((el, j) => {
          if (!el) return;
          const full = j === 2 ? 7 : 19;
          const x = j < line ? full : j === line ? -19 + (full + 19) * read : -19;
          el.setAttribute("d", `M-19 ${-8 + j * 8} H${x.toFixed(1)}`);
        });
      } else {
        readStart = -1;
      }

      // Overtime: occasionally dozes off (one eye, then the other), then snaps awake
      const om = t % OVERTIME_CYCLE;
      const end = OVERTIME_CYCLE;
      const awake = om >= end - 700;
      const drowsy: [number, number] = awake
        ? [0, 0]
        : [ease(ramp(om, end - 3500, end - 1680)), ease(ramp(om, end - 2800, end - 1120))];
      if (s === "overtime") gp += 0.2 * (drowsy[0] + drowsy[1]) / 2;

      // Motion: features lag behind (slide against the movement), fast movement shows the "whoa" face
      const mo = extRef.current.motion?.current;
      const vel = velRef.current;
      vel.x += ((mo ? mo.vx : 0) - vel.x) * MOTION_SMOOTHING;
      vel.y += ((mo ? mo.vy : 0) - vel.y) * MOTION_SMOOTHING;
      const speed = Math.hypot(vel.x, vel.y);
      gy += Math.max(-LAG_MAX, Math.min(LAG_MAX, -vel.x * LAG_GAIN));
      gp += Math.max(-LAG_MAX, Math.min(LAG_MAX, -vel.y * LAG_GAIN));
      const fast = whoaRef.current ? speed > WHOA_OFF : speed > WHOA_ON;
      if (fast !== whoaRef.current) {
        whoaRef.current = fast;
        setWhoa(fast);
      }

      yawRef.current += (gy - yawRef.current) * SMOOTHING;
      pitchRef.current += (gp - pitchRef.current) * SMOOTHING;

      const brr = s === "alarm" && (t % ALARM_CYCLE) / ALARM_CYCLE > ALARM_BRR_FROM;
      svg.dataset.brr = brr ? "1" : "0";

      feats.forEach((feat, i) => {
        const outer = outerRefs.current[i];
        const inner = innerRefs.current[i];
        if (!outer || !inner) return;
        const jitter = brr && feat.brrMouth;
        const {transform, visible} = featureTransform(
          feat,
          yawRef.current,
          pitchRef.current,
          jitter ? (Math.random() - 0.5) * 2 : 0,
          jitter ? (Math.random() - 0.5) * 2 : 0,
        );
        outer.setAttribute("transform", transform);
        outer.setAttribute("opacity", visible ? "1" : "0");

        let sy = feat.blink === "slow" ? slowBlinkRef.current : feat.blink === "normal" ? blinkRef.current : 1;
        if (s === "overtime" && feat.side !== undefined) {
          const c = drowsy[feat.side];
          sy = c > 0 ? 1 - 0.9 * c : blinkRef.current;
        }
        if (feat.alarmEye) sy = brr ? 0.3 : 1;
        inner.setAttribute("transform", `scale(1 ${sy.toFixed(3)})`);
      });

      const bx = brr ? Math.sin(t / 22) * 2.2 : 0;
      const by = s === "overtime" && om >= end - 700 && om < end - 350
        ? -4 * Math.sin(((om - (end - 700)) / 350) * Math.PI)
        : 0;
      // Body deformation around the centre: stretch along the movement, squash on wall impact and on tap
      const deform: string[] = [];
      const st = Math.min(STRETCH_MAX, speed * STRETCH_GAIN);
      if (st > 0.002) {
        const a = (Math.atan2(vel.y, vel.x) / DEG).toFixed(1);
        deform.push(`rotate(${a}) scale(${(1 + st).toFixed(3)} ${(1 - st * STRETCH_THIN).toFixed(3)}) rotate(${-a})`);
      }
      if (mo) {
        const ip = (t - mo.impactAt) / IMPACT_MS;
        if (ip >= 0 && ip < 1) {
          const k = IMPACT_SQUASH * mo.impactPower * Math.sin(Math.PI * ip);
          const a = (Math.atan2(mo.impactY, mo.impactX) / DEG).toFixed(1);
          // Shift towards the wall so the contact side stays put
          deform.push(`rotate(${a}) translate(${(k * R).toFixed(2)} 0) scale(${(1 - k).toFixed(3)} ${(1 + k / 2).toFixed(3)}) rotate(${-a})`);
        }
        const tp = (t - mo.tapAt) / TAP_MS;
        if (tp >= 0 && tp < 1) {
          const k = TAP_SQUASH * Math.sin(tp * 2 * Math.PI) * (1 - tp);
          deform.push(`translate(0 ${(k * R).toFixed(2)}) scale(${(1 + k * 0.6).toFixed(3)} ${(1 - k).toFixed(3)})`);
        }
      }
      const base = `translate(${bx.toFixed(2)} ${by.toFixed(2)})`;
      bodyRef.current?.setAttribute(
        "transform",
        deform.length ? `${base} translate(100 100) ${deform.join(" ")} translate(-100 -100)` : base,
      );

      if (zzRef.current) {
        const c = (t % 2600) / 2600;
        zzRef.current.setAttribute("transform", `translate(${150 + c * 6} ${50 - c * 22})`);
        zzRef.current.setAttribute("opacity", (Math.sin(c * Math.PI) * 0.9).toFixed(2));
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg
      ref={svgRef}
      className="foby"
      data-brr="0"
      viewBox="0 0 200 200"
      width="100%"
      height="100%"
      style={{display: "block", overflow: "visible", pointerEvents: "none"}}
    >
      <style>{STYLE}</style>
      <defs>
        <radialGradient id={`${uid}-base`} cx="40%" cy="35%" r="75%">
          <stop offset="0%" stopColor={palette.top} />
          <stop offset="100%" stopColor={palette.bottom} />
        </radialGradient>
        <radialGradient id={`${uid}-hl`} cx="34%" cy="27%" r="38%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={palette.highlight} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${uid}-rim`} cx="50%" cy="50%" r="50%">
          <stop offset="62%" stopColor="#000000" stopOpacity={0} />
          <stop offset="100%" stopColor="#000000" stopOpacity={palette.rim} />
        </radialGradient>
        <clipPath id={`${uid}-ball`}>
          <circle cx="100" cy="100" r="90" />
        </clipPath>
      </defs>

      <g ref={bodyRef}>
        <circle cx="100" cy="100" r="90" fill={`url(#${uid}-base)`} />
        <g clipPath={`url(#${uid}-ball)`}>
          <g style={{color: palette.feature}}>
            {features.map((feat, i) => {
              const {transform, visible} = featureTransform(feat, yawRef.current, pitchRef.current);
              return (
                <g key={`${shape}-${i}`} ref={(el) => {outerRefs.current[i] = el;}} transform={transform} opacity={visible ? 1 : 0}>
                  <g ref={(el) => {innerRefs.current[i] = el;}}>{feat.node}</g>
                </g>
              );
            })}
          </g>
        </g>
        <circle cx="100" cy="100" r="90" fill={`url(#${uid}-rim)`} />
        <circle cx="100" cy="100" r="90" fill={`url(#${uid}-hl)`} />
      </g>

      {shape === "focusRead" && (
        <g transform="translate(100 170) rotate(-5)">
          <rect x="-28" y="-18" width="56" height="36" rx="4" fill="#FFFFFF" stroke="#B4B2A9" strokeWidth="1" />
          <g stroke="#D3D1C7" strokeWidth="3" strokeLinecap="round">
            <path d="M-19 -8 H19" />
            <path d="M-19 0 H19" />
            <path d="M-19 8 H7" />
          </g>
          <g stroke="#444441" strokeWidth="3" strokeLinecap="round">
            {[0, 1, 2].map((j) => (
              <path key={j} ref={(el) => {lineRefs.current[j] = el;}} d={`M-19 ${-8 + j * 8} H-19`} />
            ))}
          </g>
        </g>
      )}

      {shape === "pause" && (
        <g ref={zzRef} style={{color: "#8A8880"}} opacity={0}>
          <path className="ln" strokeWidth={3} d="M0 0 h8 l-8 8 h8" />
          <path className="ln" strokeWidth={2.5} d="M12 -14 h6 l-6 6 h6" />
        </g>
      )}

      <g className="brr-lines" style={{color: "#8A8880"}}>
        <path className="ln" strokeWidth={3} d="M2 88 v24 M-6 94 v12 M198 88 v24 M206 94 v12" />
      </g>
    </svg>
  );
}
