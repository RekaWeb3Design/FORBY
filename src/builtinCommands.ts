// The built-in text commands. Patterns run on normalize()d text: lowercase, no sentence punctuation.
// Rules: anchored with ^...$, no g or y flag (lastIndex state), numbers as \d+ in named groups.
import {registerCommand, type CommandContext, type CommandResult} from "./commands";
import type {Intent} from "./foby";
import {DURATION_MAX, DURATION_MIN} from "./format";
import {POMODORO_BREAK, POMODORO_FOCUS} from "./prefs";
import {strings, type Lang, type TextKey} from "./strings";
import {snapshot} from "./timer";

type Range = {min: number; max: number};

// Same check as canApply, so a rejected number gets its own reply instead of a state error
const inRange = (v: number, r: Range) => Number.isInteger(v) && v >= r.min && v <= r.max;
const optNumber = (raw: string | undefined) => (raw === undefined ? undefined : Number(raw));

const reply = (ok: boolean, text: string): CommandResult => ({ok, reply: text});

// Starting is refused while a session is on screen; the reply says what to do first
const startRefused = (ctx: CommandContext) => {
  const t = strings[ctx.lang];
  const ui = ctx.getState().ui;
  return reply(false, ui === "alarm" || ui === "summary" ? t.cmdDismissFirst : t.cmdBusy);
};

// Commands that only fire one intent: the reply is one of two fixed texts
const simple = (id: string, en: RegExp[], hu: RegExp[], intent: Intent, done: TextKey, refused: TextKey) =>
  registerCommand({
    id,
    patterns: {en, hu},
    execute: (_params, ctx) => {
      const t = strings[ctx.lang];
      return ctx.runIntent(intent) ? reply(true, t[done]) : reply(false, t[refused]);
    },
  });

// Minutes and seconds of a duration; remaining time rounds up, elapsed time down, like the display
const spoken = (ms: number, up: boolean, lang: Lang) => {
  const total = Math.max(0, up ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  return strings[lang].cmdDuration(Math.floor(total / 60), total % 60);
};

// Call once at startup, outside React: registering twice throws on the duplicate ids
export const registerBuiltinCommands = (): void => {
  registerCommand({
    id: "timer",
    patterns: {
      en: [
        /^set (?:a )?timer for (?<min>\d+) (?:minutes?|mins?)$/,
        /^timer (?:for )?(?<min>\d+) (?:minutes?|mins?)$/,
        /^(?:start|set) (?:a )?(?<min>\d+)[ -]minute timer$/,
      ],
      hu: [
        /^(?:állíts be|indíts) (?:egy )?(?<min>\d+) perces (?:időzítőt|timert)$/,
        /^(?:állíts be|indíts) (?:egy )?(?:időzítőt|timert) (?<min>\d+) percre$/,
        /^időzítő (?<min>\d+) perc(?:re)?$/,
      ],
    },
    execute: (params, ctx) => {
      const t = strings[ctx.lang];
      const minutes = Number(params.min);
      if (!inRange(minutes, {min: DURATION_MIN, max: DURATION_MAX})) return reply(false, t.cmdBadMinutes(DURATION_MIN, DURATION_MAX));
      return ctx.runIntent({type: "start", mode: "timer", minutes}) ? reply(true, t.cmdTimerStarted(minutes)) : startRefused(ctx);
    },
  });

  registerCommand({
    id: "pomodoro",
    patterns: {
      en: [
        /^(?:start|set) (?:a )?pomodoro$/,
        /^(?:(?:start|set) )?(?:a )?pomodoro (?:with )?(?<focus>\d+) minutes? (?:work|focus)(?: time)?(?: and)? (?<break>\d+) minutes? (?:break|pause)(?: time)?$/,
      ],
      hu: [
        /^indíts (?:egy )?pomodorót$/,
        /^pomodoro (?<focus>\d+) perc (?:munka|fókusz) (?<break>\d+) perc szünet$/,
        /^indíts (?:egy )?pomodorót (?<focus>\d+) perc (?:munkával|fókusszal) és (?<break>\d+) perc szünettel$/,
      ],
    },
    execute: (params, ctx) => {
      const t = strings[ctx.lang];
      const focusMin = optNumber(params.focus);
      const breakMin = optNumber(params.break);
      if (focusMin !== undefined && !inRange(focusMin, POMODORO_FOCUS)) return reply(false, t.cmdBadFocus(POMODORO_FOCUS.min, POMODORO_FOCUS.max));
      if (breakMin !== undefined && !inRange(breakMin, POMODORO_BREAK)) return reply(false, t.cmdBadBreak(POMODORO_BREAK.min, POMODORO_BREAK.max));
      // Missing lengths come from the settings, read before starting
      const settings = ctx.getState().pomodoro;
      if (!ctx.runIntent({type: "start", mode: "pomodoro", focusMin, breakMin})) return startRefused(ctx);
      return reply(true, t.cmdPomodoroStarted(focusMin ?? settings.focusMin, breakMin ?? settings.breakMin));
    },
  });

  registerCommand({
    id: "stopwatch",
    patterns: {
      en: [/^start (?:the )?stopwatch$/],
      hu: [/^indítsd (?:el )?a stoppert$/, /^stopper indul$/],
    },
    execute: (_params, ctx) =>
      ctx.runIntent({type: "start", mode: "stopwatch"}) ? reply(true, strings[ctx.lang].cmdStopwatchStarted) : startRefused(ctx),
  });

  simple("pause", [/^(?:pause|stop)$/], [/^(?:szünet|állj|állítsd meg)$/], {type: "pause"}, "cmdPaused", "cmdCantPause");
  simple("resume", [/^(?:resume|continue)$/], [/^(?:folytasd|tovább)$/], {type: "resume"}, "cmdResumed", "cmdCantResume");
  simple("finish", [/^(?:finish|end (?:the )?timer)$/], [/^(?:fejezd be|befejezés)$/], {type: "finish"}, "cmdFinished", "cmdCantFinish");
  simple("dismiss", [/^(?:ok|okay|dismiss|got it)$/], [/^(?:ok|oké|elég|rendben)$/], {type: "dismiss"}, "cmdDismissed", "cmdCantDismiss");

  // Read only. Uses the state's last tick, which is what the display shows
  registerCommand({
    id: "remaining",
    patterns: {
      en: [/^(?:how much time is left|time left)$/],
      hu: [/^mennyi idő van (?:még )?hátra$/, /^mennyi van még$/],
    },
    execute: (_params, ctx) => {
      const t = strings[ctx.lang];
      const state = ctx.getState();
      const s = state.session;
      if (state.ui === "alarm") return reply(true, t.cmdTimeUp);
      if (!s || (state.ui !== "run" && state.ui !== "paused")) return reply(true, t.cmdNoSession);
      const snap = snapshot(s, state.now);
      let text: string;
      if (s.mode === "timer") text = snap.remainingMs > 0 ? t.cmdLeft(spoken(snap.remainingMs, true, ctx.lang)) : t.cmdTimeUp;
      else if (s.mode === "pomodoro") {
        const left = spoken(snap.phaseRemainingMs, true, ctx.lang);
        text = snap.phase === "break" ? t.cmdBreakLeft(left) : t.cmdFocusLeft(left);
      } else text = t.cmdElapsed(spoken(snap.elapsedMs, false, ctx.lang));
      return reply(true, state.ui === "paused" ? `${text} ${t.cmdIsPaused}` : text);
    },
  });
};
