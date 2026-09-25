import {useCallback, useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {availableMonitors, getCurrentWindow, PhysicalPosition, primaryMonitor} from "@tauri-apps/api/window";
import {workAreaOf} from "./bounds";
import Chips from "./Chips";
import {runCommand} from "./commands";
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
import {TRAY_FIND_EVENT, writeLastDuration, writePosition} from "./store";
import {strings} from "./strings";
import {useAlarms} from "./useAlarms";
import {useDragFling} from "./useDragFling";
import {useFoby, type OnTimerEvent} from "./useFoby";
import {useSettings, useSettingsToggle, useWindowEvent} from "./useSettings";
import "./App.css";

// Dev only: type a command in the DevTools console, e.g. forby("timer 5 minutes");
// forbyVoice.start() / .stop() listen to the microphone and log the voice-segment / voice-error events;
// forbyModels.status() / .download("base-q5_1") / .cancel("base-q5_1") manage the Whisper models and log model-* events
declare global {
  interface Window {
    forby?: (text: string) => string;
    forbyVoice?: {start: () => Promise<void>; stop: () => Promise<void>};
    forbyModels?: {
      status: () => Promise<unknown>;
      download: (name: string) => Promise<unknown>;
      cancel: (name: string) => Promise<unknown>;
    };
  }
}

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
  const {state, view, orbClick, pickChip, wheel, submitDuration, runIntent, getState} = useFoby(
    initialDurationMin,
    {focusMin: settings.pomodoroFocusMin, breakMin: settings.pomodoroBreakMin},
    settings.lang,
    (...args) => timerEventRef.current?.(...args),
  );
  const orbRef = useRef<HTMLDivElement>(null);
  const motion = useRef(createMotion());
  const onSettle = useCallback((x: number, y: number) => writePosition({x, y}), []);
  const unlockRef = useRef<() => void>(() => {});
  const clickedRef = useRef<() => void>(() => {});
  // Clicks are user gestures: use them to (re)unlock audio as well; a click also stops the soft flashing
  const onOrbClick = useCallback(() => {
    unlockRef.current();
    clickedRef.current();
    orbClick();
  }, [orbClick]);
  const [editRequest, setEditRequest] = useState(0);
  const onPickChip = useCallback((id: ChipId) => {
    unlockRef.current();
    if (id === "custom") setEditRequest((n) => n + 1);
    else pickChip(id);
  }, [pickChip]);
  const {activeRef, animateTo} = useDragFling(orbRef, motion, {playMode: settings.playMode, onClick: onOrbClick, onSettle});
  const alarms = useAlarms(settings, state.ui, animateTo);
  timerEventRef.current = alarms.onEvent;
  unlockRef.current = alarms.unlockAudio;
  clickedRef.current = alarms.clicked;
  const ignoreRef = useRef<boolean | null>(null);

  // Tray menu and settings window title in the chosen language (the Rust side starts with neutral defaults)
  useEffect(() => {
    const t = strings[settings.lang];
    invoke("set_tray_labels", {settings: t.traySettings, find: t.trayFind, quit: t.trayQuit, windowTitle: t.settingsWindowTitle})
      .catch((err) => logError("setting the tray labels failed", err));
  }, [settings.lang]);

  // Dev console hook for testing text commands; the early return lets the production build drop all of it
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const lang = settings.lang;
    window.forby = (text: string) => {
      const reply = runCommand(text, {getState, runIntent}, lang)?.reply ?? strings[lang].cmdNotUnderstood;
      console.log(reply);
      return reply;
    };
    const call = <T,>(cmd: string, args?: Record<string, unknown>) =>
      invoke<T>(cmd, args).catch((err: unknown) => console.error(cmd, err));
    window.forbyVoice = {start: () => call("voice_start"), stop: () => call("voice_stop")};
    window.forbyModels = {
      status: () => call("model_status").then((s) => (console.table(s), s)),
      download: (name) => call("model_download", {name}),
      cancel: (name) => call("model_cancel", {name}),
    };
    const unlisteners = ["voice-segment", "voice-error", "model-done", "model-error"].map((name) =>
      getCurrentWindow().listen(name, (e) => console.log(name, e.payload)));
    // Progress in 5% steps per model
    const lastStep = new Map<string, number>();
    unlisteners.push(getCurrentWindow().listen<{name: string; bytes: number; total: number}>("model-progress", (e) => {
      const {name, bytes, total} = e.payload;
      const step = Math.floor((bytes / total) * 20);
      if (step === lastStep.get(name)) return;
      lastStep.set(name, step);
      console.log("model-progress", name, `${step * 5}%`, `${(bytes / 2 ** 20).toFixed(1)} / ${(total / 2 ** 20).toFixed(1)} MiB`);
    }));
    return () => {
      delete window.forby;
      delete window.forbyVoice;
      delete window.forbyModels;
      unlisteners.forEach((p) => void p.then((un) => un()));
    };
  }, [settings.lang, getState, runIntent]);

  // Start with Windows: the registry entry follows the setting (the Rust side skips it in dev)
  useEffect(() => {
    invoke("set_autostart", {enabled: settings.autostart}).catch((err) => logError("changing autostart failed", err));
  }, [settings.autostart]);

  // Tray "FORBY megkeresése": the orb centre to the middle of the primary monitor's work area
  useWindowEvent<null>(TRAY_FIND_EVENT, () => {
    void (async () => {
      try {
        const mon = (await primaryMonitor()) ?? (await availableMonitors())[0];
        if (!mon) return logError("finding FORBY: no monitor");
        const a = workAreaOf(mon);
        const x = Math.round((a.left + a.right) / 2 - ORB_CX * mon.scaleFactor);
        const y = Math.round((a.top + a.bottom) / 2 - ORB_CY * mon.scaleFactor);
        await getCurrentWindow().setPosition(new PhysicalPosition(x, y));
        writePosition({x, y});
      } catch (err) {
        logError("finding FORBY failed", err);
      }
    })();
  });

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
        aria-label={strings[settings.lang].settingsButton}
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
        editRequest={editRequest}
        top={TIME_TOP}
        onSubmit={submitDuration}
      />
    </main>
  );
}

export default App;
