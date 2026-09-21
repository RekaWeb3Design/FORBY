// Shared, mutable motion state: written by the drag/fling physics, read by the Face animation loop.
// Times are performance.now() / requestAnimationFrame timestamps (same time base).
export type Motion = {
  vx: number; // logical px/ms
  vy: number;
  impactAt: number;
  impactX: number; // unit vector pointing from the orb towards the wall it hit
  impactY: number;
  impactPower: number; // 0..1
  tapAt: number;
};

export const createMotion = (): Motion => ({
  vx: 0,
  vy: 0,
  impactAt: -Infinity,
  impactX: 0,
  impactY: 0,
  impactPower: 0,
  tapAt: -Infinity,
});
