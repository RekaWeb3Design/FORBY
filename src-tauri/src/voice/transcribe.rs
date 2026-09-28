// Speech to text behind the Transcriber trait. WhisperCli runs whisper.cpp's whisper-cli (the Tauri sidecar next to
// FORBY.exe) once per WAV file: the transcript comes from its stdout, an auto-detected language from its stderr log.
// Started from Rust with std::process, so the frontend gets no shell/execute permission.
// Privacy: the transcript never reaches the log; callers log only durations.
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

pub const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_THREADS: usize = 8;
// Biases the decoder toward the wake phrases. "Forby" alone left "A4B" / "A for B" / "Cia forby" on real voices;
// "Hey Forby." alone made Whisper skip a spoken "Hey Forby" that matched it. Both greetings: every wake phrase of
// the 20 real recordings and the TTS clips heard, no false wake on the recordings without one.
const PROMPT: &str = "Hey Forby! Szia Forby!";
// Encoder context (1500 = 30 s); 512 covers ~10 s, enough for a command, and is several times faster
const AUDIO_CTX: u32 = 512;
// How often the running process is checked against the time limit
const POLL: Duration = Duration::from_millis(10);
// Longest stderr excerpt quoted in an error
const STDERR_EXCERPT: usize = 200;

#[cfg(windows)]
const EXE: &str = "whisper-cli.exe";
#[cfg(not(windows))]
const EXE: &str = "whisper-cli";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    // The Whisper model is not downloaded
    ModelMissing,
    // whisper-cli is not next to the app (not fetched / broken install)
    BinaryMissing,
    InvalidInput,
    Timeout,
    // whisper-cli failed to start or exited with an error
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct TranscribeError {
    pub kind: ErrorKind,
    pub message: String,
}

impl TranscribeError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

// The spoken language to assume, or Auto to let Whisper detect it
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Lang {
    En,
    Hu,
    Auto,
}

impl Lang {
    pub fn parse(code: &str) -> Result<Self, TranscribeError> {
        match code {
            "en" => Ok(Self::En),
            "hu" => Ok(Self::Hu),
            "auto" => Ok(Self::Auto),
            _ => Err(TranscribeError::new(ErrorKind::InvalidInput, format!("unsupported language: {code}"))),
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Hu => "hu",
            Self::Auto => "auto",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Transcription {
    // Trimmed; empty if nothing was recognised. May be a non-speech marker such as "[BLANK_AUDIO]".
    pub text: String,
    // The given language, or with Lang::Auto the detected Whisper code ("en", "hu", "de", ...)
    pub lang: String,
}

pub trait Transcriber {
    // A 16 kHz mono WAV file to text
    fn transcribe(&self, wav: &Path, lang: Lang) -> Result<Transcription, TranscribeError>;
}

pub struct WhisperCli {
    exe: PathBuf,
    model: PathBuf,
    threads: usize,
    timeout: Duration,
    // -nf: no temperature fallback. Much faster on speech the model cannot follow (it stops re-decoding),
    // at the price of a rougher text there. Set per round by the caller.
    no_fallback: bool,
}

impl WhisperCli {
    pub fn new(exe: PathBuf, model: PathBuf) -> Self {
        Self { exe, model, threads: default_threads(), timeout: TIMEOUT, no_fallback: false }
    }

    pub fn no_fallback(mut self, on: bool) -> Self {
        self.no_fallback = on;
        self
    }

    // Where Tauri puts the sidecar: next to the running executable (target/debug in dev, the install folder in a
    // release), without the target triple suffix
    pub fn sidecar_path() -> Result<PathBuf, TranscribeError> {
        let exe = std::env::current_exe().map_err(|e| TranscribeError::new(ErrorKind::BinaryMissing, e.to_string()))?;
        let dir = exe.parent().ok_or_else(|| TranscribeError::new(ErrorKind::BinaryMissing, "no executable folder"))?;
        Ok(dir.join(EXE))
    }

    fn args(&self, wav: &Path, lang: Lang) -> Vec<OsString> {
        let mut args: Vec<OsString> = Vec::new();
        args.extend(["-m".into(), self.model.clone().into_os_string()]);
        args.extend(["-f".into(), wav.to_path_buf().into_os_string()]);
        for (flag, value) in [
            ("-l", lang.code().to_owned()),
            ("--prompt", PROMPT.to_owned()),
            ("-ac", AUDIO_CTX.to_string()),
            ("-t", self.threads.to_string()),
        ] {
            args.extend([flag.into(), value.into()]);
        }
        // No timestamps. Not -np: it would also hide the "auto-detected language" log line. Logs go to stderr, so
        // stdout still holds only the transcript.
        args.push("-nt".into());
        if self.no_fallback {
            args.push("-nf".into());
        }
        args
    }
}

impl Transcriber for WhisperCli {
    fn transcribe(&self, wav: &Path, lang: Lang) -> Result<Transcription, TranscribeError> {
        if !self.exe.is_file() {
            return Err(TranscribeError::new(ErrorKind::BinaryMissing, "whisper-cli not found (run npm run fetch-whisper)"));
        }
        if !self.model.is_file() {
            return Err(TranscribeError::new(ErrorKind::ModelMissing, "the Whisper model is not downloaded"));
        }
        if !wav.is_file() {
            return Err(TranscribeError::new(ErrorKind::InvalidInput, "the audio file does not exist"));
        }
        let mut command = Command::new(&self.exe);
        command.args(self.args(wav, lang));
        let output = run(command, self.timeout)?;
        if !output.status.success() {
            let code = output.status.code().map_or_else(|| "none".to_owned(), |c| c.to_string());
            return Err(TranscribeError::new(
                ErrorKind::Failed,
                format!("whisper-cli exited with code {code}: {}", last_line(&output.stderr)),
            ));
        }
        let lang = match lang {
            Lang::Auto => detected_lang(&output.stderr)
                .ok_or_else(|| TranscribeError::new(ErrorKind::Failed, "whisper-cli did not report the detected language"))?,
            fixed => fixed.code().to_owned(),
        };
        Ok(Transcription { text: transcript(&output.stdout), lang })
    }
}

// From whisper.cpp's log line "whisper_full_with_state: auto-detected language: hu (p = 0.987100)"
fn detected_lang(stderr: &[u8]) -> Option<String> {
    const MARKER: &str = "auto-detected language: ";
    let text = String::from_utf8_lossy(stderr);
    let after = text.lines().find_map(|l| l.split_once(MARKER).map(|(_, rest)| rest))?;
    let code: String = after.chars().take_while(|c| c.is_ascii_lowercase()).collect();
    (2..=3).contains(&code.len()).then_some(code)
}

// Logical cores, at most MAX_THREADS (more threads stopped paying off in the benchmark)
fn default_threads() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get()).min(MAX_THREADS)
}

struct Output {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

// Runs without a console window, reading both pipes on their own threads (a full pipe would block the child);
// the process is killed once the time limit passes
fn run(mut command: Command, timeout: Duration) -> Result<Output, TranscribeError> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| TranscribeError::new(ErrorKind::Failed, format!("starting whisper-cli failed: {e}")))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    // On a timeout the readers are left to end on their own (a grandchild could keep the pipes open)
    let status = wait(&mut child, timeout)?;
    Ok(Output { status, stdout: join(stdout), stderr: join(stderr) })
}

fn wait(child: &mut Child, timeout: Duration) -> Result<ExitStatus, TranscribeError> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                kill(child);
                return Err(TranscribeError::new(
                    ErrorKind::Timeout,
                    format!("whisper-cli did not finish in {} s", timeout.as_secs_f32()),
                ));
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => {
                kill(child);
                return Err(TranscribeError::new(ErrorKind::Failed, e.to_string()));
            }
        }
    }
}

fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> Option<JoinHandle<Vec<u8>>> {
    pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    })
}

fn join(reader: Option<JoinHandle<Vec<u8>>>) -> Vec<u8> {
    reader.and_then(|r| r.join().ok()).unwrap_or_default()
}

// whisper-cli -nt prints one line per segment (with a leading space); the lines joined into one trimmed text
fn transcript(stdout: &[u8]) -> String {
    String::from_utf8_lossy(stdout).lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

// The last non-empty stderr line (whisper-cli's error message), shortened
fn last_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("no error output");
    line.chars().take(STDERR_EXCERPT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_is_the_trimmed_text() {
        assert_eq!(transcript(b"\n Hey Forby. Set a timer for 5 minutes.\n"), "Hey Forby. Set a timer for 5 minutes.");
        assert_eq!(transcript(" Híj, Forby,\r\n indíts egy 5 perces időzítőt.\r\n".as_bytes()), "Híj, Forby, indíts egy 5 perces időzítőt.");
        assert_eq!(transcript(b""), "");
        assert_eq!(transcript(b"\n  \r\n"), "");
    }

    #[test]
    fn last_stderr_line_is_quoted() {
        assert_eq!(last_line(b"loading\nerror: failed to read audio file\n\n"), "error: failed to read audio file");
        assert_eq!(last_line(b""), "no error output");
        assert_eq!(last_line("x".repeat(500).as_bytes()).len(), STDERR_EXCERPT);
    }

    #[test]
    fn arguments() {
        let cli = WhisperCli { exe: "w.exe".into(), model: "m.bin".into(), threads: 8, timeout: TIMEOUT, no_fallback: false };
        let args: Vec<String> = cli.args(Path::new("a.wav"), Lang::Hu).into_iter().map(|a| a.into_string().unwrap()).collect();
        assert_eq!(args, ["-m", "m.bin", "-f", "a.wav", "-l", "hu", "--prompt", "Hey Forby! Szia Forby!", "-ac", "512", "-t", "8", "-nt"]);
        let cli = cli.no_fallback(true);
        assert_eq!(cli.args(Path::new("a.wav"), Lang::En).last().unwrap(), "-nf");
        let auto = cli.args(Path::new("a.wav"), Lang::Auto);
        assert_eq!(auto[5], "auto");
    }

    #[test]
    fn detected_language_comes_from_the_log() {
        let log = b"read_audio_data: trying to decode with miniaudio\n\
            whisper_full_with_state: auto-detected language: hu (p = 0.263805)\n\
            whisper_print_timings:     load time =    92.05 ms\n";
        assert_eq!(detected_lang(log).as_deref(), Some("hu"));
        assert_eq!(detected_lang(b"whisper_full_with_state: auto-detected language: yue (p = 0.5)").as_deref(), Some("yue"));
        assert_eq!(detected_lang(b"whisper_print_timings: total time = 1 ms\n"), None);
        assert_eq!(detected_lang(b"auto-detected language: \n"), None);
        assert_eq!(detected_lang(b""), None);
    }

    #[test]
    fn threads_are_capped() {
        let n = default_threads();
        assert!((1..=MAX_THREADS).contains(&n), "{n}");
    }

    #[test]
    fn languages() {
        assert_eq!(Lang::parse("en").unwrap(), Lang::En);
        assert_eq!(Lang::parse("hu").unwrap(), Lang::Hu);
        assert_eq!(Lang::parse("auto").unwrap(), Lang::Auto);
        assert_eq!(Lang::parse("de").unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(Lang::parse("en -m x").unwrap_err().kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn missing_files_are_reported() {
        let dir = std::env::temp_dir().join(format!("forby-transcribe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("whisper-cli.exe");
        let model = dir.join("model.bin");
        let wav = dir.join("a.wav");
        let missing = |cli: &WhisperCli| cli.transcribe(&wav, Lang::En).unwrap_err().kind;
        assert_eq!(missing(&WhisperCli::new(exe.clone(), model.clone())), ErrorKind::BinaryMissing);
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(missing(&WhisperCli::new(exe.clone(), model.clone())), ErrorKind::ModelMissing);
        std::fs::write(&model, b"").unwrap();
        assert_eq!(missing(&WhisperCli::new(exe, model)), ErrorKind::InvalidInput);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn slow_process_is_killed() {
        let mut command = Command::new("ping");
        command.args(["-n", "30", "127.0.0.1"]);
        let started = Instant::now();
        let err = run(command, Duration::from_millis(300)).err().unwrap();
        assert_eq!(err.kind, ErrorKind::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    }

    #[cfg(windows)]
    #[test]
    fn output_and_exit_code_are_captured() {
        let mut command = Command::new("cmd");
        command.args(["/C", "echo  hello & echo oops 1>&2 & exit 3"]);
        let output = run(command, TIMEOUT).unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(transcript(&output.stdout), "hello");
        assert_eq!(last_line(&output.stderr), "oops");
    }

    // The real whisper-cli with language detection on the benchmark TTS clips (en_timer.wav, hu_timer.wav, ...):
    // $env:FORBY_WHISPER_CLIPS = "<folder of the clips>"; cargo test voice::transcribe::tests::transcribes_clips -- --ignored --nocapture
    // Needs npm run fetch-whisper and the base-q5_1 model (or FORBY_WHISPER_MODEL = "<path of a ggml model>").
    // Clips named en_* / hu_* must be detected as that language.
    #[test]
    #[ignore]
    fn transcribes_clips() {
        let clips = PathBuf::from(std::env::var("FORBY_WHISPER_CLIPS").expect("set FORBY_WHISPER_CLIPS"));
        let model = std::env::var("FORBY_WHISPER_MODEL").map(PathBuf::from).unwrap_or_else(|_| {
            PathBuf::from(std::env::var("APPDATA").unwrap()).join(r"studio.wow.forby\models\ggml-base-q5_1.bin")
        });
        let exe = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join("whisper-cli-x86_64-pc-windows-msvc.exe");
        let cli = WhisperCli::new(exe, model);
        let mut names: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        names.sort();
        for name in names {
            let name = name.to_string_lossy();
            let Some(stem) = name.strip_suffix(".wav") else { continue };
            let started = Instant::now();
            let Transcription { text, lang } = cli.transcribe(&clips.join(&*name), Lang::Auto).unwrap();
            println!("{name} [{lang}] {} ms: {text}", started.elapsed().as_millis());
            for prefix in ["en", "hu"] {
                if stem.starts_with(&format!("{prefix}_")) {
                    assert_eq!(lang, prefix, "{name}");
                }
            }
            match stem {
                "en_timer" | "en_timer_david" => assert!(text.to_lowercase().contains("timer"), "{text}"),
                // base-q5_1 tends to split "időzítőt" ("esi dözítőt"), so only the minutes are checked
                "hu_timer" => assert!(text.to_lowercase().contains("perc"), "{text}"),
                _ => {}
            }
        }
    }
}
