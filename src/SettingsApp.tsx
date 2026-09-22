import {useCallback, useEffect, useRef, useState, type ReactNode} from "react";
import {emitTo} from "@tauri-apps/api/event";
import {availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition} from "@tauri-apps/api/window";
import {nearestAreaIndex, workAreaOf} from "./bounds";
import {logError} from "./log";
import {
  COLOR_PRESETS,
  DEFAULT_SETTINGS,
  POMODORO_BREAK,
  POMODORO_FOCUS,
  SOUNDS,
  type Settings,
  type SoundId,
} from "./prefs";
import {CUSTOM_EXTS, CUSTOM_MAX_BYTES, CUSTOM_MAX_SEC, decodeSound, playSound} from "./sounds";
import {
  ALARM_TEST_EVENT,
  CUSTOM_SOUND_EVENT,
  loadCustomSound,
  readCustomSoundInfo,
  readSettings,
  saveCustomSound,
  SETTINGS_CLOSED_EVENT,
  SETTINGS_EVENT,
  writeCustomSoundInfo,
  writeSettings,
  type AlarmTest,
  type CustomSoundInfo,
} from "./store";
import "./Settings.css";

const MAIN_LABEL = "main";
const PANEL_GAP = 12; // logical px between the ring and the panel
const BLUR_GRACE_MS = 150; // focus may come back right away (e.g. a native dialog closing)
const RECORD_MAX_SEC = 5;
const RECORD_MIME = "audio/webm;codecs=opus";

type Tab = "look" | "alerts";

// Dev only: fire each signal in the main window right away; the jump waits 3 s so the cursor can move away
const ALARM_TESTS: {id: AlarmTest; label: string}[] = [
  {id: "flash", label: "Villogás"},
  {id: "toast", label: "Értesítés"},
  {id: "jump", label: "Odaugrás"},
];
const sendTest = (test: AlarmTest) => {
  emitTo(MAIN_LABEL, ALARM_TEST_EVENT, test).catch((err) => logError("sending the alarm test failed", err));
};

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
    logError("placing the settings window failed", err);
  } finally {
    await win.show().catch((err) => logError("showing settings failed", err));
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
  const pickerOpenRef = useRef(false); // a native dialog (colour, file, microphone) is open: focus loss must not close
  const [customInfo, setCustomInfo] = useState<CustomSoundInfo | null>(null);
  const [soundError, setSoundError] = useState<string | null>(null);
  const [recordLeft, setRecordLeft] = useState<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    readSettings()
      .catch((err) => {
        logError("loading settings failed", err);
        return DEFAULT_SETTINGS;
      })
      .then(setSettings);
    readCustomSoundInfo()
      .then(setCustomInfo)
      .catch((err) => logError("loading custom sound info failed", err));
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
    recorderRef.current?.stop();
    await emitTo(MAIN_LABEL, SETTINGS_CLOSED_EVENT, null).catch(() => {});
    await getCurrentWindow().close().catch((err) => logError("closing settings failed", err));
  }, []);

  // Close on Esc and when focus goes elsewhere (clicking beside the panel), but not while a native dialog is open
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
      .catch((err) => logError("focus listener failed", err));
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
    emitTo(MAIN_LABEL, SETTINGS_EVENT, next).catch((err) => logError("sending settings failed", err));
  };

  const customColor = !COLOR_PRESETS.includes(settings.color);

  // Preview the selected sound with the set volume
  const preview = async () => {
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      const ctx = audioRef.current;
      await ctx.resume();
      const bytes = settings.sound === "custom" ? await loadCustomSound() : null;
      const custom = bytes && bytes.byteLength ? await decodeSound(bytes) : null;
      playSound(ctx, settings.sound, settings.volume, custom);
    } catch (err) {
      logError("preview failed", err);
      setSoundError("A hang nem játszható le");
    }
  };

  // Checks and saves a recorded or uploaded sound, then selects it
  const acceptSound = async (bytes: ArrayBuffer, ext: string, name: string) => {
    if (bytes.byteLength > CUSTOM_MAX_BYTES) return setSoundError("A fájl nagyobb 5 MB-nál");
    let buffer: AudioBuffer;
    try {
      buffer = await decodeSound(bytes);
    } catch {
      return setSoundError("Ez a fájl nem lejátszható hang");
    }
    if (buffer.duration > CUSTOM_MAX_SEC + 0.05) return setSoundError(`A hang hosszabb ${CUSTOM_MAX_SEC} mp-nél`);
    try {
      await saveCustomSound(bytes, ext);
    } catch (err) {
      logError("saving the custom sound failed", err);
      return setSoundError("A mentés nem sikerült");
    }
    const info = {name, durationSec: Math.round(buffer.duration * 10) / 10};
    writeCustomSoundInfo(info);
    setCustomInfo(info);
    setSoundError(null);
    emitTo(MAIN_LABEL, CUSTOM_SOUND_EVENT, null).catch((err) => logError("sending sound change failed", err));
    update({sound: "custom"});
  };

  // Microphone recording, max RECORD_MAX_SEC; pressing again stops early
  const record = async () => {
    if (recorderRef.current) {
      recorderRef.current.stop();
      return;
    }
    let stream: MediaStream;
    try {
      pickerOpenRef.current = true;
      stream = await navigator.mediaDevices.getUserMedia({audio: true});
    } catch (err) {
      logError("microphone access failed", err);
      return setSoundError("Nincs hozzáférés a mikrofonhoz");
    } finally {
      pickerOpenRef.current = false;
    }
    const mimeType = MediaRecorder.isTypeSupported(RECORD_MIME) ? RECORD_MIME : "audio/webm";
    const recorder = new MediaRecorder(stream, {mimeType});
    const chunks: Blob[] = [];
    let left = RECORD_MAX_SEC;
    const countdown = window.setInterval(() => setRecordLeft(--left), 1000);
    const limit = window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, RECORD_MAX_SEC * 1000);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      clearInterval(countdown);
      clearTimeout(limit);
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setRecordLeft(null);
      if (closingRef.current) return;
      new Blob(chunks, {type: mimeType}).arrayBuffer()
        .then((bytes) => acceptSound(bytes, "webm", "Felvétel"))
        .catch((err) => logError("reading the recording failed", err));
    };
    recorderRef.current = recorder;
    setSoundError(null);
    setRecordLeft(left);
    recorder.start();
  };

  const upload = () => {
    pickerOpenRef.current = true;
    fileRef.current?.click();
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!CUSTOM_EXTS.includes(ext)) return setSoundError(`Nem támogatott fájltípus (${CUSTOM_EXTS.join(", ")})`);
    await acceptSound(await file.arrayBuffer(), ext, file.name);
  };

  const customStatus = soundError
    ?? (customInfo ? `${customInfo.name}, ${customInfo.durationSec.toLocaleString("hu-HU")} mp` : "Még nincs saját hang");

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
              <button className="icon-btn" aria-label="Lejátszás" title="Előhallgatás" disabled={!settings.soundOn} onClick={() => void preview()}>▶</button>
            </div>
          </Row>
          <Slider label="Hangerő" unit="%" min={0} max={100} step={5} value={Math.round(settings.volume * 100)} onChange={(v) => update({volume: v / 100})} />
          <div className="field">
            <span className="row-label">Saját hang</span>
            <div className="buttons">
              <button className={`btn${recordLeft !== null ? " recording" : ""}`} onClick={() => void record()}>
                {recordLeft !== null ? `Leállítás (${recordLeft})` : `Felvétel (max ${RECORD_MAX_SEC} mp)`}
              </button>
              <button className="btn" disabled={recordLeft !== null} onClick={upload}>Fájl feltöltése</button>
              <input
                ref={fileRef}
                type="file"
                accept={CUSTOM_EXTS.map((e) => `.${e}`).join(",")}
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  void onFile(file);
                }}
              />
            </div>
            <span className={`status${soundError ? " error" : ""}`} title={customStatus}>{customStatus}</span>
          </div>
          <SwitchRow label="Tálca-villogás" checked={settings.flashTaskbar} onChange={(v) => update({flashTaskbar: v})} />
          <SwitchRow label="Windows értesítés" checked={settings.notification} onChange={(v) => update({notification: v})} />
          <SwitchRow label="Odaugrik a kurzorhoz" checked={settings.jumpToCursor} onChange={(v) => update({jumpToCursor: v})} />
          {import.meta.env.DEV && (
            <div className="field">
              <span className="row-label">Teszt (csak fejlesztői módban)</span>
              <div className="buttons">
                {ALARM_TESTS.map(({id, label}) => <button key={id} className="btn" onClick={() => sendTest(id)}>{label}</button>)}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
