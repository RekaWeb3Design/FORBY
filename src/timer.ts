// Timer engine: pure functions over wall-clock timestamps (Date.now()), so the time stays right
// even if timers are throttled or the machine sleeps. Everything shown is derived from the active time.

export type Mode = "timer" | "stopwatch" | "goal" | "pomodoro";

export type Session = {
  mode: Mode;
  startedAt: number; // also identifies the session
  targetMs: number; // timer and goal
  focusMs: number; // pomodoro lengths, snapshotted at start
  breakMs: number;
  accMs: number; // active time of closed segments
  runningSince: number | null;
  peakMs: number; // highest active time seen, guards against the clock jumping back
};

export type Snapshot = {
  elapsedMs: number;
  remainingMs: number; // timer: negative after it ran out
  overtimeMs: number; // goal: time past the target
  goalLaps: number;
  phase: "focus" | "break" | null;
  phaseRemainingMs: number;
  pomodoroIndex: number; // 1-based, current cycle
  completedPomodoros: number; // finished focus periods
  focusTotalMs: number;
};

export type TimerEvent = "timerDone" | "goalLap" | "pomodoroSwitch";

const MINUTE_MS = 60_000;

export const startSession = (
  mode: Mode,
  targetMin: number,
  pomodoro: {focusMin: number; breakMin: number},
  now: number,
): Session => ({
  mode,
  startedAt: now,
  targetMs: mode === "timer" || mode === "goal" ? targetMin * MINUTE_MS : 0,
  focusMs: pomodoro.focusMin * MINUTE_MS,
  breakMs: pomodoro.breakMin * MINUTE_MS,
  accMs: 0,
  runningSince: now,
  peakMs: 0,
});

const rawElapsed = (s: Session, now: number) => s.accMs + (s.runningSince === null ? 0 : now - s.runningSince);

export const elapsedMs = (s: Session, now: number) => Math.max(s.peakMs, rawElapsed(s, now));

// Called on every tick: if the clock went backwards, continue from the highest value instead of losing time
export const syncSession = (s: Session, now: number): Session => {
  const raw = rawElapsed(s, now);
  if (raw >= s.peakMs) return {...s, peakMs: raw};
  return s.runningSince === null ? s : {...s, accMs: s.peakMs, runningSince: now};
};

export const pauseSession = (s: Session, now: number): Session => {
  if (s.runningSince === null) return s;
  const e = elapsedMs(s, now);
  return {...s, accMs: e, peakMs: e, runningSince: null};
};

export const resumeSession = (s: Session, now: number): Session =>
  s.runningSince === null ? {...s, runningSince: now} : s;

export const snapshot = (s: Session, now: number): Snapshot => {
  const e = elapsedMs(s, now);
  const pomodoro = s.mode === "pomodoro";
  const cycle = s.focusMs + s.breakMs;
  const n = pomodoro && cycle > 0 ? Math.floor(e / cycle) : 0;
  const inCycle = e - n * cycle;
  const isBreak = pomodoro && inCycle >= s.focusMs;
  return {
    elapsedMs: e,
    remainingMs: s.targetMs - e,
    overtimeMs: s.mode === "goal" ? Math.max(0, e - s.targetMs) : 0,
    goalLaps: s.mode === "goal" && s.targetMs > 0 ? Math.floor(e / s.targetMs) : 0,
    phase: pomodoro ? (isBreak ? "break" : "focus") : null,
    phaseRemainingMs: pomodoro ? (isBreak ? cycle - inCycle : s.focusMs - inCycle) : 0,
    pomodoroIndex: n + 1,
    completedPomodoros: n + (isBreak ? 1 : 0),
    focusTotalMs: n * s.focusMs + Math.min(inCycle, s.focusMs),
  };
};

export const isOvertime = (s: Session, snap: Snapshot) => s.mode === "goal" && snap.elapsedMs >= s.targetMs;

// Events between two snapshots of the same session (hooks for the alarms in phase 5)
export const detectEvents = (mode: Mode, prev: Snapshot, next: Snapshot): TimerEvent[] => {
  const events: TimerEvent[] = [];
  if (mode === "timer" && prev.remainingMs > 0 && next.remainingMs <= 0) events.push("timerDone");
  if (mode === "goal" && next.goalLaps > prev.goalLaps) events.push("goalLap");
  if (mode === "pomodoro" && (next.phase !== prev.phase || next.pomodoroIndex !== prev.pomodoroIndex)) {
    events.push("pomodoroSwitch");
  }
  return events;
};

// Delay until the active time reaches the next whole second
export const nextTickDelay = (s: Session, now: number) => 1000 - (elapsedMs(s, now) % 1000) + 5;
