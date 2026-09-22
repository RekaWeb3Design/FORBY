import {useCallback, useEffect, useRef} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import Chips from "./Chips";
import Face from "./Face";
import type {ChipId} from "./foby";
import Ring from "./Ring";
import TimeText from "./TimeText";
import {
  CHIP_ARC_R,
  ORB_CX,
  ORB_CY,
  ORB_R,
  SETTINGS_BTN_ANGLE,
  SETTINGS_BTN_DIST,
  SETTINGS_BTN_SIZE,
  TIME_TOP,
} from "./layout";
import {logError} from "./log";
import {createMotion} from "./motion";
import type {Settings} from "./prefs";
import {writeLastDuration, writePosition} from "./store";
import {useAlarms} from "./useAlarms";
import {useDragFling} from "./useDragFling";
import {useFoby, type OnTimerEvent} from "./useFoby";
import {useSettings, useSettingsToggle} from "./useSettings";
import "./App.css";

const BTN_ANGLE_RAD = (SETTINGS_BTN_ANGLE * Math.PI) / 180;
const BTN_LEFT = ORB_CX + SETTINGS_BTN_DIST * Math.sin(BTN_ANGLE_RAD) - SETTINGS_BTN_SIZE / 2;
const BTN_TOP = ORB_CY - SETTINGS_BTN_DIST * Math.cos(BTN_ANGLE_RAD) - SETTINGS_BTN_SIZE / 2;

// Interactive elements are marked with data-hit ("circle" for round ones); everything else is click-through.
const isOverInteractive = (x: number, y: number) =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-hit]")).some((el) => {
    const r = el.getBoundingClientRect();
    if (el.dataset.hit === "circle") {
      return Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) <= r.width / 2;
    }
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });

type AppProps = {
  initialSettings: Settings;
  initialDurationMin: number;
};

function App({initialSettings, initialDurationMin}: AppProps) {
  const settings = useSettings(initialSettings);
  const toggleSettings = useSettingsToggle();
  const timerEventRef = useRef<OnTimerEvent | null>(null);
  const {state, view, orbClick, pickChip, wheel, submitDuration} = useFoby(
    initialDurationMin,
    {focusMin: settings.pomodoroFocusMin, breakMin: settings.pomodoroBreakMin},
    (...args) => timerEventRef.current?.(...args),
  );
  const orbRef = useRef<HTMLDivElement>(null);
  const motion = useRef(createMotion());
  const userMovedRef = useRef<() => void>(() => {});
  const onSettle = useCallback((x: number, y: number) => {
    writePosition({x, y});
    userMovedRef.current();
  }, []);
  const unlockRef = useRef<() => void>(() => {});
  const clickedRef = useRef<() => void>(() => {});
  // Clicks are user gestures: use them to (re)unlock audio as well; a click also stops the soft flashing
  const onOrbClick = useCallback(() => {
    unlockRef.current();
    clickedRef.current();
    orbClick();
  }, [orbClick]);
  const onPickChip = useCallback((id: ChipId) => {
    unlockRef.current();
    pickChip(id);
  }, [pickChip]);
  const {activeRef, animateTo} = useDragFling(orbRef, motion, {playMode: settings.playMode, onClick: onOrbClick, onSettle});
  const alarms = useAlarms(settings, state.ui, animateTo);
  timerEventRef.current = alarms.onEvent;
  userMovedRef.current = alarms.userMoved;
  unlockRef.current = alarms.unlockAudio;
  clickedRef.current = alarms.clicked;
  const ignoreRef = useRef<boolean | null>(null);

  // Remember the last chosen duration
  const savedDurationRef = useRef(initialDurationMin);
  useEffect(() => {
    if (state.durationMin === savedDurationRef.current) return;
    savedDurationRef.current = state.durationMin;
    writeLastDuration(state.durationMin);
  }, [state.durationMin]);

  const onCursor = useCallback((x: number, y: number) => {
    const ignore = !activeRef.current && !isOverInteractive(x, y);
    if (ignore === ignoreRef.current) return;
    ignoreRef.current = ignore;
    getCurrentWindow().setIgnoreCursorEvents(ignore).catch((err) => {
      ignoreRef.current = null;
      logError("setIgnoreCursorEvents failed", err);
    });
  }, [activeRef]);

  return (
    <main className="shell">
      <Chips chips={view.chips} cx={ORB_CX} cy={ORB_CY} radius={CHIP_ARC_R} onPick={onPickChip} />
      <Ring ui={state.ui} session={state.session} left={ORB_CX - ORB_R} top={ORB_CY - ORB_R} size={ORB_R * 2} />
      <div
        className="orb"
        ref={orbRef}
        data-hit="circle"
        style={{left: ORB_CX - ORB_R, top: ORB_CY - ORB_R, width: ORB_R * 2, height: ORB_R * 2}}
        onWheel={(e) => wheel(e.deltaY < 0 ? 1 : -1)}
      >
        <Face
          state={view.face}
          color={settings.color}
          smile={view.smile}
          readingAnimation={settings.readingAnimation}
          motion={motion}
          onCursor={onCursor}
        />
      </div>
      <button
        className="settings-btn"
        data-hit="circle"
        aria-label="Beállítások"
        style={{left: BTN_LEFT, top: BTN_TOP, width: SETTINGS_BTN_SIZE, height: SETTINGS_BTN_SIZE}}
        onClick={toggleSettings}
      >
        <svg viewBox="0 0 22 22" width="100%" height="100%">
          {[6.5, 11, 15.5].map((x) => <circle key={x} cx={x} cy="11" r="1.6" fill="currentColor" />)}
        </svg>
      </button>
      <TimeText
        big={view.big}
        alert={view.alert}
        lines={view.lines}
        editable={view.editable}
        durationMin={state.durationMin}
        top={TIME_TOP}
        onSubmit={submitDuration}
      />
    </main>
  );
}

export default App;
