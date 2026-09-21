// Screen bounds for the orb's circle, in physical pixels. Pure functions, no Tauri calls.

const OVERHANG = 0.05; // max share of the monitor height the orb may stick out (play mode only)

export type Area = {left: number; top: number; right: number; bottom: number};

export type Limits = {
  minX: number; // hard limits for the orb centre
  maxX: number;
  minY: number;
  maxY: number;
  softMinY: number; // fully on screen; the spring pulls back inside these
  softMaxY: number;
};

const distToArea = (a: Area, x: number, y: number) =>
  Math.hypot(Math.max(a.left - x, 0, x - a.right), Math.max(a.top - y, 0, y - a.bottom));

// Horizontal walls span all monitors; the vertical ones come from the monitor under the orb centre.
// Without play mode the orb may not stick out at all (hard = soft).
export const orbLimits = (areas: Area[], x: number, y: number, r: number, play: boolean): Limits | null => {
  if (!areas.length) return null;
  const left = Math.min(...areas.map((a) => a.left));
  const right = Math.max(...areas.map((a) => a.right));
  const inColumn = areas.filter((a) => x >= a.left && x < a.right);
  const pool = inColumn.length ? inColumn : areas;
  const area = pool.reduce((best, a) => (distToArea(a, x, y) < distToArea(best, x, y) ? a : best));
  const over = play ? (area.bottom - area.top) * OVERHANG : 0;
  return {
    minX: left + r,
    maxX: right - r,
    minY: area.top - over + r,
    maxY: area.bottom + over - r,
    softMinY: area.top + r,
    softMaxY: area.bottom - r,
  };
};
