// Whisper models: a fixed list, downloaded only on request into <app data>/models and verified by size and sha256.
// The hash runs while downloading; an installed model is recognised by its exact size.
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use super::{LOG_TARGET, MAIN_LABEL};

struct Model {
    name: &'static str,
    file: &'static str,
    bytes: u64,
    sha256: &'static str,
}

// Sizes and sha256 from the Hugging Face LFS metadata of ggerganov/whisper.cpp (base-q5_1 also checked on a download)
const MODELS: [Model; 2] = [
    Model {
        name: "base-q5_1",
        file: "ggml-base-q5_1.bin",
        bytes: 59_707_625,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    },
    Model {
        name: "small-q5_1",
        file: "ggml-small-q5_1.bin",
        bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
];

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const DIR: &str = "models";
const PART_EXT: &str = "part";

const PROGRESS_EVENT: &str = "model-progress";
const DONE_EVENT: &str = "model-done";
const ERROR_EVENT: &str = "model-error";

// Downloaded in Range requests of this size, each with its own time limit, so a stalled connection fails
// instead of hanging (ureq has no idle-read timeout)
const CHUNK: u64 = 4 * 1024 * 1024;
const CHUNK_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ErrorKind {
    Network,
    // The size or the sha256 differs from the table
    HashMismatch,
    Disk,
    Cancelled,
}

#[derive(Debug)]
struct DownloadError {
    kind: ErrorKind,
    message: String,
}

impl DownloadError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

fn disk(e: std::io::Error) -> DownloadError {
    DownloadError::new(ErrorKind::Disk, e.to_string())
}

fn network(message: impl Into<String>) -> DownloadError {
    DownloadError::new(ErrorKind::Network, message)
}

// ureq's messages, except the ones that would quote a URL
fn http_error(e: ureq::Error) -> DownloadError {
    match e {
        ureq::Error::BadUri(_) => network("invalid URL"),
        e => network(e.to_string()),
    }
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    name: &'static str,
    bytes: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    name: &'static str,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    name: &'static str,
    kind: ErrorKind,
    message: String,
}

#[derive(Serialize)]
pub struct ModelStatus {
    name: &'static str,
    bytes: u64,
    installed: bool,
    downloading: bool,
}

// Cancel flags of the running downloads, one per model at most
#[derive(Default)]
pub struct Models(Mutex<HashMap<&'static str, Arc<AtomicBool>>>);

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(DIR))
}

fn find(name: &str) -> Result<&'static Model, String> {
    MODELS.iter().find(|m| m.name == name).ok_or_else(|| format!("unknown model: {name}"))
}

fn installed(dir: &Path, model: &Model) -> bool {
    std::fs::metadata(dir.join(model.file)).is_ok_and(|m| m.is_file() && m.len() == model.bytes)
}

// The file of a model for the transcriber: None if it is not (fully) downloaded; an error for an unknown name
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn installed_path(app: &AppHandle, name: &str) -> Result<Option<PathBuf>, String> {
    let model = find(name)?;
    let dir = model_dir(app)?;
    Ok(installed(&dir, model).then(|| dir.join(model.file)))
}

#[tauri::command]
pub fn model_status(app: AppHandle, state: State<'_, Models>) -> Result<Vec<ModelStatus>, String> {
    let dir = model_dir(&app)?;
    let running = state.0.lock().unwrap_or_else(|e| e.into_inner());
    Ok(MODELS
        .iter()
        .map(|m| ModelStatus {
            name: m.name,
            bytes: m.bytes,
            installed: installed(&dir, m),
            downloading: running.contains_key(m.name),
        })
        .collect())
}

// Starts the download on its own thread and returns at once; the outcome comes as model-done / model-error.
// Nothing happens if this model is already downloading; an installed model is reported done right away.
#[tauri::command]
pub fn model_download(app: AppHandle, state: State<'_, Models>, name: String) -> Result<(), String> {
    let model = find(&name)?;
    let dir = model_dir(&app)?;
    let mut running = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if running.contains_key(model.name) {
        return Ok(());
    }
    if installed(&dir, model) {
        emit(&app, DONE_EVENT, DonePayload { name: model.name });
        return Ok(());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    running.insert(model.name, cancel.clone());
    drop(running);
    log::info!(target: LOG_TARGET, "models: downloading {}", model.name);
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new().name("forby-model-download".into()).spawn(move || {
        let app = thread_app;
        let mut last_emitted = 0;
        let result = download(model, &dir, &cancel, &mut |bytes| {
            // About every 1% (and at the end)
            if bytes - last_emitted >= model.bytes / 100 || bytes == model.bytes {
                last_emitted = bytes;
                emit(&app, PROGRESS_EVENT, ProgressPayload { name: model.name, bytes, total: model.bytes });
            }
        });
        app.state::<Models>().0.lock().unwrap_or_else(|e| e.into_inner()).remove(model.name);
        match result {
            Ok(()) => {
                log::info!(target: LOG_TARGET, "models: {} downloaded", model.name);
                emit(&app, DONE_EVENT, DonePayload { name: model.name });
            }
            Err(e) => {
                log::warn!(target: LOG_TARGET, "models: {} download failed ({:?}): {}", model.name, e.kind, e.message);
                emit(&app, ERROR_EVENT, ErrorPayload { name: model.name, kind: e.kind, message: e.message });
            }
        }
    });
    if let Err(e) = spawned {
        state.0.lock().unwrap_or_else(|e| e.into_inner()).remove(model.name);
        return Err(e.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn model_cancel(state: State<'_, Models>, name: String) -> Result<(), String> {
    let model = find(&name)?;
    if let Some(cancel) = state.0.lock().unwrap_or_else(|e| e.into_inner()).get(model.name) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// At startup: leftovers of interrupted downloads
pub fn remove_partial_downloads(app: &AppHandle) {
    let result = model_dir(app).and_then(|dir| remove_parts(&dir).map_err(|e| e.to_string()));
    if let Err(e) = result {
        log::warn!(target: LOG_TARGET, "models: removing partial downloads failed: {e}");
    }
}

fn remove_parts(dir: &Path) -> std::io::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for path in entries.filter_map(|e| e.ok()).map(|e| e.path()) {
        if path.is_file() && path.extension().is_some_and(|x| x == PART_EXT) {
            std::fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit_to(MAIN_LABEL, event, payload) {
        log::error!(target: LOG_TARGET, "models: sending {event} failed: {e}");
    }
}

// Into <dir>/<file>.part while hashing, then verified and renamed; the .part is removed on any failure
fn download(model: &Model, dir: &Path, cancel: &AtomicBool, progress: &mut impl FnMut(u64)) -> Result<(), DownloadError> {
    std::fs::create_dir_all(dir).map_err(disk)?;
    let part = dir.join(format!("{}.{PART_EXT}", model.file));
    match fetch(model, &part, cancel, progress) {
        Ok((bytes, digest)) => finish(model, &part, &dir.join(model.file), bytes, &digest),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

fn fetch(model: &Model, part: &Path, cancel: &AtomicBool, progress: &mut impl FnMut(u64)) -> Result<(u64, [u8; 32]), DownloadError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .timeout_recv_body(Some(CHUNK_TIMEOUT))
        .user_agent(concat!("FORBY/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let url = format!("{BASE_URL}{}", model.file);
    let mut file = File::create(part).map_err(disk)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    while done < model.bytes {
        let end = (done + CHUNK).min(model.bytes) - 1;
        let response = get_range(&agent, &url, done, end)?;
        let status = response.status().as_u16();
        // A server that ignores Range sends the whole file at once
        let whole = status == 200 && done == 0;
        if status != 206 && !whole {
            return Err(network(format!("HTTP status {status}")));
        }
        let mut reader = response.into_body().into_reader();
        let chunk_start = done;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(DownloadError::new(ErrorKind::Cancelled, "cancelled"));
            }
            let n = reader.read(&mut buf).map_err(|e| network(e.to_string()))?;
            if n == 0 {
                break;
            }
            done += n as u64;
            if done > model.bytes {
                return Err(DownloadError::new(ErrorKind::HashMismatch, "the server sent more data than expected"));
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(disk)?;
            progress(done);
        }
        if whole {
            break;
        }
        if done == chunk_start {
            return Err(network("empty response"));
        }
    }
    file.sync_all().map_err(disk)?;
    Ok((done, hasher.finalize().into()))
}

// GET with a Range header, following redirects only over HTTPS and only to Hugging Face hosts
fn get_range(agent: &ureq::Agent, url: &str, start: u64, end: u64) -> Result<ureq::http::Response<ureq::Body>, DownloadError> {
    let mut url = url.to_owned();
    for _ in 0..=MAX_REDIRECTS {
        let response = agent
            .get(&url)
            .header("Range", format!("bytes={start}-{end}"))
            .call()
            .map_err(http_error)?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| network("redirect without a location"))?;
        url = redirect_target(&url, location).map_err(network)?;
    }
    Err(network("too many redirects"))
}

fn allowed_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ["huggingface.co", "hf.co"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

// The absolute URL of a redirect, if it stays on HTTPS and on Hugging Face
fn redirect_target(current: &str, location: &str) -> Result<String, String> {
    let target = if location.starts_with('/') && !location.starts_with("//") {
        let uri: ureq::http::Uri = current.parse().map_err(|_| "invalid URL".to_owned())?;
        let authority = uri.authority().ok_or("invalid URL")?;
        format!("https://{authority}{location}")
    } else {
        location.to_owned()
    };
    let uri: ureq::http::Uri = target.parse().map_err(|_| "invalid redirect URL".to_owned())?;
    if uri.scheme_str() != Some("https") {
        return Err("redirect to a non-HTTPS address".into());
    }
    if !uri.host().is_some_and(allowed_host) {
        return Err("redirect outside Hugging Face".into());
    }
    Ok(target)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// Size and hash as in the table: rename to the final name; otherwise delete the .part
fn finish(model: &Model, part: &Path, target: &Path, bytes: u64, digest: &[u8; 32]) -> Result<(), DownloadError> {
    let mismatch = if bytes != model.bytes {
        Some(format!("size {bytes} bytes, expected {}", model.bytes))
    } else if hex(digest) != model.sha256 {
        Some("sha256 differs".to_owned())
    } else {
        None
    };
    if let Some(message) = mismatch {
        let _ = std::fs::remove_file(part);
        return Err(DownloadError::new(ErrorKind::HashMismatch, message));
    }
    std::fs::rename(part, target).map_err(|e| {
        let _ = std::fs::remove_file(part);
        disk(e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // sha256("hello")
    const HELLO: Model = Model {
        name: "test",
        file: "test.bin",
        bytes: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    };

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forby-models-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_part(dir: &Path, content: &[u8]) -> (PathBuf, [u8; 32]) {
        let part = dir.join("test.bin.part");
        std::fs::write(&part, content).unwrap();
        (part, Sha256::digest(content).into())
    }

    #[test]
    fn matching_part_is_renamed() {
        let dir = temp_dir("ok");
        let (part, digest) = write_part(&dir, b"hello");
        finish(&HELLO, &part, &dir.join(HELLO.file), 5, &digest).unwrap();
        assert!(!part.exists());
        assert_eq!(std::fs::read(dir.join(HELLO.file)).unwrap(), b"hello");
        assert!(installed(&dir, &HELLO));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hash_mismatch_removes_the_part() {
        let dir = temp_dir("hash");
        let (part, digest) = write_part(&dir, b"hellO");
        let err = finish(&HELLO, &part, &dir.join(HELLO.file), 5, &digest).unwrap_err();
        assert_eq!(err.kind, ErrorKind::HashMismatch);
        assert!(!part.exists());
        assert!(!dir.join(HELLO.file).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn size_mismatch_removes_the_part() {
        let dir = temp_dir("size");
        let (part, digest) = write_part(&dir, b"hello!");
        let err = finish(&HELLO, &part, &dir.join(HELLO.file), 6, &digest).unwrap_err();
        assert_eq!(err.kind, ErrorKind::HashMismatch);
        assert!(!part.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn startup_cleanup_removes_only_parts() {
        let dir = temp_dir("cleanup");
        std::fs::write(dir.join("ggml-base-q5_1.bin.part"), b"x").unwrap();
        std::fs::write(dir.join("ggml-small-q5_1.bin.part"), b"x").unwrap();
        std::fs::write(dir.join("ggml-base-q5_1.bin"), b"model").unwrap();
        remove_parts(&dir).unwrap();
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("ggml-base-q5_1.bin")]);
        // A missing folder is not an error
        remove_parts(&dir.join("missing")).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn size_decides_installed() {
        let dir = temp_dir("installed");
        std::fs::write(dir.join(HELLO.file), b"hell").unwrap();
        assert!(!installed(&dir, &HELLO));
        std::fs::write(dir.join(HELLO.file), b"hello").unwrap();
        assert!(installed(&dir, &HELLO));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn redirects_stay_on_hugging_face_over_https() {
        let hf = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin";
        assert_eq!(redirect_target(hf, "https://us.aws.cdn.hf.co/xet-bridge-us/abc?x=1").unwrap(), "https://us.aws.cdn.hf.co/xet-bridge-us/abc?x=1");
        assert_eq!(redirect_target(hf, "/api/resolve-cache/abc").unwrap(), "https://huggingface.co/api/resolve-cache/abc");
        assert!(redirect_target(hf, "https://cdn-lfs.huggingface.co/x").is_ok());
        assert!(redirect_target(hf, "http://us.aws.cdn.hf.co/x").is_err());
        assert!(redirect_target(hf, "https://evil.example/x").is_err());
        assert!(redirect_target(hf, "https://hf.co.evil.example/x").is_err());
        assert!(redirect_target(hf, "https://evilhf.co/x").is_err());
        assert!(redirect_target(hf, "//evil.example/x").is_err());
    }

    #[test]
    fn unknown_models_are_refused() {
        assert!(find("base-q5_1").is_ok());
        assert!(find("ggml-large-v3.bin").is_err());
        assert!(find("../base-q5_1").is_err());
    }

    // Real download of base-q5_1 (57 MiB) into a temp folder:
    // cargo test models::tests::downloads_base_model -- --ignored --nocapture
    #[test]
    #[ignore]
    fn downloads_base_model() {
        let dir = temp_dir("download");
        let started = std::time::Instant::now();
        download(&MODELS[0], &dir, &AtomicBool::new(false), &mut |_| {}).unwrap();
        println!("downloaded and verified in {:.1} s", started.elapsed().as_secs_f32());
        assert!(installed(&dir, &MODELS[0]));
        assert!(!dir.join(format!("{}.{PART_EXT}", MODELS[0].file)).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
