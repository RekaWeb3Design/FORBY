import {useCallback, useEffect, useRef, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {WebviewWindow} from "@tauri-apps/api/webviewWindow";
import {ORB_CX, ORB_CY, RING_OUTER} from "./layout";
import {normalizeSettings, type Settings} from "./prefs";
import {SETTINGS_CLOSED_EVENT, SETTINGS_EVENT} from "./store";

export const SETTINGS_LABEL = "settings";
// A click on the settings button right after the panel closed itself (focus loss) must not reopen it
const REOPEN_GUARD_MS = 500;

// Subscribe to an event sent to the main window; handles unlistening even if the effect ends first
const useWindowEvent = <T>(name: string, handler: (payload: T) => void) => {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    getCurrentWindow()
      .listen<T>(name, (e) => handlerRef.current(e.payload))
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch((err) => console.error(`FORBY: listening to ${name} failed`, err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [name]);
};

// Current settings in the main window; changes from the settings window arrive as events and apply at once
export const useSettings = (initial: Settings) => {
  const [settings, setSettings] = useState(initial);
  useWindowEvent<unknown>(SETTINGS_EVENT, (payload) => setSettings(normalizeSettings(payload)));
  return settings;
};

// Opens the settings window next to FORBY, or closes it if it is open
export const useSettingsToggle = () => {
  const closedAtRef = useRef(0);
  useWindowEvent<null>(SETTINGS_CLOSED_EVENT, () => {closedAtRef.current = Date.now();});

  return useCallback(async () => {
    try {
      const existing = await WebviewWindow.getByLabel(SETTINGS_LABEL);
      if (existing) {
        await existing.close();
        return;
      }
      if (Date.now() - closedAtRef.current < REOPEN_GUARD_MS) return;

      // The settings window places itself; it gets the orb centre and the ring radius in physical px
      const win = getCurrentWindow();
      const [pos, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
      const query = new URLSearchParams({
        window: SETTINGS_LABEL,
        cx: String(Math.round(pos.x + ORB_CX * scale)),
        cy: String(Math.round(pos.y + ORB_CY * scale)),
        r: String(Math.round(RING_OUTER * scale)),
      });
      const settingsWin = new WebviewWindow(SETTINGS_LABEL, {
        url: `index.html?${query}`,
        title: "FORBY – Beállítások",
        width: 300,
        height: 400,
        visible: false,
        decorations: false,
        transparent: true,
        shadow: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focus: true,
      });
      settingsWin.once("tauri://error", (e) => console.error("FORBY: opening settings failed", e.payload));
    } catch (err) {
      console.error("FORBY: toggling settings failed", err);
    }
  }, []);
};
