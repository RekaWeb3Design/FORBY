// Persistent storage (tauri-plugin-store, one file in the app data folder).
// Each key has a single writer: "settings" and "customSound" the settings window, the rest the main window.
import {invoke} from "@tauri-apps/api/core";
import {load, type Store} from "@tauri-apps/plugin-store";
import {DURATION_MAX, DURATION_MIN} from "./format";
import {normalizeSettings, type Settings} from "./prefs";

const STORE_FILE = "forby.json";
const AUTOSAVE_MS = 200;

// Events between the windows
export const SETTINGS_EVENT = "settings-changed";
export const SETTINGS_CLOSED_EVENT = "settings-closed";
export const CUSTOM_SOUND_EVENT = "custom-sound-changed";

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
    .catch((err) => console.error(`FORBY: saving "${key}" failed`, err));
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

// Custom sound: the file itself is kept by the Rust side (fixed path in the app data folder), its description here
export type CustomSoundInfo = {name: string; durationSec: number};

export const readCustomSoundInfo = async (): Promise<CustomSoundInfo | null> => {
  const v = await (await getStore()).get<CustomSoundInfo>("customSound");
  return v && typeof v.name === "string" && Number.isFinite(v.durationSec) ? v : null;
};
export const writeCustomSoundInfo = (info: CustomSoundInfo) => write("customSound", info);

export const saveCustomSound = (bytes: ArrayBuffer, ext: string) =>
  invoke("save_custom_sound", new Uint8Array(bytes), {headers: {"x-ext": ext}});

// Empty buffer when there is no saved sound
export const loadCustomSound = () => invoke<ArrayBuffer>("read_custom_sound");
