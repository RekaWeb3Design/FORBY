import {useCallback, useEffect, useRef, useState, type ReactNode} from "react";
import {emitTo} from "@tauri-apps/api/event";
import {availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition} from "@tauri-apps/api/window";
import {nearestAreaIndex, workAreaOf} from "./bounds";
import {logError} from "./log";
import {
  ALARM_EVENTS,
  COLOR_PRESETS,
  customId,
  customRef,
  DEFAULT_SETTINGS,
  FALLBACK_SOUND,
  POMODORO_BREAK,
  POMODORO_FOCUS,
  SOUNDS,
  type AlarmEvent,
  type Settings,
  type SoundRef,
} from "./prefs";
import {CUSTOM_EXTS, CUSTOM_MAX_BYTES, CUSTOM_MAX_COUNT, CUSTOM_MAX_SEC, decodeSound, eventVolume, playSound} from "./sounds";
import {
  ALARM_TEST_EVENT,
  deleteSound,
  loadSound,
  readSettings,
  readSoundLibrary,
  saveSound,
  SETTINGS_CLOSED_EVENT,
  SETTINGS_EVENT,
  SOUND_LIBRARY_EVENT,
  SOUND_NAME_MAX,
  withKnownSounds,
  writeSettings,
  writeSoundLibrary,
  type AlarmTest,
  type LibrarySound,
} from "./store";
import "./Settings.css";

const MAIN_LABEL = "main";
const PANEL_GAP = 12; // logical px between the ring and the panel
const BLUR_GRACE_MS = 150; // focus may come back right away (e.g. a native dialog closing)
const RECORD_MAX_SEC = 5;
const RECORD_MIME = "audio/webm;codecs=opus";
const NEW_SOUND_NAME = "Saját hang"; // recordings are named "Saját hang N", the smallest free N

type Tab = "look" | "alerts";
type Status = {text: string; error: boolean};

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

const newSoundId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const cleanName = (name: string) => name.trim().slice(0, SOUND_NAME_MAX).trim();
const nextSoundName = (library: LibrarySound[]) => {
  let n = 1;
  while (library.some((s) => s.name === `${NEW_SOUND_NAME} ${n}`)) n++;
  return `${NEW_SOUND_NAME} ${n}`;
};
const soundLabel = (id: string) => SOUNDS.find((s) => s.id === id)?.label ?? id;

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

// Built-in sounds, then the library (grouped only when there is one)
const SoundOptions = ({library}: {library: LibrarySound[]}) => {
  const builtin = SOUNDS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>);
  if (!library.length) return <>{builtin}</>;
  return (
    <>
      <optgroup label="Beépített">{builtin}</optgroup>
      <optgroup label="Saját hangok">
        {library.map((s) => <option key={s.id} value={customRef(s.id)}>{s.name}</option>)}
      </optgroup>
    </>
  );
};

export default function SettingsApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [library, setLibrary] = useState<LibrarySound[]>([]);
  const [tab, setTab] = useState<Tab>("look");
  const [libraryOpen, setLibraryOpen] = useState(false); // the "Saját hangok" view over the alerts tab
  const panelRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);
  const closingRef = useRef(false);
  const pickerOpenRef = useRef(false); // a native dialog (colour, file, microphone) is open: focus loss must not close
  const [status, setStatus] = useState<Status | null>(null);
  const [recordLeft, setRecordLeft] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{id: string; draft: string} | null>(null);
  const renameDoneRef = useRef(false); // Enter or Esc ended the rename: the blur that follows must not save again
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const escRef = useRef<() => boolean>(() => false); // true if Esc was used up inside the panel
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<AudioContext | null>(null);
  // The recorder finishes after later renders: it calls the current acceptSound (with the current library)
  const acceptRef = useRef<(bytes: ArrayBuffer, ext: string, name: string | null) => Promise<void>>(async () => {});

  useEffect(() => {
    Promise.all([
      readSettings().catch((err) => {
        logError("loading settings failed", err);
        return DEFAULT_SETTINGS;
      }),
      readSoundLibrary().catch((err): LibrarySound[] => {
        logError("loading the sound library failed", err);
        return [];
      }),
    ]).then(([saved, lib]) => {
      setLibrary(lib);
      setSettings(withKnownSounds(saved, lib));
    });
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

  // Close on Esc (unless it was used up inside the panel) and when focus goes elsewhere (clicking beside
  // the panel), but not while a native dialog is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !escRef.current()) void close();
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

  const showLibrary = tab === "alerts" && libraryOpen;

  // Esc first cancels a pending delete, then leaves the library view; only then does it close the panel
  escRef.current = () => {
    if (confirmDelete !== null) {
      setConfirmDelete(null);
      return true;
    }
    if (showLibrary) {
      setLibraryOpen(false);
      return true;
    }
    return false;
  };

  if (!settings) return null;

  // Every change is saved and sent to the main window at once
  const update = (patch: Partial<Settings>) => {
    const next = {...settings, ...patch};
    setSettings(next);
    writeSettings(next);
    emitTo(MAIN_LABEL, SETTINGS_EVENT, next).catch((err) => logError("sending settings failed", err));
  };

  const updateLibrary = (next: LibrarySound[]) => {
    setLibrary(next);
    writeSoundLibrary(next);
    emitTo(MAIN_LABEL, SOUND_LIBRARY_EVENT, null).catch((err) => logError("sending the sound library change failed", err));
  };

  const setEventSound = (event: AlarmEvent, ref: SoundRef) => update({sounds: {...settings.sounds, [event]: ref}});

  const customColor = !COLOR_PRESETS.includes(settings.color);
  const libraryFull = library.length >= CUSTOM_MAX_COUNT;

  const switchTab = (next: Tab) => {
    setTab(next);
    setLibraryOpen(false);
    setConfirmDelete(null);
  };
  const openLibrary = () => {
    setStatus(null);
    setLibraryOpen(true);
  };
  const leaveLibrary = () => {
    setConfirmDelete(null);
    setLibraryOpen(false);
  };

  // Plays a sound at the set volume times `share`
  const preview = async (ref: SoundRef, share = 1) => {
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      const ctx = audioRef.current;
      await ctx.resume();
      const id = customId(ref);
      const bytes = id === null ? null : await loadSound(id);
      const custom = bytes && bytes.byteLength ? await decodeSound(bytes) : null;
      playSound(ctx, ref, settings.volume * share, custom);
    } catch (err) {
      logError("preview failed", err);
      setStatus({text: "A hang nem játszható le", error: true});
    }
  };

  // Checks a recorded or uploaded sound and adds it to the library; it is not assigned to any event
  // name null: "Saját hang N"
  const acceptSound = async (bytes: ArrayBuffer, ext: string, name: string | null) => {
    if (library.length >= CUSTOM_MAX_COUNT) return setStatus({text: `Legfeljebb ${CUSTOM_MAX_COUNT} saját hang lehet`, error: true});
    if (bytes.byteLength > CUSTOM_MAX_BYTES) return setStatus({text: "A fájl nagyobb 5 MB-nál", error: true});
    let buffer: AudioBuffer;
    try {
      buffer = await decodeSound(bytes);
    } catch {
      return setStatus({text: "Ez a fájl nem lejátszható hang", error: true});
    }
    if (buffer.duration > CUSTOM_MAX_SEC + 0.05) return setStatus({text: `A hang hosszabb ${CUSTOM_MAX_SEC} mp-nél`, error: true});
    const id = newSoundId();
    name ??= nextSoundName(library);
    try {
      await saveSound(id, bytes, ext);
    } catch (err) {
      logError("saving the custom sound failed", err);
      return setStatus({text: "A mentés nem sikerült", error: true});
    }
    updateLibrary([...library, {id, name, durationSec: Math.round(buffer.duration * 10) / 10}]);
    setStatus({text: `„${name}” bekerült a könyvtárba. Eseményhez a hangválasztókban rendelheted hozzá.`, error: false});
  };
  acceptRef.current = acceptSound;

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
      return setStatus({text: "Nincs hozzáférés a mikrofonhoz", error: true});
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
        .then((bytes) => acceptRef.current(bytes, "webm", null))
        .catch((err) => logError("reading the recording failed", err));
    };
    recorderRef.current = recorder;
    setStatus(null);
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
    if (!CUSTOM_EXTS.includes(ext)) return setStatus({text: `Nem támogatott fájltípus (${CUSTOM_EXTS.join(", ")})`, error: true});
    const name = cleanName(file.name.replace(/\.[^.]*$/, "")) || null;
    await acceptSound(await file.arrayBuffer(), ext, name);
  };

  const startRename = (sound: LibrarySound) => {
    renameDoneRef.current = false;
    setConfirmDelete(null);
    setRenaming({id: sound.id, draft: sound.name});
  };
  // An empty name keeps the old one
  const finishRename = (save: boolean) => {
    if (!renaming || renameDoneRef.current) return;
    renameDoneRef.current = true;
    const name = cleanName(renaming.draft);
    const old = library.find((s) => s.id === renaming.id);
    if (save && name && old && name !== old.name) {
      updateLibrary(library.map((s) => (s.id === renaming.id ? {...s, name} : s)));
    }
    setRenaming(null);
  };

  // Events that used the deleted sound switch to the fallback (chime)
  const remove = async (sound: LibrarySound) => {
    setConfirmDelete(null);
    try {
      await deleteSound(sound.id);
    } catch (err) {
      logError("deleting the custom sound failed", err);
      return setStatus({text: "A törlés nem sikerült", error: true});
    }
    const ref = customRef(sound.id);
    const used = ALARM_EVENTS.filter((e) => settings.sounds[e.id] === ref);
    if (used.length) {
      const sounds = {...settings.sounds};
      used.forEach((e) => {sounds[e.id] = FALLBACK_SOUND;});
      update({sounds});
    }
    updateLibrary(library.filter((s) => s.id !== sound.id));
    const switched = used.length ? ` ${used.map((e) => e.label).join(", ")}: ${soundLabel(FALLBACK_SOUND)} lett.` : "";
    setStatus({text: `„${sound.name}” törölve.${switched}`, error: false});
  };

  const libraryStatus: Status | null = status
    ?? (libraryFull ? {text: `Legfeljebb ${CUSTOM_MAX_COUNT} saját hang lehet, újhoz törölj egyet.`, error: false}
      : library.length ? null : {text: "Még nincs saját hang.", error: false});

  return (
    <div className="panel" ref={panelRef}>
      <div className="head">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "look"} className="tab" onClick={() => switchTab("look")}>Megjelenés és időzítés</button>
          <button role="tab" aria-selected={tab === "alerts"} className="tab" onClick={() => switchTab("alerts")}>Riasztások</button>
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
          <SwitchRow label="Indítás a géppel" checked={settings.autostart} onChange={(v) => update({autostart: v})} />
        </section>

        <section className={`page${tab === "alerts" && !showLibrary ? "" : " inactive"}`} aria-hidden={tab !== "alerts" || showLibrary}>
          <div className="field">
            <div className="field-head">
              <span className="row-label">Hang</span>
              <span className="sound-head">
                <span className="field-value">{Math.round(settings.volume * 100)} %</span>
                <Switch label="Hang" checked={settings.soundOn} onChange={(v) => update({soundOn: v})} />
              </span>
            </div>
            <input
              type="range"
              aria-label="Hangerő"
              min={0}
              max={100}
              step={5}
              value={Math.round(settings.volume * 100)}
              onChange={(e) => update({volume: Number(e.target.value) / 100})}
            />
          </div>
          <div className="events">
            {ALARM_EVENTS.map(({id, label}) => (
              <Row key={id} label={label}>
                <div className="sound">
                  <select
                    aria-label={`${label}: hang`}
                    value={settings.sounds[id]}
                    disabled={!settings.soundOn}
                    onChange={(e) => setEventSound(id, e.target.value as SoundRef)}
                  >
                    <SoundOptions library={library} />
                  </select>
                  <button
                    className="icon-btn"
                    aria-label={`${label}: előhallgatás`}
                    title="Előhallgatás"
                    disabled={!settings.soundOn}
                    onClick={() => void preview(settings.sounds[id], eventVolume(id))}
                  >▶</button>
                </div>
              </Row>
            ))}
          </div>
          <button className="row nav-row" onClick={openLibrary}>
            <span className="row-label">Saját hangok</span>
            <span className="field-value">{library.length} / {CUSTOM_MAX_COUNT} ›</span>
          </button>
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

        {/* Layered over the alerts page, so it never changes the measured panel height; its list scrolls instead.
            A pending delete stays until confirmed, Esc, or a click anywhere else in this view. */}
        {showLibrary && (
          <section
            className="library"
            aria-label="Saját hangok"
            onPointerDown={(e) => {
              if (confirmDelete !== null && !(e.target as Element).closest("[data-confirm]")) setConfirmDelete(null);
            }}
          >
            <div className="library-head">
              <button className="icon-btn back" aria-label="Vissza" title="Vissza" onClick={leaveLibrary}>‹</button>
              <span className="library-title">Saját hangok</span>
              <span className="field-value">{library.length} / {CUSTOM_MAX_COUNT}</span>
            </div>
            <ul className="library-list">
              {library.map((sound) => (
                <li key={sound.id} className="library-item">
                  {renaming?.id === sound.id ? (
                    <input
                      className="rename"
                      aria-label="Új név"
                      autoFocus
                      maxLength={SOUND_NAME_MAX}
                      value={renaming.draft}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setRenaming({id: sound.id, draft: e.target.value})}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") finishRename(true);
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          finishRename(false);
                        }
                      }}
                      onBlur={() => finishRename(true)}
                    />
                  ) : (
                    <button className="sound-name" title={`${sound.name} (átnevezés)`} onClick={() => startRename(sound)}>{sound.name}</button>
                  )}
                  <span className="field-value">{sound.durationSec.toLocaleString("hu-HU")} mp</span>
                  <button className="icon-btn" aria-label={`${sound.name}: előhallgatás`} title="Előhallgatás" onClick={() => void preview(customRef(sound.id))}>▶</button>
                  {confirmDelete === sound.id ? (
                    <button className="icon-btn confirm" data-confirm onClick={() => void remove(sound)}>Törlöd?</button>
                  ) : (
                    <button className="icon-btn remove" aria-label={`${sound.name}: törlés`} title="Törlés" onClick={() => setConfirmDelete(sound.id)}>×</button>
                  )}
                </li>
              ))}
            </ul>
            <div className="buttons">
              <button className={`btn${recordLeft !== null ? " recording" : ""}`} disabled={libraryFull && recordLeft === null} onClick={() => void record()}>
                {recordLeft !== null ? `Leállítás (${recordLeft})` : `Felvétel (max ${RECORD_MAX_SEC} mp)`}
              </button>
              <button className="btn" disabled={libraryFull || recordLeft !== null} onClick={upload}>Fájl feltöltése</button>
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
            <span className={`library-status${libraryStatus?.error ? " error" : ""}`} role="status">{libraryStatus?.text}</span>
          </section>
        )}
      </div>
    </div>
  );
}
