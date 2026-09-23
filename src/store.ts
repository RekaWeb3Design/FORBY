// Persistent storage (tauri-plugin-store, one file in the app data folder).
// Each key has a single writer: "settings" and "soundLibrary" the settings window, the rest the main window.
// Exception: the one-off 0.1.x migration (migrateSounds) in the main window, before the settings window can open.
import {invoke} from "@tauri-apps/api/core";
import {load, type Store} from "@tauri-apps/plugin-store";
import {DURATION_MAX, DURATION_MIN} from "./format";
import {logError, logInfo} from "./log";
import {customId, LEGACY_SOUND_ID, normalizeSettings, SOUND_ID_RE, SOUNDS, type Settings} from "./prefs";

const STORE_FILE = "forby.json";
const AUTOSAVE_MS = 200;

// Events between the windows
export const SETTINGS_EVENT = "settings-changed";
export const SETTINGS_CLOSED_EVENT = "settings-closed";
export const SOUND_LIBRARY_EVENT = "sound-library-changed";
export const ALARM_TEST_EVENT = "alarm-test"; // dev only: settings window -> main window

export type AlarmTest = "flash" | "toast" | "jump";

// Tray menu (sent by the Rust side to the main window)
export const TRAY_SETTINGS_EVENT = "tray-settings";
export const TRAY_FIND_EVENT = "tray-find";

export type Position = {x: number; y: number}; // main window, physical px

let storePromise: Promise<Store> | null = null;
const getStore = () => {
  if (!storePromise) {
    storePromise = load(STORE_FILE, {autoSave: AUTOSAVE_MS, defaults: {}});
    storePromise.catch(() => {storePromise = null;});
  }
  return storePromise;
};

const write = (key: string, value: unknown) => {
  getStore()
    .then((store) => store.set(key, value))
    .catch((err) => logError(`saving "${key}" failed`, err));
};

export const readSettings = async (): Promise<Settings> => normalizeSettings(await (await getStore()).get("settings"));
export const writeSettings = (settings: Settings) => write("settings", settings);

export const readLastDuration = async (): Promise<number | null> => {
  const v = await (await getStore()).get("lastDurationMin");
  return typeof v === "number" && Number.isInteger(v) && v >= DURATION_MIN && v <= DURATION_MAX ? v : null;
};
export const writeLastDuration = (min: number) => write("lastDurationMin", min);

export const readPosition = async (): Promise<Position | null> => {
  const v = await (await getStore()).get<Position>("position");
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? {x: Math.round(v.x), y: Math.round(v.y)} : null;
};
export const writePosition = (pos: Position) => write("position", pos);

// Custom sound library: the files are kept by the Rust side ("<id>.<ext>" in the app data folder), their list here
export type LibrarySound = {id: string; name: string; durationSec: number};

export const SOUND_NAME_MAX = 30;

const librarySound = (v: unknown): v is LibrarySound => {
  const r = v as LibrarySound;
  return typeof v === "object" && v !== null && typeof r.id === "string" && SOUND_ID_RE.test(r.id)
    && typeof r.name === "string" && Number.isFinite(r.durationSec);
};

// null: not saved yet (a 0.1.x file)
const readLibraryRaw = async (): Promise<LibrarySound[] | null> => {
  const v = await (await getStore()).get<unknown>("soundLibrary");
  return Array.isArray(v) ? v.filter(librarySound) : null;
};
export const readSoundLibrary = async () => (await readLibraryRaw()) ?? [];
export const writeSoundLibrary = (library: LibrarySound[]) => write("soundLibrary", library);

export const saveSound = (id: string, bytes: ArrayBuffer, ext: string) =>
  invoke("save_sound", new Uint8Array(bytes), {headers: {"x-id": id, "x-ext": ext}});
// Empty buffer when the sound file is missing
export const loadSound = (id: string) => invoke<ArrayBuffer>("read_sound", {id});
export const deleteSound = (id: string) => invoke("delete_sound", {id});

// Settings whose custom sounds are all in the library; the rest fall back to the first built-in sound
export const withKnownSounds = (settings: Settings, library: LibrarySound[]): Settings => {
  const known = (ref: Settings["sounds"][keyof Settings["sounds"]]) => {
    const id = customId(ref);
    return id === null || library.some((s) => s.id === id) ? ref : SOUNDS[0].id;
  };
  const {timeUp, breakStart, backToWork} = settings.sounds;
  return {...settings, sounds: {timeUp: known(timeUp), breakStart: known(breakStart), backToWork: known(backToWork)}};
};

// 0.1.1 -> 0.2.0, once, in the main window at startup: the single custom sound becomes "Saját hang 1"
// in the library, and the settings are saved in the new shape (the old "sound" applies to every event).
// Safe to repeat if interrupted: the library key is written last.
export const migrateSounds = async (): Promise<void> => {
  const store = await getStore();
  if ((await readLibraryRaw()) !== null) return;
  const exists = await invoke<boolean>("migrate_legacy_sound", {id: LEGACY_SOUND_ID});
  const old = await store.get<{durationSec?: unknown}>("customSound");
  const durationSec = typeof old?.durationSec === "number" && Number.isFinite(old.durationSec) ? old.durationSec : 0;
  const library: LibrarySound[] = exists ? [{id: LEGACY_SOUND_ID, name: "Saját hang 1", durationSec}] : [];
  await store.set("settings", withKnownSounds(normalizeSettings(await store.get("settings")), library));
  await store.delete("customSound");
  await store.set("soundLibrary", library);
  await store.save();
  logInfo(`sounds migrated to the library (${exists ? "custom sound kept as \"Saját hang 1\"" : "no custom sound"})`);
};
