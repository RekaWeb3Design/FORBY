import {useEffect, useState} from "react";
import Face, {type FaceState} from "./Face";
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

function App() {
  const [state, setState] = useState<FaceState>("idle");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = DEV_KEYS[e.key];
      if (next) setState(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="shell">
      <div className="orb" data-tauri-drag-region>
        <Face state={state} />
      </div>
    </main>
  );
}

export default App;
