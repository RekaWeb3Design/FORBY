// Dev builds only (the module is compiled out of release): each segment as a WAV in <app data>/voice-debug,
// keeping the newest KEEP files, plus commands to list and transcribe them. Paths and transcripts never go to the log.
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::segmenter::SAMPLE_RATE;
use super::transcribe::{ErrorKind, Lang, TranscribeError, Transcriber, WhisperCli};
use crate::{models, LOG_TARGET};

const DIR: &str = "voice-debug";
const KEEP: usize = 20;
const MAX_NAME: usize = 64;

#[derive(Serialize)]
pub struct DebugWav {
    name: String,
    bytes: u64,
    // Last modified, ms since the Unix epoch
    modified: u64,
}

#[derive(Serialize)]
pub struct Transcript {
    text: String,
    ms: u64,
}

fn debug_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(DIR))
}

// The WAVs in voice-debug, oldest first
#[tauri::command]
pub fn voice_list_debug(app: AppHandle) -> Result<Vec<DebugWav>, String> {
    list(&debug_dir(&app)?)
}

// One voice-debug WAV to text with the given model ("base-q5_1", ...) and language ("en" / "hu")
#[tauri::command]
pub async fn voice_transcribe_debug(app: AppHandle, file_name: String, model: String, lang: String) -> Result<Transcript, TranscribeError> {
    tauri::async_runtime::spawn_blocking(move || transcribe(&app, &file_name, &model, &lang))
        .await
        .map_err(|e| TranscribeError::new(ErrorKind::Failed, e.to_string()))?
}

fn transcribe(app: &AppHandle, file_name: &str, model: &str, lang: &str) -> Result<Transcript, TranscribeError> {
    let invalid = |message: String| TranscribeError::new(ErrorKind::InvalidInput, message);
    let lang = Lang::parse(lang)?;
    let wav = resolve(&debug_dir(app).map_err(invalid)?, file_name).map_err(invalid)?;
    let model_path = models::installed_path(app, model)
        .map_err(invalid)?
        .ok_or_else(|| TranscribeError::new(ErrorKind::ModelMissing, format!("model {model} is not downloaded")))?;
    let cli = WhisperCli::new(WhisperCli::sidecar_path()?, model_path);
    let started = Instant::now();
    let result = cli.transcribe(&wav, lang);
    let ms = started.elapsed().as_millis() as u64;
    match &result {
        Ok(_) => log::info!(target: LOG_TARGET, "voice: transcribed in {ms} ms"),
        Err(e) => log::warn!(target: LOG_TARGET, "voice: transcription failed after {ms} ms ({:?})", e.kind),
    }
    result.map(|text| Transcript { text, ms })
}

// A bare file name as save() makes them: letters, digits, '-', '_' and dots, ending in .wav; no path, no ".."
fn valid_name(name: &str) -> bool {
    name.len() <= MAX_NAME
        && name.len() > ".wav".len()
        && name.ends_with(".wav")
        && !name.starts_with('.')
        && !name.contains("..")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

// The file in dir; must be a regular file there (not a folder or a link)
fn resolve(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("invalid file name (expected a .wav name from voice-debug)".into());
    }
    let path = dir.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() => Ok(path),
        _ => Err("no such file in voice-debug".into()),
    }
}

fn list(dir: &Path) -> Result<Vec<DebugWav>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut wavs: Vec<DebugWav> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let meta = e.metadata().ok()?;
            (meta.is_file() && valid_name(&name)).then(|| DebugWav {
                name,
                bytes: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64),
            })
        })
        .collect();
    wavs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(wavs)
}

pub fn save(app_data: &Path, samples: &[f32]) -> Result<(), String> {
    let dir = app_data.join(DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    // Zero-padded so the names sort by time
    std::fs::write(dir.join(format!("segment-{millis:015}.wav")), wav_bytes(samples)).map_err(|e| e.to_string())?;
    prune(&dir)
}

fn prune(dir: &Path) -> Result<(), String> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    files.sort();
    for old in &files[..files.len().saturating_sub(KEEP)] {
        std::fs::remove_file(old).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 16 kHz mono 16-bit PCM
fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let rate = SAMPLE_RATE as u32;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_newest_files() {
        let dir = std::env::temp_dir().join(format!("forby-voice-debug-test-{}", std::process::id()));
        for i in 0..25 {
            std::fs::create_dir_all(dir.join(DIR)).unwrap();
            std::fs::write(dir.join(DIR).join(format!("segment-{i:015}.wav")), b"x").unwrap();
        }
        save(&dir, &[0.0; 160]).unwrap();
        let mut names: Vec<_> = std::fs::read_dir(dir.join(DIR)).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names.len(), KEEP);
        // The oldest six are gone, the new one (a real timestamp, so the largest name) is kept
        assert_eq!(names[0].to_str().unwrap(), "segment-000000000000006.wav");
        assert_eq!(std::fs::metadata(dir.join(DIR).join(names.last().unwrap())).unwrap().len(), 44 + 320);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_bare_wav_names_are_accepted() {
        for ok in ["segment-001790363454036.wav", "en_timer.wav", "a.b.wav"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "",
            ".wav",
            "x.WAV",
            "x.txt",
            "x.wav.txt",
            "../x.wav",
            "..\\x.wav",
            "x..wav",
            "sub/x.wav",
            "sub\\x.wav",
            "C:x.wav",
            "C:\\x.wav",
            "/x.wav",
            "\\\\server\\share\\x.wav",
            ".hidden.wav",
            "x .wav",
            "x\0.wav",
            "idő.wav",
            &format!("{}.wav", "a".repeat(MAX_NAME)),
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn resolve_and_list_stay_in_the_folder() {
        let root = std::env::temp_dir().join(format!("forby-voice-debug-resolve-{}", std::process::id()));
        let dir = root.join(DIR);
        std::fs::create_dir_all(dir.join("folder.wav")).unwrap();
        std::fs::write(dir.join("segment-2.wav"), b"xx").unwrap();
        std::fs::write(dir.join("segment-1.wav"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(root.join("outside.wav"), b"x").unwrap();

        assert_eq!(resolve(&dir, "segment-1.wav").unwrap(), dir.join("segment-1.wav"));
        assert!(resolve(&dir, "missing.wav").is_err());
        assert!(resolve(&dir, "folder.wav").is_err());
        assert!(resolve(&dir, "../outside.wav").is_err());
        assert!(resolve(&dir, "notes.txt").is_err());

        let wavs = list(&dir).unwrap();
        let names: Vec<_> = wavs.iter().map(|w| (w.name.as_str(), w.bytes)).collect();
        assert_eq!(names, [("segment-1.wav", 1), ("segment-2.wav", 2)]);
        assert!(wavs[0].modified > 0);
        assert!(list(&root.join("missing")).unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
