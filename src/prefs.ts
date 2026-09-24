// User settings: types, defaults and validation of stored values.
import type {Lang, TextKey} from "./strings";

export type BuiltinSound = "chime" | "bell" | "beep" | "gong";
export type SoundRef = BuiltinSound | `custom:${string}`; // custom:<library id>
export type AlarmEvent = "timeUp" | "breakStart" | "backToWork";
export type EventSounds = Record<AlarmEvent, SoundRef>;

export type Settings = {
  lang: Lang; // UI language
  // Megjelenés és időzítés
  color: string;
  readingAnimation: boolean;
  pomodoroFocusMin: number;
  pomodoroBreakMin: number;
  playMode: boolean; // fling physics and motion face reactions
  autostart: boolean; // start with Windows (release builds only)
  // Riasztások (used from phase 5)
  soundOn: boolean;
  sounds: EventSounds;
  volume: number; // 0..1, shared by all events
  flashTaskbar: boolean;
  notification: boolean;
  jumpToCursor: boolean;
};

export const COLOR_PRESETS = ["#EDEBE4", "#2C2C2A", "#F0997B", "#5DCAA5", "#7F77DD"];

// label: key of the sound's name in strings
export const SOUNDS: {id: BuiltinSound; label: TextKey}[] = [
  {id: "chime", label: "soundChime"},
  {id: "bell", label: "soundBell"},
  {id: "beep", label: "soundBeep"},
  {id: "gong", label: "soundGong"},
];
export const FALLBACK_SOUND: BuiltinSound = "chime"; // for a missing or unplayable custom sound

// label: key of the event's name in strings
export const ALARM_EVENTS: {id: AlarmEvent; label: TextKey}[] = [
  {id: "timeUp", label: "eventTimeUp"}, // timer alarm and goal laps
  {id: "breakStart", label: "eventBreakStart"}, // pomodoro focus -> break
  {id: "backToWork", label: "eventBackToWork"}, // pomodoro break -> focus
];

// Library id the single custom sound of 0.1.x gets when migrated
export const LEGACY_SOUND_ID = "c1";
export const SOUND_ID_RE = /^[a-z0-9]{1,16}$/;

export const customRef = (id: string): SoundRef => `custom:${id}`;
export const customId = (ref: SoundRef) => (ref.startsWith("custom:") ? ref.slice(7) : null);

export const POMODORO_FOCUS = {min: 5, max: 60, step: 5};
export const POMODORO_BREAK = {min: 1, max: 20, step: 1};

export const DEFAULT_SETTINGS: Settings = {
  lang: "en",
  color: COLOR_PRESETS[0],
  readingAnimation: false,
  pomodoroFocusMin: 25,
  pomodoroBreakMin: 5,
  playMode: true,
  autostart: true,
  soundOn: true,
  sounds: {timeUp: "chime", breakStart: "chime", backToWork: "chime"},
  volume: 0.8,
  flashTaskbar: true,
  notification: false,
  jumpToCursor: false,
};

// Duration offered first in pickDur when nothing is saved yet
export const DEFAULT_DURATION_MIN = 25;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const lang = (v: unknown, d: Lang): Lang => (v === "en" || v === "hu" ? v : d);
const stepped = (v: unknown, d: number, r: {min: number; max: number; step: number}) =>
  typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max
    ? r.min + Math.round((v - r.min) / r.step) * r.step
    : d;

const soundRef = (v: unknown): SoundRef | null => {
  if (SOUNDS.some((s) => s.id === v)) return v as BuiltinSound;
  if (typeof v === "string" && v.startsWith("custom:") && SOUND_ID_RE.test(v.slice(7))) return v as SoundRef;
  return null;
};

// Per-event sounds; a 0.1.x file has a single "sound" that becomes the sound of every event
const eventSounds = (r: Record<string, unknown>): EventSounds => {
  const legacy = r.sound === "custom" ? customRef(LEGACY_SOUND_ID) : soundRef(r.sound);
  const saved = isRecord(r.sounds) ? r.sounds : {};
  const d = DEFAULT_SETTINGS.sounds;
  return {
    timeUp: soundRef(saved.timeUp) ?? legacy ?? d.timeUp,
    breakStart: soundRef(saved.breakStart) ?? legacy ?? d.breakStart,
    backToWork: soundRef(saved.backToWork) ?? legacy ?? d.backToWork,
  };
};

// Field by field: anything missing or invalid falls back to its default (older or newer files load fine)
export const normalizeSettings = (raw: unknown): Settings => {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    lang: lang(r.lang, d.lang),
    color: typeof r.color === "string" && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toUpperCase() : d.color,
    readingAnimation: bool(r.readingAnimation, d.readingAnimation),
    pomodoroFocusMin: stepped(r.pomodoroFocusMin, d.pomodoroFocusMin, POMODORO_FOCUS),
    pomodoroBreakMin: stepped(r.pomodoroBreakMin, d.pomodoroBreakMin, POMODORO_BREAK),
    playMode: bool(r.playMode, d.playMode),
    autostart: bool(r.autostart, d.autostart),
    soundOn: bool(r.soundOn, d.soundOn),
    sounds: eventSounds(r),
    volume: typeof r.volume === "number" && r.volume >= 0 && r.volume <= 1 ? r.volume : d.volume,
    flashTaskbar: bool(r.flashTaskbar, d.flashTaskbar),
    notification: bool(r.notification, d.notification),
    jumpToCursor: bool(r.jumpToCursor, d.jumpToCursor),
  };
};
