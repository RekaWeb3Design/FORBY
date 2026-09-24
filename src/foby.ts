// FORBY state machine and what each state shows. Pure: time comes in with the actions.
import type {FaceState} from "./Face";
import {DURATION_MAX, DURATION_MIN, formatElapsed, formatMinutes, formatRemaining} from "./format";
import {POMODORO_BREAK, POMODORO_FOCUS} from "./prefs";
import {isOvertime, pauseSession, resumeSession, snapshot, startSession, syncSession, type Mode, type Session} from "./timer";
import {strings, type Lang, type Strings} from "./strings";

export type Ui = "idle" | "pickMode" | "pickDur" | "run" | "paused" | "alarm" | "summary";

export type ChipId = Mode | "back" | "custom" | "resume" | "stop" | `dur:${number}`;
export type Chip = {id: ChipId; label: string};

export type FobyState = {
  ui: Ui;
  pickFor: "timer" | "goal";
  durationMin: number; // last chosen duration
  pomodoro: Pomodoro; // current settings; a running session keeps its own copy
  session: Session | null;
  now: number;
};

export type Pomodoro = {focusMin: number; breakMin: number};

export type FobyAction =
  | {type: "orb"; now: number}
  | {type: "chip"; id: ChipId; now: number}
  | {type: "wheel"; delta: number}
  | {type: "submit"; minutes: number; now: number}
  | {type: "tick"; now: number}
  | {type: "settings"; pomodoro: Pomodoro}
  | {type: "intent"; intent: Intent; now: number};

// What the user wants, independent of the gesture that expresses it
export type Intent =
  | {type: "start"; mode: Mode; minutes?: number; focusMin?: number; breakMin?: number}
  | {type: "pause"}
  | {type: "resume"}
  | {type: "finish"}
  | {type: "dismiss"};

const DURATION_CHIPS = [5, 15, 25, 45, 60];

const CHIPS = (t: Strings): Partial<Record<Ui, Chip[]>> => ({
  pickMode: [
    {id: "timer", label: t.chipTimer},
    {id: "stopwatch", label: t.chipStopwatch},
    {id: "goal", label: t.chipGoal},
    {id: "pomodoro", label: t.chipPomodoro},
  ],
  pickDur: [
    {id: "back", label: t.chipBack},
    {id: "custom", label: t.chipCustom}, // opens the duration input; handled by the UI, the state stays
    ...DURATION_CHIPS.map((m): Chip => ({id: `dur:${m}`, label: String(m)})),
  ],
  paused: [{id: "resume", label: t.chipResume}, {id: "stop", label: t.chipStop}],
});

export const createState = (durationMin: number, pomodoro: Pomodoro): FobyState => ({
  ui: "idle",
  pickFor: "timer",
  durationMin,
  pomodoro,
  session: null,
  now: 0,
});

// pomodoro: lengths for this session only, state.pomodoro stays
const start = (state: FobyState, mode: Mode, now: number, durationMin = state.durationMin, pomodoro = state.pomodoro): FobyState => ({
  ...state,
  ui: "run",
  durationMin,
  session: startSession(mode, durationMin, pomodoro, now),
  now,
});

const pause = (state: FobyState, now: number): FobyState =>
  state.session ? {...state, ui: "paused", session: pauseSession(state.session, now), now} : state;

const resume = (state: FobyState, now: number): FobyState =>
  state.session ? {...state, ui: "run", session: resumeSession(state.session, now), now} : state;

const dismiss = (state: FobyState, now: number): FobyState => ({...state, ui: "idle", session: null, now});

const toSummary = (state: FobyState, now: number): FobyState => ({
  ...state,
  ui: "summary",
  session: state.session && pauseSession(state.session, now),
  now,
});

const onOrb = (state: FobyState, now: number): FobyState => {
  switch (state.ui) {
    case "idle": return {...state, ui: "pickMode", now};
    case "pickMode": return {...state, ui: "idle", now};
    case "pickDur": return start(state, state.pickFor, now);
    case "run": return pause(state, now);
    case "paused": return resume(state, now);
    case "alarm": return toSummary(state, now);
    case "summary": return dismiss(state, now);
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

const inRange = (v: number, r: {min: number; max: number}) => Number.isInteger(v) && v >= r.min && v <= r.max;
const optInRange = (v: number | undefined, r: {min: number; max: number}) => v === undefined || inRange(v, r);

export const canApply = (state: FobyState, intent: Intent): boolean => {
  const ui = state.ui;
  switch (intent.type) {
    case "start": {
      if (ui !== "idle" && ui !== "pickMode" && ui !== "pickDur") return false;
      if (intent.mode === "timer" || intent.mode === "goal") {
        return intent.minutes !== undefined && inRange(intent.minutes, {min: DURATION_MIN, max: DURATION_MAX});
      }
      if (intent.mode === "pomodoro") return optInRange(intent.focusMin, POMODORO_FOCUS) && optInRange(intent.breakMin, POMODORO_BREAK);
      return true;
    }
    case "pause": return ui === "run";
    case "resume": return ui === "paused";
    case "finish": return ui === "run" || ui === "paused";
    case "dismiss": return ui === "alarm" || ui === "summary";
  }
};

// Same results as the gesture path; callers check canApply first
const applyIntent = (state: FobyState, intent: Intent, now: number): FobyState => {
  switch (intent.type) {
    case "start":
      if (intent.mode === "timer" || intent.mode === "goal") {
        return start({...state, pickFor: intent.mode}, intent.mode, now, intent.minutes);
      }
      if (intent.mode === "pomodoro") {
        const pomodoro = {focusMin: intent.focusMin ?? state.pomodoro.focusMin, breakMin: intent.breakMin ?? state.pomodoro.breakMin};
        return start(state, intent.mode, now, state.durationMin, pomodoro);
      }
      return start(state, intent.mode, now);
    case "pause": return pause(state, now);
    case "resume": return resume(state, now);
    case "finish": return toSummary(state, now);
    case "dismiss": return dismiss(state, now);
  }
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
    case "settings":
      return {...state, pomodoro: action.pomodoro};
    case "intent":
      return canApply(state, action.intent) ? applyIntent(state, action.intent, action.now) : state;
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
export const describe = (state: FobyState, lang: Lang): FobyView => {
  const t = strings[lang];
  const view: FobyView = {chips: CHIPS(t)[state.ui] ?? [], big: null, alert: false, lines: [], editable: false, face: "idle", smile: false};
  const s = state.session;

  if (state.ui === "pickMode") return {...view, lines: [t.linePickMode]};
  if (state.ui === "pickDur") {
    return {...view, big: formatMinutes(state.durationMin), lines: [t.linePickDur], editable: true};
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
      lines: [t.lineAlarm(target), t.lineAlarmClose],
      face: "alarm",
    };
  }

  if (state.ui === "summary") {
    const summary = {...view, face: "idle" as const, smile: true};
    if (s.mode === "pomodoro") {
      return {...summary, big: formatElapsed(snap.focusTotalMs), lines: [t.lineFocusTime, t.linePomodoros(snap.completedPomodoros)]};
    }
    if (s.mode === "stopwatch") return {...summary, big: formatElapsed(snap.elapsedMs), lines: [t.lineTotal]};
    const rest = snap.remainingMs > 0 ? t.lineRemaining(formatRemaining(snap.remainingMs)) : t.lineOvertime(formatElapsed(-snap.remainingMs));
    return {...summary, big: formatElapsed(snap.elapsedMs), lines: [t.lineGoal(target), rest]};
  }

  // run and paused
  const overtime = isOvertime(s, snap);
  let big = formatElapsed(snap.elapsedMs);
  let lines: string[] = [];
  let face: FaceState = "focus";
  if (s.mode === "timer") big = formatRemaining(Math.max(0, snap.remainingMs));
  if (s.mode === "goal") {
    lines = [overtime ? t.lineGoalOvertime(target, formatElapsed(snap.overtimeMs)) : t.lineGoal(target)];
    if (overtime) face = "overtime";
  }
  if (s.mode === "pomodoro") {
    big = formatRemaining(snap.phaseRemainingMs);
    lines = [snap.phase === "break" ? t.lineBreak : t.lineFocus(snap.pomodoroIndex)];
    if (snap.phase === "break") face = "break";
  }
  if (state.ui === "paused") {
    lines = [t.linePaused];
    face = "pause";
  }
  return {...view, big, lines, alert: overtime, face};
};
