import {useCallback, useEffect, useRef} from "react";
import {availableMonitors, cursorPosition, getCurrentWindow, UserAttentionType} from "@tauri-apps/api/window";
import {isPermissionGranted, requestPermission, sendNotification} from "@tauri-apps/plugin-notification";
import {containsPoint, nearestAreaIndex, workAreaOf} from "./bounds";
import type {Ui} from "./foby";
import {formatMinutes} from "./format";
import {CONTENT_BOTTOM, ORB_CX, ORB_CY, RING_OUTER} from "./layout";
import type {Settings} from "./prefs";
import {createAudio, decodeSound, playSound} from "./sounds";
import {CUSTOM_SOUND_EVENT, loadCustomSound} from "./store";
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

type Jump = {origin: {x: number; y: number}; userMoved: boolean};

const notify = async (body: string) => {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({title: "FORBY", body});
  } catch (err) {
    console.error("FORBY: notification failed", err);
  }
};

// Alarms in the main window: sounds, toast, taskbar flashing and the jump to the cursor
export const useAlarms = (settings: Settings, ui: Ui, animateTo: AnimateTo) => {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const audioRef = useRef(createAudio());
  const customRef = useRef<AudioBuffer | null>(null);
  const softFlashRef = useRef<number | null>(null);
  const jumpRef = useRef<Jump | null>(null);

  // Custom sound: loaded at start and whenever the settings window saves a new one
  const loadCustom = useCallback(async () => {
    try {
      const bytes = await loadCustomSound();
      customRef.current = bytes.byteLength ? await decodeSound(bytes) : null;
    } catch (err) {
      customRef.current = null;
      console.error("FORBY: loading the custom sound failed", err);
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
      console.error("FORBY: playing the alarm failed", err);
    }
  }, []);

  // Taskbar flashing
  const stopFlash = useCallback(() => {
    if (softFlashRef.current !== null) clearTimeout(softFlashRef.current);
    softFlashRef.current = null;
    getCurrentWindow().requestUserAttention(null).catch((err) => console.error("FORBY: stopping flash failed", err));
  }, []);
  const flash = useCallback((soft: boolean) => {
    if (!settingsRef.current.flashTaskbar) return;
    getCurrentWindow()
      .requestUserAttention(UserAttentionType.Critical)
      .catch((err) => console.error("FORBY: taskbar flash failed", err));
    if (softFlashRef.current !== null) clearTimeout(softFlashRef.current);
    softFlashRef.current = soft ? window.setTimeout(stopFlash, SOFT_FLASH_MS) : null;
  }, [stopFlash]);

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
      .catch((err) => console.error("FORBY: focus listener failed", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [stopFlash]);

  // Jump next to the cursor on its monitor, keeping the orb, ring and time inside the work area
  const jump = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const [pos, scale, cursor, monitors] = await Promise.all([
        win.outerPosition(), win.scaleFactor(), cursorPosition(), availableMonitors(),
      ]);
      if (Math.hypot(cursor.x - (pos.x + ORB_CX * scale), cursor.y - (pos.y + ORB_CY * scale)) < JUMP_SKIP_DIST * scale) return;
      const areas = monitors.map(workAreaOf);
      const i = nearestAreaIndex(areas, cursor.x, cursor.y);
      if (i < 0) return;
      const a = areas[i];
      const s = monitors[i].scaleFactor;
      let cx = cursor.x + JUMP_OFFSET * s;
      if (cx > a.right - JUMP_MARGIN * s) cx = cursor.x - JUMP_OFFSET * s;
      cx = Math.min(Math.max(cx, a.left + JUMP_MARGIN * s), a.right - JUMP_MARGIN * s);
      const cy = Math.min(Math.max(cursor.y - JUMP_OFFSET * s, a.top + JUMP_MARGIN * s), a.bottom - JUMP_MARGIN_BOTTOM * s);
      jumpRef.current = {origin: {x: pos.x, y: pos.y}, userMoved: false};
      await animateTo(cx - ORB_CX * s, cy - ORB_CY * s, JUMP_MS);
    } catch (err) {
      console.error("FORBY: jump to cursor failed", err);
    }
  }, [animateTo]);

  // Back to where it was, unless the user moved FORBY meanwhile or that place is no longer on a monitor
  const jumpBack = useCallback(async () => {
    const j = jumpRef.current;
    jumpRef.current = null;
    if (!j || j.userMoved) return;
    try {
      const monitors = await availableMonitors();
      const visible = monitors.some((m) =>
        containsPoint(workAreaOf(m), j.origin.x + ORB_CX * m.scaleFactor, j.origin.y + ORB_CY * m.scaleFactor));
      if (visible) await animateTo(j.origin.x, j.origin.y, JUMP_MS);
    } catch (err) {
      console.error("FORBY: jumping back failed", err);
    }
  }, [animateTo]);

  // Timer alarm: sound now and every 10.2 s, toast, flashing, jump; all undone when it is closed
  const isAlarm = ui === "alarm";
  useEffect(() => {
    if (!isAlarm) return;
    const s = settingsRef.current;
    void play();
    const repeat = window.setInterval(() => void play(), ALARM_REPEAT_MS);
    flash(false);
    if (s.notification) void notify("Lejárt az idő");
    if (s.jumpToCursor) void jump();
    return () => {
      clearInterval(repeat);
      stopFlash();
      void jumpBack();
    };
  }, [isAlarm, play, flash, stopFlash, jump, jumpBack]);

  const onEvent = useCallback<OnTimerEvent>((event, snap, session) => {
    const s = settingsRef.current;
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

  return {
    onEvent,
    // A user gesture (click on the orb): lets audio run even if autoplay were blocked
    unlockAudio: useCallback(() => audioRef.current.unlock(), []),
    // The user moved FORBY: it stays there after the alarm
    userMoved: useCallback(() => {
      if (jumpRef.current) jumpRef.current.userMoved = true;
    }, []),
  };
};
