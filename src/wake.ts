// Wake phrase: a greeting and the name at the start of a transcript ("Hey Forby, ..."). Pure, no React.
// Compared on words without case, punctuation or accents, with the spaces between the first few words dropped, because
// Whisper splits and merges the name freely: "Hey 4 by", "Hei for bái", "Híforbáj" (greeting and name in one word).

// Spellings seen in the benchmark and in real recordings, accents removed ("hely", "heay": base-q5_1 on
// Hungarian "Hey Forby")
const GREETINGS = ["hey", "heay", "hay", "hei", "he", "hej", "hely", "hi", "hie", "hij", "hijj", "hig", "szia"];
const NAMES = [
  "forby", "forbi", "forbie", "forbee", "forbey", "forbye", "forbuy",
  "forbaj", "forbai", "forbay", "forbaly",
  "furby", "furbi", "furbaj", "farbal",
  "forb", "4by", "fourby",
];
const PHRASES = new Set(GREETINGS.flatMap((g) => NAMES.map((n) => g + n)));
// Greeting and name span at most this many words ("hay four by", "hei for bai")
const MAX_WORDS = 4;

export type Wake = {matched: boolean; rest: string};

const fold = (word: string) => word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

// The text up to a repeated wake phrase: Whisper sometimes writes the whole utterance twice
// ("fejezd be! Szia Forby, fejezd be!" -> "fejezd be")
export const cutAtRepeatedWake = (text: string): string => {
  for (const word of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (word.index > 0 && matchWake(text.slice(word.index)).matched) {
      return text.slice(0, word.index).replace(/[\s\p{P}]+$/u, "");
    }
  }
  return text;
};

// rest is the original text after the wake phrase, without the punctuation right after it; empty when only the wake
// phrase was said. Without a match, rest is the whole text.
export const matchWake = (text: string): Wake => {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  let joined = "";
  for (let i = 0; i < Math.min(words.length, MAX_WORDS); i++) {
    joined += fold(words[i][0]);
    if (PHRASES.has(joined)) {
      const end = words[i].index + words[i][0].length;
      return {matched: true, rest: text.slice(end).replace(/^[\s\p{P}]+/u, "").trim()};
    }
  }
  return {matched: false, rest: text.trim()};
};
