// npm run test:voice
// Runs the voice chain (src/voicePipeline.ts, up to resolving the command) on every WAV in src-tauri/testdata/voice
// and compares it with expected.json there. The folder is git-ignored: it holds real voice recordings.
// whisper-cli runs with the arguments of src-tauri/src/voice/transcribe.rs (prompt, audio context, threads are read
// from that file), the models from the app data folder. Needs npm run fetch-whisper and both models downloaded.
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {registerBuiltinCommands} from "../src/builtinCommands.ts";
import {understand} from "../src/voicePipeline.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "src-tauri", "testdata", "voice");
const EXE = path.join(ROOT, "src-tauri", "binaries", "whisper-cli-x86_64-pc-windows-msvc.exe");
const MODELS = path.join(process.env.APPDATA ?? "", "studio.wow.forby", "models");

const rust = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "voice", "transcribe.rs"), "utf8");
const constant = (name) => {
  const m = new RegExp(`const ${name}: [^=]+= ([^;]+);`).exec(rust);
  if (!m) throw new Error(`${name} not found in transcribe.rs`);
  return m[1].trim();
};
const PROMPT = JSON.parse(constant("PROMPT"));
const AUDIO_CTX = constant("AUDIO_CTX");
const THREADS = String(Math.min(Number(constant("MAX_THREADS")), os.availableParallelism()));

const transcriber = (wav) => async ({model, lang, noFallback}) => {
  const args = ["-m", path.join(MODELS, `ggml-${model}.bin`), "-f", wav, "-l", lang, "--prompt", PROMPT,
    "-ac", AUDIO_CTX, "-t", THREADS, "-nt", ...(noFallback ? ["-nf"] : [])];
  const r = spawnSync(EXE, args, {encoding: "utf8", windowsHide: true, timeout: 15_000});
  if (r.status !== 0) throw new Error(`whisper-cli failed on ${path.basename(wav)} (exit ${r.status})`);
  return {text: r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" "), lang};
};

const commandText = (c) => (c ? `${c.id} ${JSON.stringify(c.params)}` : "—");
const cell = (s) => (s ?? "").replaceAll("|", "\\|");

registerBuiltinCommands();
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".wav")).sort();
const rows = [];
const uncertain = [];
let ok = 0;
let ms = 0;
for (const file of files) {
  const want = expected[file];
  const started = performance.now();
  const heard = await understand(transcriber(path.join(DIR, file)));
  ms += performance.now() - started;
  const got = heard.resolved ? {id: heard.resolved.command.id, params: heard.resolved.params} : null;
  const outcomes = want ? [want.outcome].flat() : [];
  const same = want && outcomes.includes(heard.outcome) &&
    commandText(got) === commandText(heard.outcome === "command" ? want.command : null);
  // Sentence not identified for sure: shown, not counted
  if (want?.uncertain) uncertain.push(`${file}: ${heard.outcome} ${got ? commandText(got) : ""} (${want.note ?? ""})`);
  else if (same) ok++;
  else rows.push(`| ${file} | ${cell(want?.note ?? "not in expected.json")} | ${outcomes.join(" / ") || "?"} ${want?.command ? commandText(want.command) : ""} | ${heard.outcome} ${got ? commandText(got) : ""} | ${cell(heard.round1)} | ${cell(heard.round2)} |`);
  process.stderr.write(`${want?.uncertain ? "?   " : same ? "ok  " : "DIFF"} ${file}\n`);
}
const missing = Object.keys(expected).filter((f) => !f.startsWith("_") && !files.includes(f));

console.log(`prompt ${JSON.stringify(PROMPT)}, -ac ${AUDIO_CTX}, -t ${THREADS}`);
if (rows.length) {
  console.log("\n| fájl | mondat | várt | kapott | 1. kör | 2. kör |\n|---|---|---|---|---|---|");
  console.log(rows.join("\n"));
}
if (missing.length) console.log(`\nIn expected.json but missing: ${missing.join(", ")}`);
if (uncertain.length) console.log(`\nUncertain (not counted):\n  ${uncertain.join("\n  ")}`);
console.log(`\n${ok}/${files.length - uncertain.length} as expected, ${rows.length} different, ${uncertain.length} uncertain, ${(ms / 1000).toFixed(1)} s`);
process.exit(rows.length || missing.length ? 1 : 0);
