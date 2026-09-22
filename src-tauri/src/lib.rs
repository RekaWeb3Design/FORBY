use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

// The main window starts hidden and the frontend shows it after restoring its position.
// Safety net: if that never happens (e.g. the frontend failed to load), show it anyway.
const SHOW_FALLBACK: Duration = Duration::from_secs(6);

const MAIN_LABEL: &str = "main";
const SETTINGS_LABEL: &str = "settings";

// Tray menu items; "Beállítások" and "FORBY megkeresése" are done by the main window (it knows the layout)
const TRAY_SETTINGS: &str = "settings";
const TRAY_FIND: &str = "find";
const TRAY_QUIT: &str = "quit";
const TRAY_SETTINGS_EVENT: &str = "tray-settings";
const TRAY_FIND_EVENT: &str = "tray-find";

// Simplified tray icon (icons/source/tray.svg) pre-rendered per size; 16 px at 100% display scaling
const TRAY_ICON_BASE: f64 = 16.0;
const TRAY_ICONS: [(u32, &[u8]); 4] = [
    (16, include_bytes!("../icons/source/tray-16.png")),
    (20, include_bytes!("../icons/source/tray-20.png")),
    (24, include_bytes!("../icons/source/tray-24.png")),
    (32, include_bytes!("../icons/source/tray-32.png")),
];

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
        .find(|w| w.label == MAIN_LABEL)
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

// Log lines: "<local time> [FORBY <level>] <message>", to the terminal running `tauri dev` and to
// %LOCALAPPDATA%\studio.wow.forby\logs\forby.log (the installed app too)
const LOG_TARGET: &str = "forby";
const LOG_FILE: &str = "forby";
const LOG_MAX_BYTES: u128 = 1024 * 1024; // then the file is rotated, keeping only the newest

fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: Some(LOG_FILE.into()) }),
        ])
        .level(log::LevelFilter::Warn)
        .level_for(LOG_TARGET, log::LevelFilter::Info)
        .max_file_size(LOG_MAX_BYTES)
        .rotation_strategy(RotationStrategy::KeepOne)
        .format(|out, message, record| {
            let t = TimezoneStrategy::UseLocal.get_now();
            out.finish(format_args!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02} [FORBY {}] {}",
                t.year(),
                u8::from(t.month()),
                t.day(),
                t.hour(),
                t.minute(),
                t.second(),
                record.level().as_str().to_ascii_lowercase(),
                message
            ))
        })
        .build()
}

// Frontend errors and alarm traces
#[tauri::command]
fn log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!(target: LOG_TARGET, "{message}"),
        "warn" => log::warn!(target: LOG_TARGET, "{message}"),
        _ => log::info!(target: LOG_TARGET, "{message}"),
    }
}

// Taskbar flashing through FlashWindowEx directly (Tauri's requestUserAttention returns early while
// FORBY is the active window). FLASHW_TIMER keeps flashing until it is stopped.
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
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
    }

    pub fn is_foreground(hwnd: *mut std::ffi::c_void) -> bool {
        unsafe { GetForegroundWindow() == hwnd }
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
        if on && flash::is_foreground(hwnd) {
            log::info!(target: LOG_TARGET, "flash requested while FORBY is the foreground window");
        }
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
            log::warn!(
                target: LOG_TARGET,
                "Windows \"Ne zavarjanak\" mode is on (profile {profile}): the toast goes to the notification centre without a banner"
            );
        }
        log::info!(target: LOG_TARGET, "toast with app id {app_id}");
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

// Start with Windows (HKCU Run key). A dev build never registers itself: its exe lives in target/.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    if tauri::is_dev() {
        log::info!(target: LOG_TARGET, "dev mode: autostart not changed (setting: {})", if enabled { "on" } else { "off" });
        return Ok(());
    }
    let manager = app.autolaunch();
    if enabled {
        // Written every time, so the entry follows the exe if it moved
        manager.enable().map_err(|e| e.to_string())
    } else if manager.is_enabled().map_err(|e| e.to_string())? {
        manager.disable().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

// The smallest pre-rendered tray icon that covers the primary monitor's scaling (the largest if none does)
fn tray_icon(app: &AppHandle) -> tauri::Result<Image<'static>> {
    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    let want = (TRAY_ICON_BASE * scale).round() as u32;
    let (_, bytes) = TRAY_ICONS
        .iter()
        .find(|(size, _)| *size >= want)
        .unwrap_or(&TRAY_ICONS[TRAY_ICONS.len() - 1]);
    Image::from_bytes(bytes)
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, TRAY_SETTINGS, "Beállítások", true, None::<&str>)?,
            &MenuItem::with_id(app, TRAY_FIND, "FORBY megkeresése", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, TRAY_QUIT, "Kilépés", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("forby")
        .icon(tray_icon(app)?)
        .tooltip("FORBY")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let emit = |name: &str| {
                show_main(app);
                if let Err(e) = app.emit_to(MAIN_LABEL, name, ()) {
                    log::error!(target: LOG_TARGET, "tray: sending {name} failed: {e}");
                }
            };
            match event.id().as_ref() {
                TRAY_SETTINGS => emit(TRAY_SETTINGS_EVENT),
                TRAY_FIND => emit(TRAY_FIND_EVENT),
                TRAY_QUIT => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(log_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().app_name("FORBY").build())
        .setup(|app| {
            create_tray(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FALLBACK);
                if let Some(win) = handle.get_webview_window(MAIN_LABEL) {
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing FORBY also closes the settings window
            if window.label() == MAIN_LABEL && matches!(event, WindowEvent::Destroyed) {
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
            show_toast,
            set_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
