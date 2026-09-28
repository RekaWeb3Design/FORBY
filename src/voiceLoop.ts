// Live voice: microphone segments through the understanding chain, one chain at a time. Pure apart from the
// injected deps (transcribe/release call Rust, onHeard acts on the result).
// Queue: while a chain runs, at most one segment waits; a newer one replaces it (the older is dropped and released).
// The queue lives here, not in Rust, because only this side knows where a chain ends: its two rounds must not
// interleave with another segment's.
// Listening window: after a bare "Hey Forby", the next segment counts as a command without the wake phrase if it
// arrived before the window closed (LISTEN_MS after the wake-only result).
import {understand, type Heard, type Round, type Transcript} from "./voicePipeline";

export const LISTEN_MS = 5000;

// The voice-segment event
export type Segment = {id: number; ms: number; truncated: boolean};

export type Queue<T> = {push: (item: T) => void; clear: () => void; busy: () => boolean};

export const createLatestQueue = <T>(run: (item: T) => Promise<void>, dropped: (item: T) => void): Queue<T> => {
  let running = false;
  let waiting: {item: T} | null = null;
  const drain = async (first: T) => {
    running = true;
    let next: {item: T} | null = {item: first};
    while (next) {
      try {
        await run(next.item);
      } catch {
        // run reports its own errors; the queue keeps going
      }
      next = waiting;
      waiting = null;
    }
    running = false;
  };
  return {
    push: (item) => {
      if (!running) {
        void drain(item);
        return;
      }
      if (waiting) dropped(waiting.item);
      waiting = {item};
    },
    clear: () => {
      if (waiting) dropped(waiting.item);
      waiting = null;
    },
    busy: () => running,
  };
};

export type ListenWindow = {
  // After a wake-only result: segments that arrived after the wake-only one, until now + ms
  open: (wakeArrivedAt: number, now: number) => void;
  // Whether a segment that arrived at this time needs no wake phrase; an expired window closes
  covers: (arrivedAt: number) => boolean;
  close: () => void;
};

export const createListenWindow = (ms = LISTEN_MS): ListenWindow => {
  let win: {after: number; until: number} | null = null;
  return {
    open: (wakeArrivedAt, now) => {
      win = {after: wakeArrivedAt, until: now + ms};
    },
    covers: (arrivedAt) => {
      if (!win || arrivedAt <= win.after) return false;
      if (arrivedAt > win.until) {
        win = null;
        return false;
      }
      return true;
    },
    close: () => {
      win = null;
    },
  };
};

export type LoopDeps = {
  transcribe: (id: number, round: Round) => Promise<Transcript>;
  release: (id: number) => void;
  // Milliseconds, monotonic
  now: () => number;
  // Once per understood segment; followUp: inside the listening window (no wake phrase needed)
  onHeard: (heard: Heard, info: {id: number; followUp: boolean; ms: number}) => void;
  onError: (err: unknown, id: number) => void;
};

export type VoiceLoop = {push: (segment: Segment) => void; stop: () => void};

export const createVoiceLoop = (deps: LoopDeps, listen: ListenWindow = createListenWindow()): VoiceLoop => {
  let active = true;
  const queue = createLatestQueue<{segment: Segment; arrivedAt: number}>(
    async ({segment, arrivedAt}) => {
      try {
        if (!active) return;
        const started = deps.now();
        const followUp = listen.covers(arrivedAt);
        const heard = await understand((round) => deps.transcribe(segment.id, round), {needWake: !followUp});
        if (!active) return;
        // A cough or silence does not use up the window; anything else does
        if (followUp && heard.outcome !== "blank") listen.close();
        if (heard.outcome === "wake-only") listen.open(arrivedAt, deps.now());
        deps.onHeard(heard, {id: segment.id, followUp, ms: deps.now() - started});
      } catch (err) {
        if (active) deps.onError(err, segment.id);
      } finally {
        deps.release(segment.id);
      }
    },
    ({segment}) => deps.release(segment.id),
  );
  return {
    push: (segment) => {
      if (active) queue.push({segment, arrivedAt: deps.now()});
      else deps.release(segment.id);
    },
    // A running chain finishes without acting on its result
    stop: () => {
      active = false;
      queue.clear();
      listen.close();
    },
  };
};
