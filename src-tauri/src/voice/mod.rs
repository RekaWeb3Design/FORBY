// Voice input, step 1: the default microphone on a worker thread, resampled to 16 kHz mono and cut into speech
// segments by a VAD. No transcription yet. Nothing starts on its own: the frontend calls voice_start / voice_stop.
// Privacy: audio never reaches the log, only segment lengths (dev builds) and errors.
#[cfg(debug_assertions)]
mod debug_wav;
mod resample;
mod segmenter;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::FromSample;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use resample::To16k;
use segmenter::{Segment, Segmenter};

use super::{LOG_TARGET, MAIN_LABEL};

const SEGMENT_EVENT: &str = "voice-segment";
const ERROR_EVENT: &str = "voice-error";

// Capture callbacks queued for the worker (about 10 ms each); if the worker falls behind, new ones are dropped
const QUEUE: usize = 256;
// How often the worker wakes without audio (to see voice_stop)
const POLL: Duration = Duration::from_millis(100);
// No audio for this long counts as a lost stream
const NO_AUDIO: Duration = Duration::from_secs(5);
// After a lost stream or a device change: this many attempts to reopen the default input, one per REOPEN_DELAY
const REOPEN_ATTEMPTS: u32 = 10;
const REOPEN_DELAY: Duration = Duration::from_secs(1);
// How often the Windows microphone privacy setting is re-read while listening
const CONSENT_CHECK: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ErrorKind {
    // Windows privacy settings block the microphone
    PermissionDenied,
    NoDevice,
    // The stream broke while listening and could not be reopened
    StreamLost,
    // Anything else when starting (unsupported format, busy device, ...)
    StartFailed,
}

#[derive(Clone, Debug, Serialize)]
pub struct VoiceError {
    kind: ErrorKind,
    message: String,
}

impl VoiceError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }

    fn permission() -> Self {
        Self::new(ErrorKind::PermissionDenied, "microphone access is off in the Windows privacy settings")
    }
}

#[derive(Clone, Serialize)]
struct SegmentPayload {
    ms: usize,
    truncated: bool,
}

struct Worker {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

// The running capture thread, if any
#[derive(Default)]
pub struct Voice(Mutex<Option<Worker>>);

// Starts listening; does nothing if already listening. Errors are also sent as voice-error events.
#[tauri::command]
pub async fn voice_start(app: AppHandle) -> Result<(), VoiceError> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || start(&handle))
        .await
        .map_err(|e| VoiceError::new(ErrorKind::StartFailed, e.to_string()))?
}

#[tauri::command]
pub async fn voice_stop(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || stop(&handle)).await.map_err(|e| e.to_string())
}

fn start(app: &AppHandle) -> Result<(), VoiceError> {
    let voice = app.state::<Voice>();
    let mut worker = voice.0.lock().unwrap_or_else(|e| e.into_inner());
    if worker.as_ref().is_some_and(|w| !w.handle.is_finished()) {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel();
    let (thread_app, thread_stop) = (app.clone(), stop.clone());
    let spawned = std::thread::Builder::new()
        .name("forby-voice".into())
        .spawn(move || run(thread_app, thread_stop, ready_tx));
    let result = match spawned {
        Err(e) => Err(VoiceError::new(ErrorKind::StartFailed, e.to_string())),
        Ok(handle) => match ready_rx.recv() {
            Ok(Ok(())) => {
                *worker = Some(Worker { stop, handle });
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err(VoiceError::new(ErrorKind::StartFailed, "the voice thread ended unexpectedly")),
        },
    };
    match &result {
        Ok(()) => log::info!(target: LOG_TARGET, "voice: listening"),
        Err(e) => report(app, e),
    }
    result
}

fn stop(app: &AppHandle) {
    let taken = app.state::<Voice>().0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(worker) = taken {
        worker.stop.store(true, Ordering::Relaxed);
        let _ = worker.handle.join();
        log::info!(target: LOG_TARGET, "voice: stopped");
    }
}

fn report(app: &AppHandle, err: &VoiceError) {
    log::warn!(target: LOG_TARGET, "voice: {:?}: {}", err.kind, err.message);
    if let Err(e) = app.emit_to(MAIN_LABEL, ERROR_EVENT, err.clone()) {
        log::error!(target: LOG_TARGET, "voice: sending {ERROR_EVENT} failed: {e}");
    }
}

fn emit_segment(app: &AppHandle, segment: Segment) {
    let payload = SegmentPayload { ms: segment.ms(), truncated: segment.truncated };
    #[cfg(debug_assertions)]
    {
        let cut = if payload.truncated { ", truncated" } else { "" };
        log::info!(target: LOG_TARGET, "voice: segment {} ms{cut}", payload.ms);
        if let Ok(dir) = app.path().app_data_dir() {
            if let Err(e) = debug_wav::save(&dir, &segment.samples) {
                log::warn!(target: LOG_TARGET, "voice: saving the debug WAV failed: {e}");
            }
        }
    }
    if let Err(e) = app.emit_to(MAIN_LABEL, SEGMENT_EVENT, payload) {
        log::error!(target: LOG_TARGET, "voice: sending {SEGMENT_EVENT} failed: {e}");
    }
}

enum Msg {
    // One capture callback, downmixed to mono, at the device rate
    Audio(Vec<f32>),
    Error(cpal::Error),
}

// An open input stream; dropping it stops the capture
struct Capture {
    _stream: cpal::Stream,
    rx: Receiver<Msg>,
    resampler: To16k,
}

// The capture thread: owns the stream, resamples, runs the VAD and sends the events
fn run(app: AppHandle, stop: Arc<AtomicBool>, ready: mpsc::Sender<Result<(), VoiceError>>) {
    let mut capture = match open() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut segmenter = Segmenter::new(earshot::Detector::default_boxed());
    let mut last_audio = Instant::now();
    let mut last_consent_check = Instant::now();
    let mut on_segment = |s: Segment| emit_segment(&app, s);
    while !stop.load(Ordering::Relaxed) {
        let lost = match capture.rx.recv_timeout(POLL) {
            Ok(Msg::Audio(mono)) => {
                last_audio = Instant::now();
                capture.resampler.push(&mono, &mut |s| segmenter.push(s, &mut on_segment)).err()
            }
            Ok(Msg::Error(e)) => match e.kind() {
                cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied => None,
                // Rerouted to the new default device by cpal; only the VAD state is stale
                cpal::ErrorKind::DeviceChanged => {
                    segmenter.reset();
                    None
                }
                _ => Some(e.to_string()),
            },
            Err(RecvTimeoutError::Timeout) => (last_audio.elapsed() >= NO_AUDIO).then(|| "no audio from the input device".into()),
            Err(RecvTimeoutError::Disconnected) => Some("the audio stream closed".into()),
        };
        if last_consent_check.elapsed() >= CONSENT_CHECK {
            last_consent_check = Instant::now();
            if consent::denied() {
                report(&app, &VoiceError::permission());
                return;
            }
        }
        if let Some(reason) = lost {
            log::warn!(target: LOG_TARGET, "voice: input stream lost ({reason}), reopening");
            drop(capture);
            match reopen(&stop) {
                None => return,
                Some(Ok(c)) => {
                    capture = c;
                    segmenter.reset();
                    last_audio = Instant::now();
                    log::info!(target: LOG_TARGET, "voice: input reopened");
                }
                Some(Err(e)) => {
                    report(&app, &e);
                    return;
                }
            }
        }
    }
}

// The default input device again (after a device change or a broken stream); None if voice_stop came meanwhile
fn reopen(stop: &AtomicBool) -> Option<Result<Capture, VoiceError>> {
    let mut result = Err(VoiceError::new(ErrorKind::StreamLost, "the input stream was lost"));
    for _ in 0..REOPEN_ATTEMPTS {
        let until = Instant::now() + REOPEN_DELAY;
        while Instant::now() < until {
            if stop.load(Ordering::Relaxed) {
                return None;
            }
            std::thread::sleep(POLL);
        }
        result = open();
        // Retrying cannot help once the privacy setting blocks the microphone
        if matches!(&result, Ok(_) | Err(VoiceError { kind: ErrorKind::PermissionDenied, .. })) {
            break;
        }
    }
    Some(result.map_err(|e| match e.kind {
        ErrorKind::PermissionDenied | ErrorKind::NoDevice => e,
        _ => VoiceError::new(ErrorKind::StreamLost, e.message),
    }))
}

fn open() -> Result<Capture, VoiceError> {
    if consent::denied() {
        return Err(VoiceError::permission());
    }
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| VoiceError::new(ErrorKind::NoDevice, "no input device (microphone) found"))?;
    let supported = device.default_input_config().map_err(classify)?;
    let config = supported.config();
    let (tx, rx) = mpsc::sync_channel(QUEUE);
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, config, tx),
        cpal::SampleFormat::I16 => build::<i16>(&device, config, tx),
        cpal::SampleFormat::I32 => build::<i32>(&device, config, tx),
        cpal::SampleFormat::U16 => build::<u16>(&device, config, tx),
        cpal::SampleFormat::U8 => build::<u8>(&device, config, tx),
        other => return Err(VoiceError::new(ErrorKind::StartFailed, format!("unsupported sample format: {other}"))),
    }
    .map_err(classify)?;
    stream.play().map_err(classify)?;
    let resampler = To16k::new(config.sample_rate).map_err(|e| VoiceError::new(ErrorKind::StartFailed, e))?;
    Ok(Capture { _stream: stream, rx, resampler })
}

// Native rate and channel count; the callback only downmixes to mono and queues
fn build<T>(device: &cpal::Device, config: cpal::StreamConfig, tx: SyncSender<Msg>) -> Result<cpal::Stream, cpal::Error>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels).max(1);
    let err_tx = tx.clone();
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _| {
            let mono = data
                .chunks_exact(channels)
                .map(|frame| frame.iter().map(|&s| f32::from_sample_(s)).sum::<f32>() / channels as f32)
                .collect();
            let _ = tx.try_send(Msg::Audio(mono));
        },
        move |e| {
            let _ = err_tx.send(Msg::Error(e));
        },
        None,
    )
}

fn classify(e: cpal::Error) -> VoiceError {
    let message = e.to_string();
    let kind = match e.kind() {
        cpal::ErrorKind::PermissionDenied => ErrorKind::PermissionDenied,
        cpal::ErrorKind::DeviceNotAvailable => ErrorKind::NoDevice,
        // WASAPI reports E_ACCESSDENIED as a plain backend error
        _ if consent::denied() || message.contains("(os error 5)") || message.contains("0x80070005") => {
            ErrorKind::PermissionDenied
        }
        _ => ErrorKind::StartFailed,
    };
    VoiceError::new(kind, message)
}

// Windows privacy settings: "Microphone access" (device-wide and per user) and "Let desktop apps access your
// microphone". Read from the (undocumented) ConsentStore registry values "Allow"/"Deny"; a missing value counts as
// allowed. WASAPI may deliver silence instead of an error when access is off, so this is checked directly.
#[cfg(windows)]
mod consent {
    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    const NON_PACKAGED: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged";
    // Predefined HKEYs are sign-extended 32-bit values
    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            hkey: isize,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            value_type: *mut u32,
            data: *mut std::ffi::c_void,
            data_len: *mut u32,
        ) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn is_deny(root: isize, sub_key: &str) -> bool {
        let mut buf = [0u16; 16];
        let mut len = std::mem::size_of_val(&buf) as u32;
        let status = unsafe {
            RegGetValueW(
                root,
                wide(sub_key).as_ptr(),
                wide("Value").as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut len,
            )
        };
        // len is in bytes and includes the terminating zero
        status == 0 && String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]) == "Deny"
    }

    pub fn denied() -> bool {
        is_deny(HKEY_LOCAL_MACHINE, KEY) || is_deny(HKEY_CURRENT_USER, KEY) || is_deny(HKEY_CURRENT_USER, NON_PACKAGED)
    }

    #[cfg(test)]
    mod tests {
        // This machine's setting, whatever it is, must read without crashing; a missing key is not a denial
        #[test]
        fn reads_the_registry() {
            let _ = super::denied();
            assert!(!super::is_deny(super::HKEY_CURRENT_USER, r"Software\FORBY-no-such-key"));
        }
    }
}

#[cfg(not(windows))]
mod consent {
    pub fn denied() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Opens the real default microphone for a moment (nothing is saved):
    // cargo test voice::tests::default_input_delivers_audio -- --ignored --nocapture
    #[test]
    #[ignore]
    fn default_input_delivers_audio() {
        let mut capture = open().expect("open the default input");
        let mut samples = 0;
        let until = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < until {
            if let Ok(Msg::Audio(mono)) = capture.rx.recv_timeout(POLL) {
                capture.resampler.push(&mono, &mut |s| samples += s.len()).unwrap();
            }
        }
        println!("{samples} samples at 16 kHz in 1.5 s");
        assert!(samples > 16_000, "{samples}");
    }
}
