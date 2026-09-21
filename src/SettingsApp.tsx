import {useCallback, useEffect, useRef, useState, type ReactNode} from "react";
import {emitTo} from "@tauri-apps/api/event";
import {availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition} from "@tauri-apps/api/window";
import {nearestAreaIndex, workAreaOf} from "./bounds";
import {
  COLOR_PRESETS,
  DEFAULT_SETTINGS,
  POMODORO_BREAK,
  POMODORO_FOCUS,
  SOUNDS,
  type Settings,
  type SoundId,
} from "./prefs";
import {readSettings, SETTINGS_CLOSED_EVENT, SETTINGS_EVENT, writeSettings} from "./store";
import "./Settings.css";

const MAIN_LABEL = "main";
const PANEL_GAP = 12; // logical px between the ring and the panel
const BLUR_GRACE_MS = 150; // focus may come back right away (e.g. a native dialog closing)
const PHASE5_HINT = "Az 5. fázisban lesz elérhető";

type Tab = "look" | "alerts";

// Place the window next to FORBY's ring (right, or left if it does not fit), inside the work area, then show it
const placeAndShow = async (w: number, h: number) => {
  const win = getCurrentWindow();
  try {
    const q = new URLSearchParams(window.location.search);
    const cx = Number(q.get("cx"));
    const cy = Number(q.get("cy"));
    const r = Number(q.get("r"));
    const monitors = await availableMonitors();
    const areas = monitors.map(workAreaOf);
    const i = [cx, cy, r].every(Number.isFinite) ? nearestAreaIndex(areas, cx, cy) : -1;
    if (i >= 0) {
      const a = areas[i];
      const s = monitors[i].scaleFactor;
      const pw = w * s;
      const ph = h * s;
      const gap = PANEL_GAP * s;
      let x = cx + r + gap;
      if (x + pw > a.right) x = cx - r - gap - pw;
      x = Math.min(Math.max(x, a.left), a.right - pw);
      const y = Math.min(Math.max(cy - ph / 2, a.top), a.bottom - ph);
      await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
    }
    await win.setSize(new LogicalSize(w, h));
  } catch (err) {
    console.error("FORBY: placing the settings window failed", err);
  } finally {
    await win.show().catch((err) => console.error("FORBY: showing settings failed", err));
    await win.setFocus().catch(() => {});
  }
};

const Row = ({label, children}: {label: string; children: ReactNode}) => (
  <div className="row">
    <span className="row-label">{label}</span>
    {children}
  </div>
);

const Switch = ({checked, onChange, label}: {checked: boolean; onChange: (v: boolean) => void; label: string}) => (
  <input type="checkbox" className="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
);

const SwitchRow = ({label, checked, onChange}: {label: string; checked: boolean; onChange: (v: boolean) => void}) => (
  <label className="row">
    <span className="row-label">{label}</span>
    <Switch label={label} checked={checked} onChange={onChange} />
  </label>
);

type SliderProps = {label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void};
const Slider = ({label, value, min, max, step, unit, onChange}: SliderProps) => (
  <div className="field">
    <div className="field-head">
      <span className="row-label">{label}</span>
      <span className="field-value">{value} {unit}</span>
    </div>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </div>
);

export default function SettingsApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>("look");
  const panelRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);
  const closingRef = useRef(false);
  const pickerOpenRef = useRef(false);

  useEffect(() => {
    readSettings()
      .catch((err) => {
        console.error("FORBY: loading settings failed", err);
        return DEFAULT_SETTINGS;
      })
      .then(setSettings);
  }, []);

  // Once rendered, size the window to the panel (the taller tab sets the height) and show it
  useEffect(() => {
    const panel = panelRef.current;
    if (!settings || !panel || shownRef.current) return;
    shownRef.current = true;
    const rect = panel.getBoundingClientRect();
    void placeAndShow(Math.ceil(rect.width), Math.ceil(rect.height));
  }, [settings]);

  const close = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    await emitTo(MAIN_LABEL, SETTINGS_CLOSED_EVENT, null).catch(() => {});
    await getCurrentWindow().close().catch((err) => console.error("FORBY: closing settings failed", err));
  }, []);

  // Close on Esc and when focus goes elsewhere (clicking beside the panel), but not while a native picker is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void close();
    };
    window.addEventListener("keydown", onKey);
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    win.onFocusChanged(({payload: focused}) => {
      if (focused) {
        pickerOpenRef.current = false;
        return;
      }
      if (pickerOpenRef.current) return;
      window.setTimeout(() => {
        win.isFocused().then((f) => {
          if (!f && !pickerOpenRef.current) void close();
        }).catch(() => {});
      }, BLUR_GRACE_MS);
    })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch((err) => console.error("FORBY: focus listener failed", err));
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      unlisten?.();
    };
  }, [close]);

  if (!settings) return null;

  // Every change is saved and sent to the main window at once
  const update = (patch: Partial<Settings>) => {
    const next = {...settings, ...patch};
    setSettings(next);
    writeSettings(next);
    emitTo(MAIN_LABEL, SETTINGS_EVENT, next).catch((err) => console.error("FORBY: sending settings failed", err));
  };

  const customColor = !COLOR_PRESETS.includes(settings.color);

  return (
    <div className="panel" ref={panelRef}>
      <div className="head">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "look"} className="tab" onClick={() => setTab("look")}>Megjelenés és időzítés</button>
          <button role="tab" aria-selected={tab === "alerts"} className="tab" onClick={() => setTab("alerts")}>Riasztások</button>
        </div>
        <button className="close" aria-label="Bezárás" onClick={() => void close()}>×</button>
      </div>

      <div className="pages">
        <section className={`page${tab === "look" ? "" : " inactive"}`} aria-hidden={tab !== "look"}>
          <div className="field">
            <span className="row-label">Gömb színe</span>
            <div className="swatches">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  className={`swatch${settings.color === c ? " selected" : ""}`}
                  style={{background: c}}
                  aria-label={c}
                  onClick={() => update({color: c})}
                />
              ))}
              <label className={`swatch custom${customColor ? " selected" : ""}`} style={customColor ? {background: settings.color} : undefined} title="Egyedi szín">
                <input
                  type="color"
                  aria-label="Egyedi szín"
                  value={settings.color.toLowerCase()}
                  onClick={() => {pickerOpenRef.current = true;}}
                  onChange={(e) => update({color: e.target.value.toUpperCase()})}
                />
              </label>
            </div>
          </div>
          <SwitchRow label="Olvasó animáció fókusz alatt" checked={settings.readingAnimation} onChange={(v) => update({readingAnimation: v})} />
          <Slider label="Pomodoro fókusz" unit="perc" {...POMODORO_FOCUS} value={settings.pomodoroFocusMin} onChange={(v) => update({pomodoroFocusMin: v})} />
          <Slider label="Pomodoro szünet" unit="perc" {...POMODORO_BREAK} value={settings.pomodoroBreakMin} onChange={(v) => update({pomodoroBreakMin: v})} />
          <SwitchRow label="Játék mód" checked={settings.playMode} onChange={(v) => update({playMode: v})} />
        </section>

        <section className={`page${tab === "alerts" ? "" : " inactive"}`} aria-hidden={tab !== "alerts"}>
          <Row label="Hang">
            <div className="sound">
              <Switch label="Hang" checked={settings.soundOn} onChange={(v) => update({soundOn: v})} />
              <select aria-label="Hang választása" value={settings.sound} disabled={!settings.soundOn} onChange={(e) => update({sound: e.target.value as SoundId})}>
                {SOUNDS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <button className="icon-btn" aria-label="Lejátszás" title={PHASE5_HINT} disabled>▶</button>
            </div>
          </Row>
          <Slider label="Hangerő" unit="%" min={0} max={100} step={5} value={Math.round(settings.volume * 100)} onChange={(v) => update({volume: v / 100})} />
          <div className="field">
            <span className="row-label">Saját hang</span>
            <div className="buttons">
              <button className="btn" title={PHASE5_HINT} disabled>Felvétel (max 5 mp)</button>
              <button className="btn" title={PHASE5_HINT} disabled>Fájl feltöltése</button>
            </div>
          </div>
          <SwitchRow label="Tálca-villogás" checked={settings.flashTaskbar} onChange={(v) => update({flashTaskbar: v})} />
          <SwitchRow label="Windows értesítés" checked={settings.notification} onChange={(v) => update({notification: v})} />
          <SwitchRow label="Odaugrik a kurzorhoz" checked={settings.jumpToCursor} onChange={(v) => update({jumpToCursor: v})} />
        </section>
      </div>
    </div>
  );
}
