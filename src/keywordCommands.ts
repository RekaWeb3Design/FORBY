// Keyword fallback for the voice chain, after the regexes found nothing: a short rest (1–3 words) naming one
// parameterless command, the way Whisper actually hears it ("fejeszbe", "Paws!"). Pure, no React.
// Only ever called on the text after a wake phrase or inside the listening window that a wake phrase opened.
import {getCommands, type Resolved} from "./commands";
import type {Lang} from "./strings";

export const MAX_WORDS = 3;

type Keywords = {lang: Lang | "any"; exact?: string[]; stems?: string[]};

// Compared without case and accents. exact: the whole word; stems: the start of a word.
// "stop" is exact only, so "stopper" (the stopwatch) never counts as pause.
export const KEYWORDS: Record<string, Keywords[]> = {
  resume: [
    {lang: "en", stems: ["continu", "resum"]},
    {lang: "hu", stems: ["folyt", "tovabb"]},
  ],
  finish: [
    {lang: "en", exact: ["end"], stems: ["finish"]},
    {lang: "hu", stems: ["fejez", "fejes", "befejez"]},
  ],
  pause: [
    {lang: "en", exact: ["stop", "paws"], stems: ["paus"]},
    {lang: "hu", exact: ["allj", "pozt"], stems: ["szunet"]},
  ],
  dismiss: [
    {lang: "any", exact: ["ok"]},
    {lang: "en", exact: ["okay"], stems: ["dismiss"]},
    {lang: "hu", exact: ["oke", "eleg"], stems: ["rendben"]},
  ],
};

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

// roundLang: the language of the reply when the keyword is in both languages ("ok")
export const keywordCommand = (rest: string, roundLang: Lang): Resolved | null => {
  const words = fold(rest).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0 || words.length > MAX_WORDS) return null;
  const hits = new Map<string, Lang>();
  for (const [id, groups] of Object.entries(KEYWORDS)) {
    for (const g of groups) {
      if (words.some((w) => g.exact?.includes(w) || g.stems?.some((s) => w.startsWith(s)))) {
        if (!hits.has(id)) hits.set(id, g.lang === "any" ? roundLang : g.lang);
      }
    }
  }
  // Two different commands named: ambiguous, better nothing
  if (hits.size !== 1) return null;
  const [[id, lang]] = [...hits];
  const command = getCommands().find((c) => c.id === id);
  return command ? {command, params: {}, lang} : null;
};
