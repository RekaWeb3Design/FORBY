import {useCallback, useEffect, useRef} from "react";
import {invoke} from "@tauri-apps/api/core";
import {availableMonitors, cursorPosition, getCurrentWindow} from "@tauri-apps/api/window";
import {nearestAreaIndex, workAreaOf} from "./bounds";
import type {Ui} from "./foby";
import {formatMinutes} from "./format";
import {CONTENT_BOTTOM, ORB_CX, ORB_CY, RING_OUTER} from "./layout";
import {logError, logInfo} from "./log";
import type {Settings} from "./prefs";
import {createAudio, decodeSound, playSound} from "./sounds";
import {ALARM_TEST_EVENT, CUSTOM_SOUND_EVENT, loadCustomSound, writePosition, type AlarmTest} from "./store";
import type {AnimateTo} from "./useDragFling";
import type {OnTimerEvent} from "./useFoby";
import {useWindowEvent} from "./useSettings";

const ALARM_REPEAT_MS = 10_200;
const POMODORO_VOLUME = 0.7; // share of the set volume
const SOFT_FLASH_MS = 30_000; // goal / pomodoro flashing stops by itself after this

// Jump to the cursor (logical px, scaled by the target monitor)
const JUMP_MS = 450;
const JUMP_OFFSET = 90; // orb centre up and to the side of the cursor
const JUMP_SKIP_DIST = 200; // already this close: no jump
const JUMP_MARGIN = RING_OUTER + 6; // orb centre to the work area edge (left, right, top)
const JUMP_MARGIN_BOTTOM = CONTENT_BOTTOM - ORB_CY + 6; // the time pill below must fit too

// Dev test buttons in the settings window
const TEST_FLASH_MS = 5000;
const TEST_JUMP_DELAY_MS = 3000; // time to move the cursor away from the settings window

// Windows toast, sent by the Rust side (errors come back and are logged)
const notify = async (body: string) => {
  try {
    await invoke("show_toast", {body});
    logInfo(`toast sent: "${body}"`);
  } catch (err) {
    logError("toast failed", err);
  }
};

const setFlash = (on: boolean) =>
  invoke("flash_taskbar", {on}).catch((err) => logError(on ? "taskbar flash failed" : "stopping flash failed", err));

// Alarms in the main window: sounds, toast, taskbar flashing and the jump to the cursor
export const useAlarms = (settings: Settings, ui: Ui, animateTo: AnimateTo) => {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const audioRef = useRef(createAudio());
  const customRef = useRef<AudioBuffer | null>(null);
  const softFlashRef = useRef<number | null>(null);

  // Custom sound: loaded at start and whenever the settings window saves a new one
  const loadCustom = useCallback(async () => {
    try {
      const bytes = await loadCustomSound();
      customRef.current = bytes.byteLength ? await decodeSound(bytes) : null;
    } catch (err) {
      customRef.current = null;
      logError("loading the custom sound failed", err);
    }
  }, []);
  useEffect(() => {void loadCustom();}, [loadCustom]);
  useWindowEvent<null>(CUSTOM_SOUND_EVENT, () => void loadCustom());

  const play = useCallback(async (share = 1) => {
    const s = settingsRef.current;
    if (!s.soundOn) return;
    try {
      const ctx = await audioRef.current.get();
      playSound(ctx, s.sound, s.volume * share, customRef.current);
    } catch (err) {
      logError("playing the alarm failed", err);
    }
  }, []);

  // Taskbar flashing; a soft one stops by itself after softMs
  const stopFlash = useCallback(() => {
    if (softFlashRef.current !== null) clearTimeout(softFlashRef.current);
    softFlashRef.current = null;
    void setFlash(false);
  }, []);
  const startFlash = useCallback((softMs: number | null) => {
    void setFlash(true);
    if (softFlashRef.current !== null) clearTimeout(softFlashRef.current);
    softFlashRef.current = softMs === null ? null : window.setTimeout(stopFlash, softMs);
  }, [stopFlash]);
  const flash = useCallback((soft: boolean) => {
    if (!settingsRef.current.flashTaskbar) return;
    startFlash(soft ? SOFT_FLASH_MS : null);
    logInfo(`taskbar flashing${soft ? " (soft)" : ""}`);
  }, [startFlash]);

  // Goal and pomodoro flashing stops when FORBY gets focus (a click on it focuses it too)
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    getCurrentWindow()
      .onFocusChanged(({payload: focused}) => {
        if (focused && softFlashRef.current !== null) stopFlash();
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch((err) => logError("focus listener failed", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [stopFlash]);

  // Jump next to the cursor on its monitor, keeping the orb, ring and time inside the work area.
  // FORBY stays there (no jump back) and that becomes its saved position.
  // force: also when the cursor is already close (test button)
  const jump = useCallback(async (force = false) => {
    try {
      const win = getCurrentWindow();
      const [pos, scale, cursor, monitors] = await Promise.all([
        win.outerPosition(), win.scaleFactor(), cursorPosition(), availableMonitors(),
      ]);
      const dist = Math.hypot(cursor.x - (pos.x + ORB_CX * scale), cursor.y - (pos.y + ORB_CY * scale)) / scale;
      if (!force && dist < JUMP_SKIP_DIST) {
        return logInfo(`jump skipped: the cursor is ${Math.round(dist)} px from the orb (jumps only beyond ${JUMP_SKIP_DIST} px)`);
      }
      const areas = monitors.map(workAreaOf);
      const i = nearestAreaIndex(areas, cursor.x, cursor.y);
      if (i < 0) return logError("jump skipped: no monitor found");
      const a = areas[i];
      const s = monitors[i].scaleFactor;
      let cx = cursor.x + JUMP_OFFSET * s;
      if (cx > a.right - JUMP_MARGIN * s) cx = cursor.x - JUMP_OFFSET * s;
      cx = Math.min(Math.max(cx, a.left + JUMP_MARGIN * s), a.right - JUMP_MARGIN * s);
      const cy = Math.min(Math.max(cursor.y - JUMP_OFFSET * s, a.top + JUMP_MARGIN * s), a.bottom - JUMP_MARGIN_BOTTOM * s);
      const x = Math.round(cx - ORB_CX * s);
      const y = Math.round(cy - ORB_CY * s);
      if (!(await animateTo(x, y, JUMP_MS))) return logInfo("jump interrupted (FORBY was being dragged or thrown)");
      writePosition({x, y});
      logInfo("jumped to the cursor");
    } catch (err) {
      logError("jump to cursor failed", err);
    }
  }, [animateTo]);

  // Timer alarm: sound now and every 10.2 s, toast, flashing, jump; sound and flashing stop when it is closed
  const isAlarm = ui === "alarm";
  useEffect(() => {
    if (!isAlarm) return;
    const s = settingsRef.current;
    logInfo(`timer alarm (flash ${s.flashTaskbar ? "on" : "off"}, toast ${s.notification ? "on" : "off"}, jump ${s.jumpToCursor ? "on" : "off"})`);
    void play();
    const repeat = window.setInterval(() => void play(), ALARM_REPEAT_MS);
    flash(false);
    if (s.notification) void notify("Lejárt az idő");
    if (s.jumpToCursor) void jump();
    return () => {
      clearInterval(repeat);
      stopFlash();
    };
  }, [isAlarm, play, flash, stopFlash, jump]);

  const onEvent = useCallback<OnTimerEvent>((event, snap, session) => {
    const s = settingsRef.current;
    logInfo(`${event} (flash ${s.flashTaskbar ? "on" : "off"}, toast ${s.notification ? "on" : "off"})`);
    if (event === "goalLap") {
      void play();
      if (snap.goalLaps !== 1) return;
      flash(true);
      if (s.notification) void notify(`Elérted a célt (${formatMinutes(session.targetMs / 60_000)})`);
    }
    if (event === "pomodoroSwitch") {
      void play(POMODORO_VOLUME);
      flash(true);
      if (s.notification) void notify(snap.phase === "break" ? "Szünet következik" : "Vissza a fókuszhoz");
    }
  }, [play, flash]);

  // Dev test buttons: each signal right away, whatever the settings say
  useWindowEvent<AlarmTest>(ALARM_TEST_EVENT, (test) => {
    logInfo(`test: ${test}`);
    if (test === "flash") startFlash(TEST_FLASH_MS);
    if (test === "toast") void notify("Teszt értesítés");
    if (test === "jump") window.setTimeout(() => void jump(true), TEST_JUMP_DELAY_MS);
  });

  return {
    onEvent,
    // A click on FORBY stops the goal / pomodoro flashing (a focus change alone misses it if FORBY was already active)
    clicked: useCallback(() => {
      if (softFlashRef.current !== null) stopFlash();
    }, [stopFlash]),
    // A user gesture (click on the orb): lets audio run even if autoplay were blocked
    unlockAudio: useCallback(() => audioRef.current.unlock(), []),
  };
};
