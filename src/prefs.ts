// User settings: types, defaults and validation of stored values.

export type SoundId = "chime" | "bell" | "beep" | "gong" | "custom";

export type Settings = {
  // Megjelenés és időzítés
  color: string;
  readingAnimation: boolean;
  pomodoroFocusMin: number;
  pomodoroBreakMin: number;
  playMode: boolean; // fling physics and motion face reactions
  autostart: boolean; // start with Windows (release builds only)
  // Riasztások (used from phase 5)
  soundOn: boolean;
  sound: SoundId;
  volume: number; // 0..1
  flashTaskbar: boolean;
  notification: boolean;
  jumpToCursor: boolean;
};

export const COLOR_PRESETS = ["#EDEBE4", "#2C2C2A", "#F0997B", "#5DCAA5", "#7F77DD"];

export const SOUNDS: {id: SoundId; label: string}[] = [
  {id: "chime", label: "Csengő"},
  {id: "bell", label: "Harang"},
  {id: "beep", label: "Pittyegés"},
  {id: "gong", label: "Gong"},
  {id: "custom", label: "Saját hang"},
];

export const POMODORO_FOCUS = {min: 5, max: 60, step: 5};
export const POMODORO_BREAK = {min: 1, max: 20, step: 1};

export const DEFAULT_SETTINGS: Settings = {
  color: COLOR_PRESETS[0],
  readingAnimation: false,
  pomodoroFocusMin: 25,
  pomodoroBreakMin: 5,
  playMode: true,
  autostart: true,
  soundOn: true,
  sound: "chime",
  volume: 0.8,
  flashTaskbar: true,
  notification: false,
  jumpToCursor: false,
};

// Duration offered first in pickDur when nothing is saved yet
export const DEFAULT_DURATION_MIN = 25;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const stepped = (v: unknown, d: number, r: {min: number; max: number; step: number}) =>
  typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max
    ? r.min + Math.round((v - r.min) / r.step) * r.step
    : d;

// Field by field: anything missing or invalid falls back to its default (older or newer files load fine)
export const normalizeSettings = (raw: unknown): Settings => {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    color: typeof r.color === "string" && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toUpperCase() : d.color,
    readingAnimation: bool(r.readingAnimation, d.readingAnimation),
    pomodoroFocusMin: stepped(r.pomodoroFocusMin, d.pomodoroFocusMin, POMODORO_FOCUS),
    pomodoroBreakMin: stepped(r.pomodoroBreakMin, d.pomodoroBreakMin, POMODORO_BREAK),
    playMode: bool(r.playMode, d.playMode),
    autostart: bool(r.autostart, d.autostart),
    soundOn: bool(r.soundOn, d.soundOn),
    sound: SOUNDS.some((s) => s.id === r.sound) ? (r.sound as SoundId) : d.sound,
    volume: typeof r.volume === "number" && r.volume >= 0 && r.volume <= 1 ? r.volume : d.volume,
    flashTaskbar: bool(r.flashTaskbar, d.flashTaskbar),
    notification: bool(r.notification, d.notification),
    jumpToCursor: bool(r.jumpToCursor, d.jumpToCursor),
  };
};
