// Text commands: a registry of patterns per language and a resolver that maps typed text to one of them. Pure, no React.
import type {FobyState, Intent} from "./foby";
import {LANGS, type Lang} from "./strings";

// lang is the language the pattern matched in; the reply is written in it
export type CommandContext = {lang: Lang; getState: () => FobyState; runIntent: (intent: Intent) => boolean};
export type CommandResult = {ok: boolean; reply: string};

export type Command = {
  id: string;
  patterns: Record<Lang, RegExp[]>;
  // params come from the named groups as raw strings; converting them is up to the command
  execute: (params: Record<string, string>, ctx: CommandContext) => CommandResult;
};

export type Resolved = {command: Command; params: Record<string, string>; lang: Lang};

const commands: Command[] = [];

export const registerCommand = (cmd: Command): void => {
  if (commands.some((c) => c.id === cmd.id)) throw new Error(`Duplicate command id: ${cmd.id}`);
  commands.push(cmd);
};

export const getCommands = (): readonly Command[] => commands;

// Lowercase, drop sentence punctuation (. ! ? , before a space or the end, so "2.5" stays), collapse spaces.
// Accents stay. Later: number words ("five", "húsz") become digits here.
export const normalize = (text: string): string =>
  text.toLowerCase().replace(/[.!?,]+(?=\s|$)/g, "").replace(/\s+/g, " ").trim();

// preferLang first, then the rest in LANGS order; without it, plain LANGS order
const langOrder = (preferLang?: Lang): Lang[] => {
  const ids = LANGS.map((l) => l.id);
  return preferLang ? [preferLang, ...ids.filter((id) => id !== preferLang)] : ids;
};

// First match wins: commands in registration order, languages in langOrder
export const resolve = (text: string, preferLang?: Lang): Resolved | null => {
  const input = normalize(text);
  const langs = langOrder(preferLang);
  for (const command of commands) {
    for (const lang of langs) {
      for (const re of command.patterns[lang]) {
        const match = input.match(re);
        if (!match) continue;
        const params: Record<string, string> = {};
        for (const [key, value] of Object.entries(match.groups ?? {})) {
          if (value !== undefined) params[key] = value;
        }
        return {command, params, lang};
      }
    }
  }
  return null;
};

export const runCommand = (
  text: string,
  deps: {getState: () => FobyState; runIntent: (intent: Intent) => boolean},
  preferLang?: Lang,
): CommandResult | null => {
  const found = resolve(text, preferLang);
  if (!found) return null;
  return found.command.execute(found.params, {lang: found.lang, ...deps});
};
