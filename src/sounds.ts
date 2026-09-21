// Alarm sounds: synthesised with Web Audio (prototype recipes) or the saved custom sound.
import type {SoundId} from "./prefs";

export const CUSTOM_MAX_SEC = 10;
export const CUSTOM_MAX_BYTES = 5 * 1024 * 1024;
export const CUSTOM_EXTS = ["webm", "ogg", "mp3", "wav", "m4a"];

const RESUME_TIMEOUT_MS = 1000;
const DECODE_RATE = 44100;

type Tone = {freq: number; type?: OscillatorType; at: number; attack?: number; decay: number; gain: number};

// One enveloped oscillator: quick attack, exponential decay
const tone = (ctx: BaseAudioContext, out: AudioNode, t0: number, {freq, type = "sine", at, attack = 0.005, decay, gain}: Tone) => {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const start = t0 + at;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  osc.connect(env).connect(out);
  osc.start(start);
  osc.stop(start + attack + decay + 0.05);
};

const RECIPES: Record<Exclude<SoundId, "custom">, Tone[]> = {
  // Csengő: 880/660/880/1320 Hz with an octave overtone
  chime: [880, 660, 880, 1320].flatMap((freq, i): Tone[] => [
    {freq, at: i * 0.2, decay: 0.55, gain: 0.32},
    {freq: freq * 2, at: i * 0.2, decay: 0.3, gain: 0.08},
  ]),
  // Harang: 523 and 659 Hz strikes with inharmonic partials
  bell: [523, 659].flatMap((base, i): Tone[] =>
    [[1, 0.3, 2.4], [2.76, 0.12, 1.4], [5.4, 0.06, 0.8], [8.93, 0.03, 0.5]].map(([ratio, gain, decay]) => ({
      freq: base * ratio, at: i * 0.45, decay, gain,
    }))),
  // Pittyegés: 3 × 1200 Hz square
  beep: [0, 1, 2].map((i): Tone => ({freq: 1200, type: "square", at: i * 0.22, decay: 0.12, gain: 0.1})),
  // Gong: 110/220/331 Hz, soft attack, long tail
  gong: [[110, 0.35, 3.6], [220, 0.18, 2.6], [331, 0.1, 1.8]].map(([freq, gain, decay]): Tone => ({
    freq, at: 0, attack: 0.03, decay, gain,
  })),
};

// Plays a sound at volume 0..1. Returns immediately; the audio is scheduled on the context.
export const playSound = (ctx: AudioContext, id: SoundId, volume: number, custom: AudioBuffer | null) => {
  const out = ctx.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume));
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  if (id === "custom" && custom) {
    const src = ctx.createBufferSource();
    src.buffer = custom;
    src.connect(out);
    src.start(t0, 0, CUSTOM_MAX_SEC);
    return;
  }
  // "custom" without a saved file falls back to the chime
  RECIPES[id === "custom" ? "chime" : id].forEach((t) => tone(ctx, out, t0, t));
};

// Decodes audio bytes; throws if the data is not playable
export const decodeSound = (bytes: ArrayBuffer) =>
  new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(bytes.slice(0));

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

// Keeps one AudioContext running. If it cannot be resumed (device change, sleep), it is replaced.
export const createAudio = () => {
  let ctx: AudioContext | null = null;

  const make = () => {
    const c = new AudioContext();
    c.addEventListener("statechange", () => console.info(`FORBY: audio ${c.state}`));
    return c;
  };

  const resume = async (c: AudioContext) => {
    if (c.state === "running") return true;
    try {
      await withTimeout(c.resume(), RESUME_TIMEOUT_MS);
    } catch {
      // handled by the state check below
    }
    return (c.state as AudioContextState) === "running";
  };

  return {
    // Running context for playback (recreated if it stays suspended)
    get: async () => {
      if (!ctx || ctx.state === "closed") ctx = make();
      if (await resume(ctx)) return ctx;
      console.warn("FORBY: audio context stuck, recreating it");
      ctx.close().catch(() => {});
      ctx = make();
      await resume(ctx);
      return ctx;
    },
    // Call from a user gesture: guarantees the context may run even without the autoplay flag
    unlock: () => {
      if (!ctx || ctx.state === "closed") ctx = make();
      ctx.resume().catch(() => {});
    },
  };
};
