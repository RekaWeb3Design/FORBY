use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

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

// Frontend errors and alarm traces, printed to the terminal running `tauri dev`
#[tauri::command]
fn log(level: String, message: String) {
    eprintln!("[FORBY {level}] {message}");
}

// Taskbar flashing through FlashWindowEx directly. Tauri's requestUserAttention does nothing while
// FORBY is the active window (e.g. right after a click on it started the timer); FLASHW_TIMER keeps
// flashing until it is stopped, whether FORBY is active or not.
#[cfg(windows)]
mod flash {
    #[repr(C)]
    struct FlashWInfo {
        cb_size: u32,
        hwnd: *mut std::ffi::c_void,
        dw_flags: u32,
        u_count: u32,
        dw_timeout: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn FlashWindowEx(pfwi: *const FlashWInfo) -> i32;
    }
    const FLASHW_STOP: u32 = 0;
    const FLASHW_ALL: u32 = 3; // caption and taskbar button
    const FLASHW_TIMER: u32 = 4;

    pub fn set(hwnd: *mut std::ffi::c_void, on: bool) {
        let info = FlashWInfo {
            cb_size: std::mem::size_of::<FlashWInfo>() as u32,
            hwnd,
            dw_flags: if on { FLASHW_ALL | FLASHW_TIMER } else { FLASHW_STOP },
            u_count: 0,
            dw_timeout: 0,
        };
        // The return value is the previous flash state, not an error code
        unsafe { FlashWindowEx(&info) };
    }
}

#[tauri::command]
fn flash_taskbar(window: WebviewWindow, on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        flash::set(hwnd, on);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let kind = on.then_some(tauri::UserAttentionType::Critical);
        window.request_user_attention(kind).map_err(|e| e.to_string())
    }
}

// Windows "Do not disturb": the quiet hours profile (0 off, 1 priority only, 2 alarms only).
// Undocumented WNF state, read only to explain missing toast banners in the log.
#[cfg(windows)]
fn quiet_hours_profile() -> Option<u32> {
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryWnfStateData(
            name: *const u64,
            type_id: *const std::ffi::c_void,
            scope: *const std::ffi::c_void,
            change_stamp: *mut u32,
            buffer: *mut u8,
            size: *mut u32,
        ) -> i32;
    }
    const WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: u64 = 0x0D83_063E_A3BF_1C75;
    let mut buf = [0u8; 4];
    let mut size = buf.len() as u32;
    let mut stamp = 0u32;
    let status = unsafe {
        NtQueryWnfStateData(
            &WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED,
            std::ptr::null(),
            std::ptr::null(),
            &mut stamp,
            buf.as_mut_ptr(),
            &mut size,
        )
    };
    (status == 0 && size == 4).then(|| u32::from_le_bytes(buf))
}

// Windows toast titled FORBY. Errors are returned (the notification plugin dropped them).
#[tauri::command]
async fn show_toast(app: AppHandle, body: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Duration, Toast};
        // Same rule as the notification plugin: a dev or unbundled build has no registered app id,
        // so its toasts appear under Windows PowerShell; the installed app uses its identifier.
        let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().map(|d| d.display().to_string()).unwrap_or_default();
        let sep = std::path::MAIN_SEPARATOR;
        let unbundled = dir.ends_with(&format!("{sep}target{sep}debug")) || dir.ends_with(&format!("{sep}target{sep}release"));
        let app_id = if unbundled { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
        if let Some(profile) = quiet_hours_profile().filter(|&p| p != 0) {
            eprintln!(
                "[FORBY warn] Windows \"Ne zavarjanak\" mode is on (profile {profile}): the toast goes to the notification centre without a banner"
            );
        }
        Toast::new(&app_id)
            .title("FORBY")
            .text1(&body)
            .sound(None)
            .duration(Duration::Short)
            .show()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, body);
        Err("toasts are implemented for Windows only".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
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
        .invoke_handler(tauri::generate_handler![
            greet,
            open_settings,
            save_custom_sound,
            read_custom_sound,
            log,
            flash_taskbar,
            show_toast
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
