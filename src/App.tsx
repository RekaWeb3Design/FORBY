import {useCallback, useRef} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import Chips from "./Chips";
import Face from "./Face";
import TimeText from "./TimeText";
import {createMotion} from "./motion";
import {PLAY_MODE, READING_ANIMATION} from "./settings";
import {useDragFling} from "./useDragFling";
import {useFoby} from "./useFoby";
import "./App.css";

// Layout inside the 280×266 window (logical px)
const ORB_CX = 140;
const ORB_CY = 126;
const ORB_R = 55;
const CHIP_ARC_R = 108; // chip centres; keeps the widest chip row clear of the ring
const TIME_TOP = 197; // just below the ring

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
  const {state, view, orbClick, pickChip, wheel, submitDuration} = useFoby();
  const orbRef = useRef<HTMLDivElement>(null);
  const motion = useRef(createMotion());
  const activeRef = useDragFling(orbRef, motion, {playMode: PLAY_MODE, onClick: orbClick});
  const ignoreRef = useRef<boolean | null>(null);

  const onCursor = useCallback((x: number, y: number) => {
    const ignore = !activeRef.current && !isOverInteractive(x, y);
    if (ignore === ignoreRef.current) return;
    ignoreRef.current = ignore;
    getCurrentWindow().setIgnoreCursorEvents(ignore).catch((err) => {
      ignoreRef.current = null;
      console.error("FORBY: setIgnoreCursorEvents failed", err);
    });
  }, [activeRef]);

  return (
    <main className="shell">
      <Chips chips={view.chips} cx={ORB_CX} cy={ORB_CY} radius={CHIP_ARC_R} onPick={pickChip} />
      <div
        className="orb"
        ref={orbRef}
        data-hit="circle"
        style={{left: ORB_CX - ORB_R, top: ORB_CY - ORB_R, width: ORB_R * 2, height: ORB_R * 2}}
        onWheel={(e) => wheel(e.deltaY < 0 ? 1 : -1)}
      >
        <Face
          state={view.face}
          smile={view.smile}
          readingAnimation={READING_ANIMATION}
          motion={motion}
          onCursor={onCursor}
        />
      </div>
      <TimeText
        big={view.big}
        alert={view.alert}
        lines={view.lines}
        editable={view.editable}
        durationMin={state.durationMin}
        top={TIME_TOP}
        onSubmit={submitDuration}
      />
    </main>
  );
}

export default App;
