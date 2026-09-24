import {useCallback, useEffect, useMemo, useReducer, useRef} from "react";
import {canApply, createState, describe, reducer, type ChipId, type FobyState, type Intent, type Pomodoro} from "./foby";
import {detectEvents, nextTickDelay, snapshot, type Session, type Snapshot, type TimerEvent} from "./timer";
import type {Lang} from "./strings";

export type OnTimerEvent = (event: TimerEvent, snap: Snapshot, session: Session) => void;

// State machine + once-a-second ticking aligned to whole seconds of active time.
// onEvent reports timer events (the alarms hook in here in phase 5).
export const useFoby = (initialDurationMin: number, pomodoro: Pomodoro, lang: Lang, onEvent?: OnTimerEvent) => {
  const [state, dispatch] = useReducer(reducer, undefined, () => createState(initialDurationMin, pomodoro));

  // Settings changes apply to the next session; the running one keeps its snapshot
  useEffect(() => {
    dispatch({type: "settings", pomodoro: {focusMin: pomodoro.focusMin, breakMin: pomodoro.breakMin}});
  }, [pomodoro.focusMin, pomodoro.breakMin]);

  // Latest rendered state for commands, read outside React's render cycle
  const stateRef = useRef(state);
  stateRef.current = state;

  const view = useMemo(() => describe(state, lang), [state, lang]);

  const ticking = !!state.session && (state.ui === "run" || state.ui === "alarm");
  useEffect(() => {
    if (!ticking || !state.session) return;
    const id = window.setTimeout(() => dispatch({type: "tick", now: Date.now()}), nextTickDelay(state.session, Date.now()));
    return () => clearTimeout(id);
  }, [ticking, state]);

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const prevRef = useRef<{id: number; snap: Snapshot} | null>(null);
  useEffect(() => {
    const s = state.session;
    if (!s) {
      prevRef.current = null;
      return;
    }
    const snap = snapshot(s, state.now);
    const prev = prevRef.current;
    if (prev && prev.id === s.startedAt) detectEvents(s.mode, prev.snap, snap).forEach((e) => onEventRef.current?.(e, snap, s));
    prevRef.current = {id: s.startedAt, snap};
  }, [state]);

  return {
    state,
    view,
    orbClick: useCallback(() => dispatch({type: "orb", now: Date.now()}), []),
    pickChip: useCallback((id: ChipId) => dispatch({type: "chip", id, now: Date.now()}), []),
    wheel: useCallback((delta: number) => dispatch({type: "wheel", delta}), []),
    submitDuration: useCallback((minutes: number) => dispatch({type: "submit", minutes, now: Date.now()}), []),
    // Commands: false when the intent does not apply to the current state (nothing is dispatched then)
    runIntent: useCallback((intent: Intent) => {
      if (!canApply(stateRef.current, intent)) return false;
      dispatch({type: "intent", intent, now: Date.now()});
      return true;
    }, []),
    getState: useCallback((): FobyState => stateRef.current, []),
  };
};
