import {useEffect, useRef, type RefObject} from "react";
import {availableMonitors, cursorPosition, getCurrentWindow, PhysicalPosition} from "@tauri-apps/api/window";
import type {Motion} from "./motion";

// Click vs drag
const CLICK_SLOP_PX = 4; // logical px

// Release velocity
const SAMPLE_WINDOW_MS = 90;
const MAX_SPEED = 4; // logical px/ms

// Fling
const FRICTION = 0.9965; // v *= FRICTION^dt (dt in ms)
const STOP_SPEED = 0.015; // logical px/ms
const MAX_STEP_MS = 40;

// Bounds, applied to the orb's circle (not the window)
const BOUNCE_X = 0.55;
const BOUNCE_Y = 0.45;
const OVERHANG = 0.05; // max share of the monitor height the orb may stick out
const SPRING_K = 0.00012; // per ms², pulls the orb fully back on screen
const SPRING_DAMPING = 0.994; // per ms, extra damping while outside
const SETTLE_PX = 0.5; // logical px

// Face reactions
const IMPACT_MIN_SPEED = 0.25; // logical px/ms
const IMPACT_FULL_SPEED = 2.5;

const MONITOR_REFRESH_MS = 1000;

type Area = {left: number; top: number; right: number; bottom: number};
type Sample = {t: number; x: number; y: number};
type Mode = "idle" | "press" | "drag" | "fling";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const distToArea = (a: Area, x: number, y: number) =>
  Math.hypot(Math.max(a.left - x, 0, x - a.right), Math.max(a.top - y, 0, y - a.bottom));

// Own window dragging and throwing. Everything is computed in physical pixels on the orb's centre.
// Returns a ref that is true while the orb is pressed, dragged or flying.
export const useDragFling = (
  orbRef: RefObject<HTMLElement | null>,
  motion: RefObject<Motion>,
  onClick?: () => void,
) => {
  const activeRef = useRef(false);
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  useEffect(() => {
    const orb = orbRef.current;
    if (!orb) return;
    const win = getCurrentWindow();
    const m = motion.current;
    let disposed = false;
    let warned = false;
    const warn = (msg: string, err: unknown) => {
      if (warned) return;
      warned = true;
      console.error(`FOBY: ${msg}`, err);
    };

    // Cached scale factor and monitor work areas, refreshed regularly (mixed-DPI setups)
    let scale = window.devicePixelRatio || 1;
    let areas: Area[] = [];
    const refreshMonitors = async () => {
      try {
        const [s, mons] = await Promise.all([win.scaleFactor(), availableMonitors()]);
        if (disposed) return;
        scale = s;
        areas = mons.map((mon) => {
          const wa = mon.workArea;
          const useWa = !!wa && wa.size.width > 0 && wa.size.height > 0;
          const pos = useWa ? wa.position : mon.position;
          const size = useWa ? wa.size : mon.size;
          return {left: pos.x, top: pos.y, right: pos.x + size.width, bottom: pos.y + size.height};
        });
      } catch (err) {
        warn("monitor refresh failed", err);
      }
    };
    void refreshMonitors();
    const monitorTimer = window.setInterval(refreshMonitors, MONITOR_REFRESH_MS);
    let unlistenScale: (() => void) | null = null;
    win.onScaleChanged(({payload}) => {scale = payload.scaleFactor;})
      .then((un) => {
        if (disposed) un();
        else unlistenScale = un;
      })
      .catch((err) => warn("scale listener failed", err));

    // Orb centre and radius inside the window, logical px
    const orbGeom = () => {
      const r = orb.getBoundingClientRect();
      return {ox: r.left + r.width / 2, oy: r.top + r.height / 2, r: r.width / 2};
    };

    // Limits for the orb centre: horizontal walls span all monitors, vertical ones come from the monitor under the centre
    const limits = (x: number, y: number, r: number) => {
      if (!areas.length) return null;
      const left = Math.min(...areas.map((a) => a.left));
      const right = Math.max(...areas.map((a) => a.right));
      const inColumn = areas.filter((a) => x >= a.left && x < a.right);
      const pool = inColumn.length ? inColumn : areas;
      const area = pool.reduce((best, a) => (distToArea(a, x, y) < distToArea(best, x, y) ? a : best));
      const over = (area.bottom - area.top) * OVERHANG;
      return {
        minX: left + r,
        maxX: right - r,
        hardMinY: area.top - over + r,
        hardMaxY: area.bottom + over - r,
        softMinY: area.top + r,
        softMaxY: area.bottom - r,
      };
    };

    // Latest-wins window positioning: never more than one setPosition in flight
    let pending: {x: number; y: number} | null = null;
    let sending = false;
    const flush = async () => {
      sending = true;
      while (pending && !disposed) {
        const p = pending;
        pending = null;
        try {
          await win.setPosition(new PhysicalPosition(p.x, p.y));
        } catch (err) {
          warn("setPosition failed", err);
        }
      }
      sending = false;
    };
    const moveTo = (x: number, y: number) => {
      const g = orbGeom();
      pending = {x: Math.round(x - g.ox * scale), y: Math.round(y - g.oy * scale)};
      if (!sending) void flush();
    };

    const impact = (dirX: number, dirY: number, speedPhys: number) => {
      const speed = speedPhys / scale;
      if (speed < IMPACT_MIN_SPEED) return;
      m.impactAt = performance.now();
      m.impactX = dirX;
      m.impactY = dirY;
      m.impactPower = clamp((speed - IMPACT_MIN_SPEED) / (IMPACT_FULL_SPEED - IMPACT_MIN_SPEED), 0.25, 1);
    };

    let mode: Mode = "idle";
    let pointerId = -1;
    let pressX = 0;
    let pressY = 0;
    let grabX = 0; // cursor offset from the orb centre, logical px
    let grabY = 0;
    let cx = 0; // orb centre, physical px
    let cy = 0;
    let vx = 0; // physical px/ms
    let vy = 0;
    let samples: Sample[] = [];
    let cursorBusy = false;
    let raf = 0;
    let last = 0;

    const stopLoop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const startLoop = (frame: (t: number) => void) => {
      stopLoop();
      const loop = (t: number) => {
        raf = requestAnimationFrame(loop);
        frame(t);
      };
      raf = requestAnimationFrame(loop);
    };
    const settle = () => {
      stopLoop();
      mode = "idle";
      activeRef.current = false;
      m.vx = 0;
      m.vy = 0;
    };

    const sampleVelocity = () => {
      const now = performance.now();
      const recent = samples.filter((s) => s.t >= now - SAMPLE_WINDOW_MS);
      if (recent.length < 2) return {x: 0, y: 0};
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = b.t - a.t;
      return dt > 0 ? {x: (b.x - a.x) / dt, y: (b.y - a.y) / dt} : {x: 0, y: 0};
    };

    // Drag: every animation frame, place the orb under the cursor keeping the grab point
    const dragFrame = () => {
      if (cursorBusy) return;
      cursorBusy = true;
      cursorPosition()
        .then((c) => {
          if (mode !== "drag" || disposed) return;
          const t = performance.now();
          const r = orbGeom().r * scale;
          let x = c.x - grabX * scale;
          let y = c.y - grabY * scale;
          const lim = limits(x, y, r);
          if (lim) {
            const v = sampleVelocity();
            if (x < lim.minX && cx >= lim.minX) impact(-1, 0, -v.x);
            if (x > lim.maxX && cx <= lim.maxX) impact(1, 0, v.x);
            if (y < lim.hardMinY && cy >= lim.hardMinY) impact(0, -1, -v.y);
            if (y > lim.hardMaxY && cy <= lim.hardMaxY) impact(0, 1, v.y);
            x = clamp(x, lim.minX, lim.maxX);
            y = clamp(y, lim.hardMinY, lim.hardMaxY);
          }
          cx = x;
          cy = y;
          samples.push({t, x, y});
          samples = samples.filter((s) => s.t >= t - SAMPLE_WINDOW_MS);
          const v = sampleVelocity();
          m.vx = v.x / scale;
          m.vy = v.y / scale;
          moveTo(cx, cy);
        })
        .catch((err) => warn("cursor position failed", err))
        .finally(() => {cursorBusy = false;});
    };

    // Fling: momentum with friction, walls, and a spring back onto the screen
    const flingFrame = (t: number) => {
      const dt = Math.min(MAX_STEP_MS, t - last);
      last = t;
      if (dt <= 0) return;
      const r = orbGeom().r * scale;
      const decay = Math.pow(FRICTION, dt);
      vx *= decay;
      vy *= decay;
      cx += vx * dt;
      cy += vy * dt;

      const lim = limits(cx, cy, r);
      let off = 0;
      if (lim) {
        if (cx < lim.minX) {
          cx = lim.minX;
          if (vx < 0) {impact(-1, 0, -vx); vx = -vx * BOUNCE_X;}
        } else if (cx > lim.maxX) {
          cx = lim.maxX;
          if (vx > 0) {impact(1, 0, vx); vx = -vx * BOUNCE_X;}
        }
        if (cy < lim.hardMinY) {
          cy = lim.hardMinY;
          if (vy < 0) {impact(0, -1, -vy); vy = -vy * BOUNCE_Y;}
        } else if (cy > lim.hardMaxY) {
          cy = lim.hardMaxY;
          if (vy > 0) {impact(0, 1, vy); vy = -vy * BOUNCE_Y;}
        }
        if (cy < lim.softMinY) off = lim.softMinY - cy;
        else if (cy > lim.softMaxY) off = lim.softMaxY - cy;
        if (off !== 0) {
          vy += off * SPRING_K * dt;
          vy *= Math.pow(SPRING_DAMPING, dt);
        }
      }

      if (Math.hypot(vx, vy) / scale < STOP_SPEED && Math.abs(off) < SETTLE_PX * scale) {
        if (lim) cy = clamp(cy, lim.softMinY, lim.softMaxY);
        moveTo(cx, cy);
        settle();
        return;
      }
      m.vx = vx / scale;
      m.vy = vy / scale;
      moveTo(cx, cy);
    };

    const startFling = () => {
      const v = sampleVelocity();
      const speed = Math.hypot(v.x, v.y);
      const max = MAX_SPEED * scale;
      const k = speed > max ? max / speed : 1;
      vx = v.x * k;
      vy = v.y * k;
      samples = [];
      mode = "fling";
      last = performance.now();
      startLoop(flingFrame);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // A press always interrupts a running fling
      settle();
      mode = "press";
      activeRef.current = true;
      pointerId = e.pointerId;
      orb.setPointerCapture(e.pointerId);
      pressX = e.clientX;
      pressY = e.clientY;
      const g = orbGeom();
      grabX = e.clientX - g.ox;
      grabY = e.clientY - g.oy;
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (mode !== "press" || e.pointerId !== pointerId) return;
      // The window has not moved yet, so client deltas equal cursor deltas
      if (Math.hypot(e.clientX - pressX, e.clientY - pressY) < CLICK_SLOP_PX) return;
      mode = "drag";
      samples = [];
      cx = NaN;
      cy = NaN;
      startLoop(dragFrame);
    };

    const onUp = (e: PointerEvent) => {
      // Capture is released implicitly after pointerup; the later lostpointercapture is ignored here
      if (e.pointerId !== pointerId) return;
      pointerId = -1;
      if (mode === "press") {
        settle();
        if (e.type === "pointerup") {
          m.tapAt = performance.now();
          onClickRef.current?.();
        }
      } else if (mode === "drag") {
        if (Number.isNaN(cx)) settle();
        else startFling();
      }
    };

    orb.addEventListener("pointerdown", onDown);
    orb.addEventListener("pointermove", onMove);
    orb.addEventListener("pointerup", onUp);
    orb.addEventListener("pointercancel", onUp);
    orb.addEventListener("lostpointercapture", onUp);

    return () => {
      disposed = true;
      stopLoop();
      clearInterval(monitorTimer);
      unlistenScale?.();
      orb.removeEventListener("pointerdown", onDown);
      orb.removeEventListener("pointermove", onMove);
      orb.removeEventListener("pointerup", onUp);
      orb.removeEventListener("pointercancel", onUp);
      orb.removeEventListener("lostpointercapture", onUp);
    };
  }, [orbRef, motion]);

  return activeRef;
};
