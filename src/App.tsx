import {useCallback, useEffect, useRef, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import Face, {type FaceState} from "./Face";
import {createMotion} from "./motion";
import {useDragFling} from "./useDragFling";
import "./App.css";

// Temporary: keys 1–6 switch face states until the timer logic drives them.
const DEV_KEYS: Record<string, FaceState> = {
  "1": "idle",
  "2": "focus",
  "3": "pause",
  "4": "break",
  "5": "alarm",
  "6": "overtime",
};

// Interactive elements are marked with data-hit ("circle" for round ones); everything else is click-through.
const isOverInteractive = (x: number, y: number) =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-hit]")).some((el) => {
    const r = el.getBoundingClientRect();
    if (el.dataset.hit === "circle") {
      return Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) <= r.width / 2;
    }
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });

function App() {
  const [state, setState] = useState<FaceState>("idle");
  const orbRef = useRef<HTMLDivElement>(null);
  const motion = useRef(createMotion());
  const activeRef = useDragFling(orbRef, motion);
  const ignoreRef = useRef<boolean | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = DEV_KEYS[e.key];
      if (next) setState(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onCursor = useCallback((x: number, y: number) => {
    const ignore = !activeRef.current && !isOverInteractive(x, y);
    if (ignore === ignoreRef.current) return;
    ignoreRef.current = ignore;
    getCurrentWindow().setIgnoreCursorEvents(ignore).catch((err) => {
      ignoreRef.current = null;
      console.error("FOBY: setIgnoreCursorEvents failed", err);
    });
  }, [activeRef]);

  return (
    <main className="shell">
      <div className="orb" ref={orbRef} data-hit="circle">
        <Face state={state} motion={motion} onCursor={onCursor} />
      </div>
    </main>
  );
}

export default App;
