// Live mode commands (release builds too): transcribe a buffered segment by its id, and release it.
// whisper-cli needs a file (with stdin input this build prints no transcript), so the segment is written to
// <app local data>/voice-tmp/<id>.wav only for the run and deleted right after, on errors and timeouts too.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::buffer::SegmentBuffer;
use super::transcribe::{ErrorKind, Lang, TranscribeError, Transcriber, Transcription, WhisperCli};
use super::wav::wav_bytes;
use crate::{models, LOG_TARGET};

const TMP_DIR: &str = "voice-tmp";

// The segment buffer, shared by the capture thread (push) and the commands
#[derive(Default)]
pub struct Segments(pub Mutex<SegmentBuffer>);

impl Segments {
    pub fn push(&self, samples: Vec<f32>) -> u64 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(samples)
    }

    fn get(&self, id: u64) -> Result<Arc<Vec<f32>>, TranscribeError> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .ok_or_else(|| TranscribeError::new(ErrorKind::InvalidInput, format!("unknown segment id {id}")))
    }
}

#[derive(Serialize)]
pub struct LiveTranscript {
    text: String,
    lang: String,
    ms: u64,
}

// One round on a buffered segment: model ("base-q5_1", ...), lang ("en" / "hu" / "auto"), noFallback (whisper-cli -nf)
#[tauri::command]
pub async fn voice_transcribe(
    app: AppHandle,
    id: u64,
    model: String,
    lang: String,
    no_fallback: Option<bool>,
) -> Result<LiveTranscript, TranscribeError> {
    let no_fallback = no_fallback.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || transcribe(&app, id, &model, &lang, no_fallback))
        .await
        .map_err(|e| TranscribeError::new(ErrorKind::Failed, e.to_string()))?
}

// Drops the segment; true if it was still in the buffer
#[tauri::command]
pub fn voice_release(app: AppHandle, id: u64) -> bool {
    app.state::<Segments>().0.lock().unwrap_or_else(|e| e.into_inner()).release(id)
}

fn transcribe(app: &AppHandle, id: u64, model: &str, lang: &str, no_fallback: bool) -> Result<LiveTranscript, TranscribeError> {
    let invalid = |message: String| TranscribeError::new(ErrorKind::InvalidInput, message);
    let lang = Lang::parse(lang)?;
    let samples = app.state::<Segments>().get(id)?;
    let model_path = models::installed_path(app, model)
        .map_err(invalid)?
        .ok_or_else(|| TranscribeError::new(ErrorKind::ModelMissing, format!("model {model} is not downloaded")))?;
    let cli = WhisperCli::new(WhisperCli::sidecar_path()?, model_path).no_fallback(no_fallback);
    let dir = tmp_dir(app).map_err(|e| TranscribeError::new(ErrorKind::Failed, e))?;
    let started = Instant::now();
    let result = transcribe_samples(&cli, &dir, id, &samples, lang);
    let ms = started.elapsed().as_millis() as u64;
    match &result {
        Ok(t) => log::info!(target: LOG_TARGET, "voice: segment {id} transcribed with {model} in {ms} ms ({})", t.lang),
        Err(e) => log::warn!(target: LOG_TARGET, "voice: segment {id} transcription failed after {ms} ms ({:?})", e.kind),
    }
    result.map(|t| LiveTranscript { text: t.text, lang: t.lang, ms })
}

// Writes the samples as <dir>/<id>.wav for the transcriber; the file is gone when this returns, whatever the outcome
fn transcribe_samples(t: &impl Transcriber, dir: &Path, id: u64, samples: &[f32], lang: Lang) -> Result<Transcription, TranscribeError> {
    let wav = TempWav::write(dir, id, samples).map_err(|e| TranscribeError::new(ErrorKind::Failed, format!("writing the audio failed: {e}")))?;
    t.transcribe(wav.path(), lang)
}

// Deletes its file when dropped (also when the write itself failed halfway)
struct TempWav(PathBuf);

impl TempWav {
    fn write(dir: &Path, id: u64, samples: &[f32]) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let wav = TempWav(dir.join(format!("{id}.wav")));
        std::fs::write(&wav.0, wav_bytes(samples))?;
        Ok(wav)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn tmp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join(TMP_DIR))
}

// At startup: leftovers of a crash
pub fn clear_tmp(app: &AppHandle) {
    let result = tmp_dir(app).and_then(|dir| match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    });
    if let Err(e) = result {
        log::warn!(target: LOG_TARGET, "voice: clearing voice-tmp failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // Answers with the given result and records whether the WAV existed during the call
    struct Fake {
        result: Result<Transcription, TranscribeError>,
        saw_file: Cell<bool>,
    }

    impl Transcriber for Fake {
        fn transcribe(&self, wav: &Path, _lang: Lang) -> Result<Transcription, TranscribeError> {
            self.saw_file.set(std::fs::metadata(wav).is_ok_and(|m| m.len() == 44 + 2 * 160));
            self.result.clone()
        }
    }

    fn fake(result: Result<Transcription, TranscribeError>) -> Fake {
        Fake { result, saw_file: Cell::new(false) }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forby-live-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn assert_empty(dir: &Path) {
        assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0, "a temporary WAV was left behind");
    }

    #[test]
    fn temporary_wav_is_deleted_after_success() {
        let dir = temp_dir("ok");
        let t = fake(Ok(Transcription { text: "hi".into(), lang: "en".into() }));
        assert_eq!(transcribe_samples(&t, &dir, 7, &[0.0; 160], Lang::En).unwrap().text, "hi");
        assert!(t.saw_file.get());
        assert_empty(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn temporary_wav_is_deleted_after_errors_and_timeouts() {
        let dir = temp_dir("err");
        for kind in [ErrorKind::Timeout, ErrorKind::Failed, ErrorKind::ModelMissing] {
            let t = fake(Err(TranscribeError::new(kind, "x")));
            assert_eq!(transcribe_samples(&t, &dir, 8, &[0.0; 160], Lang::Hu).unwrap_err().kind, kind);
            assert!(t.saw_file.get());
            assert_empty(&dir);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // The real process path: whisper-cli is missing, so the transcriber fails after the WAV was written
    #[test]
    fn temporary_wav_is_deleted_when_whisper_cli_is_missing() {
        let dir = temp_dir("cli");
        std::fs::create_dir_all(&dir).unwrap();
        let cli = WhisperCli::new(dir.join("missing.exe"), dir.join("missing.bin"));
        let err = transcribe_samples(&cli, &dir.join("tmp"), 9, &[0.0; 160], Lang::En).unwrap_err();
        assert_eq!(err.kind, ErrorKind::BinaryMissing);
        assert_empty(&dir.join("tmp"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // The real whisper-cli through the live path (samples -> temporary WAV -> transcript -> WAV deleted), on a debug WAV:
    // $env:FORBY_LIVE_WAV = "<a segment-….wav from voice-debug>"; cargo test voice::live::tests::live_path_with_whisper_cli -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_path_with_whisper_cli() {
        let wav = std::fs::read(std::env::var("FORBY_LIVE_WAV").expect("set FORBY_LIVE_WAV")).unwrap();
        // voice-debug files have the 44-byte header written by wav_bytes
        let samples: Vec<f32> = wav[44..].as_chunks::<2>().0.iter().map(|b| f32::from(i16::from_le_bytes(*b)) / 32767.0).collect();
        let exe = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join("whisper-cli-x86_64-pc-windows-msvc.exe");
        let model = PathBuf::from(std::env::var("APPDATA").unwrap()).join(r"studio.wow.forby\models\ggml-base-q5_1.bin");
        let cli = WhisperCli::new(exe, model).no_fallback(true);
        let dir = temp_dir("real");
        let started = Instant::now();
        let t = transcribe_samples(&cli, &dir, 1, &samples, Lang::En).unwrap();
        println!("{} ms: {}", started.elapsed().as_millis(), t.text);
        assert!(!t.text.is_empty());
        assert_empty(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unknown_ids_are_rejected() {
        let segments = Segments::default();
        let id = segments.push(vec![0.0; 10]);
        assert!(segments.get(id).is_ok());
        assert_eq!(segments.get(id + 1).unwrap_err().kind, ErrorKind::InvalidInput);
        assert!(segments.0.lock().unwrap().release(id));
        assert_eq!(segments.get(id).unwrap_err().kind, ErrorKind::InvalidInput);
    }
}
