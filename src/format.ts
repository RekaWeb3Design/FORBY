// Duration choice limits (minutes)
export const DURATION_MIN = 1;
export const DURATION_MAX = 600;

const pad2 = (n: number) => String(n).padStart(2, "0");

// m:ss, or h:mm:ss from one hour up
export const formatSeconds = (total: number) => {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
};

// Counting up shows completed seconds, counting down shows started ones
export const formatElapsed = (ms: number) => formatSeconds(Math.floor(ms / 1000));
export const formatRemaining = (ms: number) => formatSeconds(Math.ceil(ms / 1000));
export const formatMinutes = (min: number) => formatSeconds(min * 60);

// "45" = 45 min, "90" = 90 min, "1:30" = 1 h 30 min. Returns minutes, or null when invalid or out of range.
export const parseDuration = (input: string): number | null => {
  const t = input.trim();
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  const min = /^\d{1,3}$/.test(t) ? Number(t) : hm ? Number(hm[1]) * 60 + Number(hm[2]) : NaN;
  return min >= DURATION_MIN && min <= DURATION_MAX ? min : null;
};
