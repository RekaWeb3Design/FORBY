// Voice, text side: one speech segment to a command. The Rust side only transcribes; this decides.
// No language detection (it costs ~0.8 s on every segment, and most segments are not meant for FORBY):
// Round 1: the fast model as English. No wake phrase -> done. The rest resolves (English preferred) -> that command.
// Otherwise (also after a bare wake phrase) round 2 with the more accurate model as Hungarian on the same audio,
// resolved with Hungarian preferred.
// In both rounds the rest (cut at a repeated wake phrase) goes to the regexes first, then, if it is 1–3 words, to the
// keyword match (keywordCommands.ts). Both only ever see text after a wake phrase or inside the listening window.
// Pure apart from the injected transcribe; nothing here logs a transcript.
import {resolve, type Resolved} from "./commands";
import {keywordCommand} from "./keywordCommands";
import type {Lang} from "./strings";
import {cutAtRepeatedWake, matchWake} from "./wake";

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

// The command in a rest: the regexes first, then the keywords on a short rest
const find = (rest: string, lang: Lang): Resolved | null => (rest ? resolve(rest, lang) ?? keywordCommand(rest, lang) : null);

// The source of the audio is up to transcribe (a debug WAV name or a live segment id).
// needWake: false inside the listening window after a bare "Hey Forby": the segment counts as a command without the
// wake phrase (a repeated wake phrase is still cut off). Without a wake phrase and outside the window nothing is
// matched at all: no-wake returns before any regex or keyword runs.
export const understand = async (transcribe: Transcribe, {needWake = true} = {}): Promise<Heard> => {
  const round1 = stripMarkers((await transcribe(ROUND1)).text);
  const none = {round1, wake: false, rest: "", resolved: null};
  if (!round1) return {...none, outcome: "blank"};
  const wake = matchWake(round1);
  if (!wake.matched && needWake) return {...none, outcome: "no-wake"};
  const rest1 = cutAtRepeatedWake(wake.matched ? wake.rest : round1);
  const english = find(rest1, "en");
  if (english) return {...none, wake: wake.matched, rest: rest1, resolved: english, outcome: "command"};

  // Also after a bare "Hey Forby": as English, Whisper tends to drop a Hungarian command after the name
  const round2 = stripMarkers((await transcribe(ROUND2)).text);
  // Round 1 already heard the wake phrase; if round 2 spells it differently, its whole text is the command
  const again = matchWake(round2);
  const rest = cutAtRepeatedWake(again.matched ? again.rest : round2);
  const hungarian = find(rest, "hu");
  // Nothing found after a bare wake phrase stays wake-only (it opens the listening window)
  const outcome = hungarian ? "command" : rest1 ? "not-understood" : "wake-only";
  return {round1, round2, wake: wake.matched, rest, resolved: hungarian, outcome};
};
