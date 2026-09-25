// Number words to digits (1–99), English and Hungarian at once, on already normalized text.
// Whole words only; a hyphenated word is converted only if every part is a number word or "minute(s)".
// Known collisions: "hat" is 6 in Hungarian and a noun in English, "hét" is 7 and also "week"; no command uses either as a word.

type NumberWord = {value: number; kind: "unit" | "teen" | "tens" | "prefix"; lang: "en" | "hu"};

const table = (lang: NumberWord["lang"], kind: NumberWord["kind"], words: Record<string, number>) =>
  Object.entries(words).map(([word, value]): [string, NumberWord] => [word, {value, kind, lang}]);

const HU_UNITS: Record<string, number> = {egy: 1, kettő: 2, két: 2, három: 3, négy: 4, öt: 5, hat: 6, hét: 7, nyolc: 8, kilenc: 9};
// Prefixes of one-word compounds; tizen- and huszon- never stand alone
const HU_PREFIXES: Record<string, number> = {tizen: 10, huszon: 20, harminc: 30, negyven: 40, ötven: 50, hatvan: 60, hetven: 70, nyolcvan: 80, kilencven: 90};

const WORDS = new Map<string, NumberWord>([
  ...table("en", "unit", {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9}),
  ...table("en", "teen", {
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  }),
  ...table("en", "tens", {twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90}),
  ...table("hu", "unit", HU_UNITS),
  ...table("hu", "teen", {tíz: 10}),
  ...table("hu", "tens", {húsz: 20, harminc: 30, negyven: 40, ötven: 50, hatvan: 60, hetven: 70, nyolcvan: 80, kilencven: 90}),
  // Whisper may split them: "huszon öt"
  ...table("hu", "prefix", {tizen: 10, huszon: 20}),
]);

// Hungarian compounds written as one word: "huszonöt", "harmincöt", "tizenkilenc"
const huCompound = (word: string): NumberWord | undefined => {
  for (const [prefix, tens] of Object.entries(HU_PREFIXES)) {
    const unit = word.startsWith(prefix) ? HU_UNITS[word.slice(prefix.length)] : undefined;
    if (unit !== undefined) return {value: tens + unit, kind: "teen", lang: "hu"};
  }
  return undefined;
};

const lookup = (word: string | undefined) => (word === undefined ? undefined : WORDS.get(word) ?? huCompound(word));

// Tens followed by a unit of the same language make one number ("twenty five", "harminc öt")
const convert = (words: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const n = lookup(word);
    if (!n) {
      out.push(word);
      continue;
    }
    const next = lookup(words[i + 1]);
    if ((n.kind === "tens" || n.kind === "prefix") && next?.kind === "unit" && next.lang === n.lang) {
      out.push(String(n.value + next.value));
      i++;
      continue;
    }
    // "egy" is an article unless a minute word follows (perc, perces, percre, ...)
    const article = word === "egy" && !words[i + 1]?.startsWith("perc");
    out.push(n.kind === "prefix" || article ? word : String(n.value));
  }
  return out;
};

const HYPHEN_PART = /^minutes?$/;

export const wordsToDigits = (text: string): string =>
  convert(text.split(" "))
    .map((word) => {
      if (!word.includes("-")) return word;
      // "twenty-five", "fifteen-minute", "twenty-five-minute"; "one-way" stays as it is
      const parts = word.split("-");
      if (!parts.every((p) => lookup(p) || HYPHEN_PART.test(p)) || !parts.some((p) => lookup(p))) return word;
      return convert(parts).join("-");
    })
    .join(" ");
