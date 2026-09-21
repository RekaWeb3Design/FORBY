// FORBY state machine and what each state shows. Pure: time comes in with the actions.
import type {FaceState} from "./Face";
import {DURATION_MAX, DURATION_MIN, formatElapsed, formatMinutes, formatRemaining} from "./format";
import {DEFAULT_DURATION_MIN, POMODORO_BREAK_MIN, POMODORO_FOCUS_MIN} from "./settings";
import {isOvertime, pauseSession, resumeSession, snapshot, startSession, syncSession, type Mode, type Session} from "./timer";

export type Ui = "idle" | "pickMode" | "pickDur" | "run" | "paused" | "alarm" | "summary";

export type ChipId = Mode | "back" | "resume" | "stop" | `dur:${number}`;
export type Chip = {id: ChipId; label: string};

export type FobyState = {
  ui: Ui;
  pickFor: "timer" | "goal";
  durationMin: number; // last chosen duration
  session: Session | null;
  now: number;
};

export type FobyAction =
  | {type: "orb"; now: number}
  | {type: "chip"; id: ChipId; now: number}
  | {type: "wheel"; delta: number}
  | {type: "submit"; minutes: number; now: number}
  | {type: "tick"; now: number};

const DURATION_CHIPS = [5, 15, 25, 45, 60];

const CHIPS: Partial<Record<Ui, Chip[]>> = {
  pickMode: [
    {id: "timer", label: "Timer"},
    {id: "stopwatch", label: "Stopper"},
    {id: "goal", label: "Cél-stopper"},
    {id: "pomodoro", label: "Pomodoro"},
  ],
  pickDur: [{id: "back", label: "Vissza"}, ...DURATION_CHIPS.map((m): Chip => ({id: `dur:${m}`, label: String(m)}))],
  paused: [{id: "resume", label: "Folytat"}, {id: "stop", label: "Leállít"}],
};

export const initialState: FobyState = {
  ui: "idle",
  pickFor: "timer",
  durationMin: DEFAULT_DURATION_MIN,
  session: null,
  now: 0,
};

const start = (state: FobyState, mode: Mode, now: number, durationMin = state.durationMin): FobyState => ({
  ...state,
  ui: "run",
  durationMin,
  session: startSession(mode, durationMin, {focusMin: POMODORO_FOCUS_MIN, breakMin: POMODORO_BREAK_MIN}, now),
  now,
});

const toSummary = (state: FobyState, now: number): FobyState => ({
  ...state,
  ui: "summary",
  session: state.session && pauseSession(state.session, now),
  now,
});

const onOrb = (state: FobyState, now: number): FobyState => {
  const s = state.session;
  switch (state.ui) {
    case "idle": return {...state, ui: "pickMode", now};
    case "pickMode": return {...state, ui: "idle", now};
    case "pickDur": return start(state, state.pickFor, now);
    case "run": return s ? {...state, ui: "paused", session: pauseSession(s, now), now} : state;
    case "paused": return s ? {...state, ui: "run", session: resumeSession(s, now), now} : state;
    case "alarm": return toSummary(state, now);
    case "summary": return {...state, ui: "idle", session: null, now};
  }
};

const onChip = (state: FobyState, id: ChipId, now: number): FobyState => {
  if (state.ui === "pickMode") {
    if (id === "timer" || id === "goal") return {...state, ui: "pickDur", pickFor: id, now};
    if (id === "stopwatch" || id === "pomodoro") return start(state, id, now);
  }
  if (state.ui === "pickDur") {
    if (id === "back") return {...state, ui: "pickMode", now};
    if (id.startsWith("dur:")) return start(state, state.pickFor, now, Number(id.slice(4)));
  }
  if (state.ui === "paused") {
    if (id === "resume") return onOrb(state, now);
    if (id === "stop") return toSummary(state, now);
  }
  return state;
};

export const reducer = (state: FobyState, action: FobyAction): FobyState => {
  switch (action.type) {
    case "orb": return onOrb(state, action.now);
    case "chip": return onChip(state, action.id, action.now);
    case "wheel":
      if (state.ui !== "pickDur") return state;
      return {...state, durationMin: Math.min(DURATION_MAX, Math.max(DURATION_MIN, state.durationMin + action.delta))};
    case "submit":
      return state.ui === "pickDur" ? start(state, state.pickFor, action.now, action.minutes) : state;
    case "tick": {
      if (!state.session || (state.ui !== "run" && state.ui !== "alarm")) return state;
      const session = syncSession(state.session, action.now);
      const done = state.ui === "run" && session.mode === "timer" && snapshot(session, action.now).remainingMs <= 0;
      return {...state, ui: done ? "alarm" : state.ui, session, now: action.now};
    }
  }
};

export type FobyView = {
  chips: Chip[];
  big: string | null;
  alert: boolean; // coral time: overtime and alarm
  lines: string[];
  editable: boolean; // the number opens the duration input
  face: FaceState;
  smile: boolean;
};

// What to show at the state's last tick (paused and finished sessions are frozen anyway)
export const describe = (state: FobyState): FobyView => {
  const view: FobyView = {chips: CHIPS[state.ui] ?? [], big: null, alert: false, lines: [], editable: false, face: "idle", smile: false};
  const s = state.session;

  if (state.ui === "pickMode") return {...view, lines: ["Válassz módot"]};
  if (state.ui === "pickDur") {
    return {...view, big: formatMinutes(state.durationMin), lines: ["Görgess, vagy kattints a számra"], editable: true};
  }
  if (state.ui === "idle" || !s) return view;

  const snap = snapshot(s, state.now);
  const target = formatMinutes(s.targetMs / 60_000);

  if (state.ui === "alarm") {
    const over = -snap.remainingMs;
    return {
      ...view,
      big: over >= 1000 ? `-${formatElapsed(over)}` : "0:00",
      alert: true,
      lines: [`Lejárt, cél ${target}`, "Kattints a lezáráshoz"],
      face: "alarm",
    };
  }

  if (state.ui === "summary") {
    const summary = {...view, face: "idle" as const, smile: true};
    if (s.mode === "pomodoro") {
      return {...summary, big: formatElapsed(snap.focusTotalMs), lines: ["Fókuszidő", `${snap.completedPomodoros} teljes pomodoro`]};
    }
    if (s.mode === "stopwatch") return {...summary, big: formatElapsed(snap.elapsedMs), lines: ["Összesen"]};
    const rest = snap.remainingMs > 0 ? `${formatRemaining(snap.remainingMs)} maradt` : `Túlóra +${formatElapsed(-snap.remainingMs)}`;
    return {...summary, big: formatElapsed(snap.elapsedMs), lines: [`Cél ${target}`, rest]};
  }

  // run and paused
  const overtime = isOvertime(s, snap);
  let big = formatElapsed(snap.elapsedMs);
  let lines: string[] = [];
  let face: FaceState = "focus";
  if (s.mode === "timer") big = formatRemaining(Math.max(0, snap.remainingMs));
  if (s.mode === "goal") {
    lines = [overtime ? `Cél ${target}, +${formatElapsed(snap.overtimeMs)}` : `Cél ${target}`];
    if (overtime) face = "overtime";
  }
  if (s.mode === "pomodoro") {
    big = formatRemaining(snap.phaseRemainingMs);
    lines = [snap.phase === "break" ? "Szünet" : `Fókusz · ${snap.pomodoroIndex}.`];
    if (snap.phase === "break") face = "break";
  }
  if (state.ui === "paused") {
    lines = ["Szünetel"];
    face = "pause";
  }
  return {...view, big, lines, alert: overtime, face};
};
