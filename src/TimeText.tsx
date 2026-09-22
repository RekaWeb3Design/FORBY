import {useEffect, useState, type KeyboardEvent} from "react";
import {parseDuration} from "./format";

type TimeTextProps = {
  big: string | null;
  alert: boolean;
  lines: string[];
  editable: boolean;
  durationMin: number;
  editRequest: number; // incremented to open the input from outside (the "Egyéni" chip)
  top: number; // window px
  onSubmit: (minutes: number) => void;
};

// Time and helper lines in a light pill below the orb. In pickDur the number opens a duration input.
export default function TimeText({big, alert, lines, editable, durationMin, editRequest, top, onSubmit}: TimeTextProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);

  const open = () => {
    if (!editable) return;
    setValue(String(durationMin));
    setError(false);
    setEditing(true);
  };

  // Opened from outside: the input mounts with autoFocus
  useEffect(() => {
    if (editRequest) open();
  }, [editRequest]);

  if (big === null && !lines.length) return null;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") setEditing(false);
    if (e.key !== "Enter") return;
    const minutes = parseDuration(value);
    if (minutes === null) {
      setError(true);
      return;
    }
    setEditing(false);
    onSubmit(minutes);
  };

  return (
    <div className="time" style={{top}} data-hit="">
      {editing ? (
        <input
          className={`time-input${error ? " error" : ""}`}
          value={value}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
          onKeyDown={onKey}
          onBlur={() => setEditing(false)}
        />
      ) : big !== null && (
        <div className={`time-big${alert ? " alert" : ""}${editable ? " editable" : ""}`} onClick={open}>
          {big}
        </div>
      )}
      {lines.map((line) => <div key={line} className="time-line">{line}</div>)}
    </div>
  );
}
