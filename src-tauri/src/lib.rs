use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// The main window starts hidden and the frontend shows it after restoring its position.
// Safety net: if that never happens (e.g. the frontend failed to load), show it anyway.
const SHOW_FALLBACK: Duration = Duration::from_secs(6);

const SETTINGS_LABEL: &str = "settings";

// Custom alarm sound: one fixed file in the app data folder
const SOUND_DIR: &str = "sounds";
const SOUND_STEM: &str = "custom";
const SOUND_EXTS: [&str; 5] = ["webm", "ogg", "mp3", "wav", "m4a"];
const SOUND_MAX_BYTES: usize = 5 * 1024 * 1024;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Created here (not from JS) so it gets the same WebView2 browser arguments as the main window;
// WebView2 refuses webviews with different arguments on the same data directory.
#[tauri::command]
async fn open_settings(app: AppHandle, query: String) -> Result<(), String> {
    if app.get_webview_window(SETTINGS_LABEL).is_some() {
        return Ok(());
    }
    let browser_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.clone());
    let url = WebviewUrl::App(format!("index.html?{query}").into());
    let mut builder = WebviewWindowBuilder::new(&app, SETTINGS_LABEL, url)
        .title("FORBY – Beállítások")
        .inner_size(300.0, 400.0)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true);
    if let Some(args) = browser_args {
        builder = builder.additional_browser_args(&args);
    }
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

fn sound_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(SOUND_DIR))
}

fn find_custom_sound(app: &AppHandle) -> Result<Option<std::path::PathBuf>, String> {
    let dir = sound_dir(app)?;
    Ok(SOUND_EXTS
        .iter()
        .map(|ext| dir.join(format!("{SOUND_STEM}.{ext}")))
        .find(|p| p.is_file()))
}

// Raw bytes in the body, the file extension in the "x-ext" header
#[tauri::command]
fn save_custom_sound(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw audio bytes".into());
    };
    let ext = request
        .headers()
        .get("x-ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !SOUND_EXTS.contains(&ext.as_str()) {
        return Err(format!("unsupported file type: {ext}"));
    }
    if data.is_empty() || data.len() > SOUND_MAX_BYTES {
        return Err(format!("file size must be 1 byte to {} MB", SOUND_MAX_BYTES / 1024 / 1024));
    }
    let dir = sound_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    while let Some(old) = find_custom_sound(&app)? {
        std::fs::remove_file(old).map_err(|e| e.to_string())?;
    }
    std::fs::write(dir.join(format!("{SOUND_STEM}.{ext}")), data).map_err(|e| e.to_string())
}

// The saved sound's bytes, or an empty body if there is none
#[tauri::command]
fn read_custom_sound(app: AppHandle) -> Result<Response, String> {
    match find_custom_sound(&app)? {
        Some(path) => std::fs::read(path).map(Response::new).map_err(|e| e.to_string()),
        None => Ok(Response::new(Vec::new())),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FALLBACK);
                if let Some(win) = handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing FORBY also closes the settings window
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![greet, open_settings, save_custom_sound, read_custom_sound])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
