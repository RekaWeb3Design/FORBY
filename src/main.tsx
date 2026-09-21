import React from "react";
import ReactDOM from "react-dom/client";
import {availableMonitors, getCurrentWindow, PhysicalPosition, primaryMonitor} from "@tauri-apps/api/window";
import {containsPoint, workAreaOf} from "./bounds";
import {CONTENT_BOTTOM, CONTENT_RIGHT, DEFAULT_MARGIN, ORB_CX, ORB_CY} from "./layout";
import {DEFAULT_DURATION_MIN, DEFAULT_SETTINGS} from "./prefs";
import {readLastDuration, readPosition, readSettings, type Position} from "./store";

// Upper bound for restoring at startup; after this FORBY shows up with defaults anyway
const RESTORE_TIMEOUT_MS = 3000;

const withTimeout = <T,>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);

const render = (node: React.ReactNode) =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode>{node}</React.StrictMode>);

// Bottom right of the primary monitor's work area, the visible content kept DEFAULT_MARGIN from the edges
const placeDefault = async () => {
  const mon = (await primaryMonitor()) ?? (await availableMonitors())[0];
  if (!mon) return;
  const a = workAreaOf(mon);
  const s = mon.scaleFactor;
  const x = a.right - (DEFAULT_MARGIN + CONTENT_RIGHT) * s;
  const y = a.bottom - (DEFAULT_MARGIN + CONTENT_BOTTOM) * s;
  await getCurrentWindow().setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
};

// The saved position is used only if the orb centre lands in a monitor's work area
const placeSaved = async (pos: Position | null) => {
  if (pos) {
    const visible = (await availableMonitors()).some((m) =>
      containsPoint(workAreaOf(m), pos.x + ORB_CX * m.scaleFactor, pos.y + ORB_CY * m.scaleFactor));
    if (visible) {
      await getCurrentWindow().setPosition(new PhysicalPosition(pos.x, pos.y));
      return;
    }
  }
  await placeDefault();
};

// Main window: starts hidden, restores settings and position, then always shows up
const bootMain = async () => {
  const win = getCurrentWindow();
  const appModule = import("./App");
  let settings = DEFAULT_SETTINGS;
  let durationMin = DEFAULT_DURATION_MIN;
  try {
    const [saved, lastDuration, pos] = await withTimeout(
      Promise.all([readSettings(), readLastDuration(), readPosition()]),
      RESTORE_TIMEOUT_MS,
    );
    settings = saved;
    durationMin = lastDuration ?? DEFAULT_DURATION_MIN;
    await withTimeout(placeSaved(pos), RESTORE_TIMEOUT_MS);
  } catch (err) {
    console.error("FORBY: restoring settings or position failed, using defaults", err);
    settings = DEFAULT_SETTINGS;
    durationMin = DEFAULT_DURATION_MIN;
    try {
      await withTimeout(placeDefault(), RESTORE_TIMEOUT_MS);
    } catch (placeErr) {
      console.error("FORBY: default placement failed", placeErr);
    }
  } finally {
    win.show().catch((err) => console.error("FORBY: showing the window failed", err));
    const {default: App} = await appModule;
    render(<App initialSettings={settings} initialDurationMin={durationMin} />);
  }
};

const bootSettings = async () => {
  const {default: SettingsApp} = await import("./SettingsApp");
  render(<SettingsApp />);
};

// Each window imports only its own component (and stylesheet)
if (new URLSearchParams(window.location.search).get("window") === "settings") void bootSettings();
else void bootMain();
