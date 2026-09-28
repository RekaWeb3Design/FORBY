// Voice, text side: one speech segment to a command. The Rust side only transcribes; this decides.
// No language detection (it costs ~0.8 s on every segment, and most segments are not meant for FORBY):
// Round 1: the fast model as English. No wake phrase -> done. The rest resolves (English preferred) -> that command.
// Otherwise (also after a bare wake phrase) round 2 with the more accurate model as Hungarian on the same audio,
// resolved with Hungarian preferred.
// Pure apart from the injected transcribe; nothing here logs a transcript.
import {resolve, type Resolved} from "./commands";
import type {Lang} from "./strings";
import {matchWake} from "./wake";

// How one Whisper round runs. noFallback is whisper-cli -nf.
export type Round = {model: string; lang: Lang | "auto"; noFallback: boolean};

// -nf in round 1 only: measured on 19 recordings (2 runs), it cut the time spent on speech not meant for FORBY by
// ~28% with no wake or command lost; in round 2 it gained nothing measurable
export const ROUND1: Round = {model: "base-q5_1", lang: "en", noFallback: true};
export const ROUND2: Round = {model: "small-q5_1", lang: "hu", noFallback: false};

// lang: the given one, or with "auto" Whisper's code of the detected language (the chain does not use "auto")
export type Transcript = {text: string; lang: string};
// The same audio each time; only the round settings change
export type Transcribe = (round: Round) => Promise<Transcript>;

// blank: nothing but silence / non-speech markers; no-wake: not addressed to FORBY; wake-only: just "Hey Forby";
// not-understood: addressed, but no command matched in either round
export type Outcome = "blank" | "no-wake" | "wake-only" | "command" | "not-understood";

export type Heard = {
  outcome: Outcome;
  round1: string;
  round2?: string;
  wake: boolean;
  // The text after the wake phrase in the round that was used last
  rest: string;
  // Set only for "command"; its lang is the language of the reply
  resolved: Resolved | null;
};

// Whisper's non-speech markers ("[BLANK_AUDIO]", "[MUSIC]", "(wind blowing)") removed
export const stripMarkers = (text: string): string => text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

export const understand = async (transcribe: Transcribe): Promise<Heard> => {
  const round1 = stripMarkers((await transcribe(ROUND1)).text);
  const none = {round1, wake: false, rest: "", resolved: null};
  if (!round1) return {...none, outcome: "blank"};
  const wake = matchWake(round1);
  if (!wake.matched) return {...none, outcome: "no-wake"};
  const english = wake.rest ? resolve(wake.rest, "en") : null;
  if (english) return {...none, wake: true, rest: wake.rest, resolved: english, outcome: "command"};

  // Also after a bare "Hey Forby": as English, Whisper tends to drop a Hungarian command after the name
  const round2 = stripMarkers((await transcribe(ROUND2)).text);
  // Round 1 already heard the wake phrase; if round 2 spells it differently, its whole text is the command
  const again = matchWake(round2);
  const rest = again.matched ? again.rest : round2;
  const hungarian = rest ? resolve(rest, "hu") : null;
  // Nothing found after a bare wake phrase stays wake-only (it will open the listening window)
  const outcome = hungarian ? "command" : wake.rest ? "not-understood" : "wake-only";
  return {round1, round2, wake: true, rest, resolved: hungarian, outcome};
};
