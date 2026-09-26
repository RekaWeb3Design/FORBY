// npm run fetch-whisper [-- --force]
// Downloads the official whisper.cpp Windows x64 build (pinned URL and sha256), and puts only what whisper-cli needs
// into src-tauri/binaries (git-ignored): whisper-cli-<target triple>.exe as the Tauri sidecar, its DLLs (bundled as
// resources next to FORBY.exe) and the whisper.cpp MIT license. Skips the download if the same build is already there.
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

// whisper.cpp v1.9.4 (release build b5130 of the same code)
const BUILD = "b5130";
const ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD}/whisper-bin-x64.zip`;
const ZIP_BYTES = 8_573_270;
const ZIP_SHA256 = "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c";
const LICENSE_URL = `https://raw.githubusercontent.com/ggml-org/whisper.cpp/${BUILD}/LICENSE`;
const LICENSE_SHA256 = "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d";

const TRIPLE = "x86_64-pc-windows-msvc";
const CLI = "whisper-cli.exe";
// Imported by whisper-cli.exe (whisper, ggml) and ggml (ggml-base); ggml-base loads the best-fitting
// ggml-cpu-*.dll for the processor at run time from the folder of the exe
const DLLS = [
  "whisper.dll",
  "ggml.dll",
  "ggml-base.dll",
  ...["x64", "sse42", "sandybridge", "haswell", "skylakex", "icelake", "alderlake", "cannonlake", "cascadelake"]
    .map((cpu) => `ggml-cpu-${cpu}.dll`),
];
const LICENSE_FILE = "whisper.cpp-LICENSE.txt";
// Records which build the folder holds
const STAMP = ".whisper-build";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "binaries");
const outputs = [`whisper-cli-${TRIPLE}.exe`, ...DLLS, LICENSE_FILE, STAMP];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(url, expectedSha, expectedBytes) {
  const res = await fetch(url, {redirect: "follow"});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new Error(`${url}: ${buf.length} bytes, expected ${expectedBytes}`);
  }
  const actual = sha256(buf);
  if (actual !== expectedSha) throw new Error(`${url}: sha256 ${actual}, expected ${expectedSha}`);
  return buf;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("the pinned whisper.cpp build is for Windows x64 only");
  }
  const force = process.argv.includes("--force");
  const stampPath = path.join(OUT, STAMP);
  const current = fs.existsSync(stampPath) && fs.readFileSync(stampPath, "utf8").trim() === ZIP_SHA256;
  if (!force && current && outputs.every((f) => fs.existsSync(path.join(OUT, f)))) {
    console.log(`whisper.cpp ${BUILD} is already in ${OUT} (use --force to fetch again)`);
    return;
  }

  console.log(`downloading ${ZIP_URL}`);
  const zip = await download(ZIP_URL, ZIP_SHA256, ZIP_BYTES);
  const license = await download(LICENSE_URL, LICENSE_SHA256);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forby-whisper-"));
  try {
    const zipPath = path.join(tmp, "whisper-bin-x64.zip");
    fs.writeFileSync(zipPath, zip);
    // The bsdtar that ships with Windows 10+ reads zip files; only the needed members are extracted
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const members = [CLI, ...DLLS].map((f) => `Release/${f}`);
    execFileSync(tar, ["-xf", zipPath, "-C", tmp, ...members], {stdio: "inherit"});

    fs.rmSync(OUT, {recursive: true, force: true});
    fs.mkdirSync(OUT, {recursive: true});
    fs.copyFileSync(path.join(tmp, "Release", CLI), path.join(OUT, `whisper-cli-${TRIPLE}.exe`));
    for (const dll of DLLS) fs.copyFileSync(path.join(tmp, "Release", dll), path.join(OUT, dll));
    fs.writeFileSync(path.join(OUT, LICENSE_FILE), license);
    fs.writeFileSync(stampPath, `${ZIP_SHA256}\n`);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
  console.log(`whisper.cpp ${BUILD}: ${outputs.length - 1} files in ${OUT}`);
}

main().catch((err) => {
  console.error(`fetch-whisper: ${err.message}`);
  process.exit(1);
});
