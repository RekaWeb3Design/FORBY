use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

mod models;
mod voice;

// The main window starts hidden and the frontend shows it after restoring its position.
// Safety net: if that never happens (e.g. the frontend failed to load), show it anyway.
const SHOW_FALLBACK: Duration = Duration::from_secs(6);

const MAIN_LABEL: &str = "main";
const SETTINGS_LABEL: &str = "settings";

// Tray menu items; settings and find are done by the main window (it knows the layout)
const TRAY_SETTINGS: &str = "settings";
const TRAY_FIND: &str = "find";
const TRAY_QUIT: &str = "quit";
const TRAY_SETTINGS_EVENT: &str = "tray-settings";
const TRAY_FIND_EVENT: &str = "tray-find";

// User-visible texts live in the frontend (strings.ts); these neutral defaults show only until
// the main window sends the texts of the chosen language (set_tray_labels)
const DEFAULT_TRAY_SETTINGS: &str = "Settings";
const DEFAULT_TRAY_FIND: &str = "Find FORBY";
const DEFAULT_TRAY_QUIT: &str = "Quit";
const DEFAULT_WINDOW_TITLE: &str = "FORBY";

// Tray menu item handles and the settings window title, managed as app state
struct TrayLabels {
    settings: MenuItem<tauri::Wry>,
    find: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    window_title: Mutex<String>,
}

// Simplified tray icon (icons/source/tray.svg) pre-rendered per size; 16 px at 100% display scaling
const TRAY_ICON_BASE: f64 = 16.0;
const TRAY_ICONS: [(u32, &[u8]); 4] = [
    (16, include_bytes!("../icons/source/tray-16.png")),
    (20, include_bytes!("../icons/source/tray-20.png")),
    (24, include_bytes!("../icons/source/tray-24.png")),
    (32, include_bytes!("../icons/source/tray-32.png")),
];

// Custom sound library: "<id>.<ext>" files in the app data folder
const SOUND_DIR: &str = "sounds";
const LEGACY_SOUND_STEM: &str = "custom"; // the single custom sound of 0.1.x
const SOUND_EXTS: [&str; 5] = ["webm", "ogg", "mp3", "wav", "m4a"];
const SOUND_MAX_BYTES: usize = 5 * 1024 * 1024;
const SOUND_MAX_COUNT: usize = 8;
const SOUND_ID_MAX: usize = 16;

// Created here (not from JS) so it gets the same WebView2 browser arguments as the main window;
// WebView2 refuses webviews with different arguments on the same data directory.
#[tauri::command]
async fn open_settings(app: AppHandle, query: String) -> Result<(), String> {
    if app.get_webview_window(SETTINGS_LABEL).is_some() {
        return Ok(());
    }
    let title = app.state::<TrayLabels>().window_title.lock().map_err(|e| e.to_string())?.clone();
    let browser_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_LABEL)
        .and_then(|w| w.additional_browser_args.clone());
    let url = WebviewUrl::App(format!("index.html?{query}").into());
    let mut builder = WebviewWindowBuilder::new(&app, SETTINGS_LABEL, url)
        .title(&title)
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

fn valid_sound_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= SOUND_ID_MAX && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn find_sound(app: &AppHandle, stem: &str) -> Result<Option<std::path::PathBuf>, String> {
    let dir = sound_dir(app)?;
    Ok(SOUND_EXTS
        .iter()
        .map(|ext| dir.join(format!("{stem}.{ext}")))
        .find(|p| p.is_file()))
}

// Ids of the saved library sounds (file stems in the sound folder, the legacy file excluded)
fn sound_ids(app: &AppHandle) -> Result<Vec<String>, String> {
    let Ok(entries) = std::fs::read_dir(sound_dir(app)?) else {
        return Ok(Vec::new());
    };
    let mut ids: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| SOUND_EXTS.contains(&x))
        })
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_owned))
        .filter(|s| s != LEGACY_SOUND_STEM && valid_sound_id(s))
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn header(request: &Request<'_>, name: &str) -> String {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

// Raw bytes in the body, the sound id in the "x-id" and the file extension in the "x-ext" header
#[tauri::command]
fn save_sound(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw audio bytes".into());
    };
    let id = header(&request, "x-id");
    let ext = header(&request, "x-ext");
    if !valid_sound_id(&id) || id == LEGACY_SOUND_STEM {
        return Err(format!("invalid sound id: {id}"));
    }
    if !SOUND_EXTS.contains(&ext.as_str()) {
        return Err(format!("unsupported file type: {ext}"));
    }
    if data.is_empty() || data.len() > SOUND_MAX_BYTES {
        return Err(format!("file size must be 1 byte to {} MB", SOUND_MAX_BYTES / 1024 / 1024));
    }
    let ids = sound_ids(&app)?;
    if !ids.contains(&id) && ids.len() >= SOUND_MAX_COUNT {
        return Err(format!("at most {SOUND_MAX_COUNT} custom sounds"));
    }
    let dir = sound_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    while let Some(old) = find_sound(&app, &id)? {
        std::fs::remove_file(old).map_err(|e| e.to_string())?;
    }
    std::fs::write(dir.join(format!("{id}.{ext}")), data).map_err(|e| e.to_string())
}

// The sound's bytes, or an empty body if there is none
#[tauri::command]
fn read_sound(app: AppHandle, id: String) -> Result<Response, String> {
    if !valid_sound_id(&id) {
        return Err(format!("invalid sound id: {id}"));
    }
    match find_sound(&app, &id)? {
        Some(path) => std::fs::read(path).map(Response::new).map_err(|e| e.to_string()),
        None => Ok(Response::new(Vec::new())),
    }
}

#[tauri::command]
fn delete_sound(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_sound_id(&id) {
        return Err(format!("invalid sound id: {id}"));
    }
    while let Some(path) = find_sound(&app, &id)? {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 0.1.1 -> 0.2.0: the single custom sound ("custom.<ext>") becomes the library sound `id`.
// Safe to repeat: if `id` already exists, nothing moves. Returns whether the sound exists.
#[tauri::command]
fn migrate_legacy_sound(app: AppHandle, id: String) -> Result<bool, String> {
    if !valid_sound_id(&id) || id == LEGACY_SOUND_STEM {
        return Err(format!("invalid sound id: {id}"));
    }
    if find_sound(&app, &id)?.is_some() {
        return Ok(true);
    }
    let Some(old) = find_sound(&app, LEGACY_SOUND_STEM)? else {
        return Ok(false);
    };
    let ext = old.extension().and_then(|x| x.to_str()).unwrap_or_default().to_owned();
    std::fs::rename(&old, sound_dir(&app)?.join(format!("{id}.{ext}"))).map_err(|e| e.to_string())?;
    Ok(true)
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

// Texts of the tray menu and the settings window title, from the frontend in the chosen language
#[tauri::command]
fn set_tray_labels(
    state: State<'_, TrayLabels>,
    settings: String,
    find: String,
    quit: String,
    window_title: String,
) -> Result<(), String> {
    state.settings.set_text(&settings).map_err(|e| e.to_string())?;
    state.find.set_text(&find).map_err(|e| e.to_string())?;
    state.quit.set_text(&quit).map_err(|e| e.to_string())?;
    *state.window_title.lock().map_err(|e| e.to_string())? = window_title;
    Ok(())
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

// Builds the tray; returns the menu item handles so the frontend can retitle them
fn create_tray(app: &AppHandle) -> tauri::Result<TrayLabels> {
    let settings = MenuItem::with_id(app, TRAY_SETTINGS, DEFAULT_TRAY_SETTINGS, true, None::<&str>)?;
    let find = MenuItem::with_id(app, TRAY_FIND, DEFAULT_TRAY_FIND, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, DEFAULT_TRAY_QUIT, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &find, &PredefinedMenuItem::separator(app)?, &quit])?;
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
    Ok(TrayLabels { settings, find, quit, window_title: Mutex::new(DEFAULT_WINDOW_TITLE.into()) })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(log_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().app_name("FORBY").build())
        .manage(voice::Voice::default())
        .manage(models::Models::default())
        .setup(|app| {
            models::remove_partial_downloads(app.handle());
            let labels = create_tray(app.handle())?;
            app.manage(labels);
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
            open_settings,
            save_sound,
            read_sound,
            delete_sound,
            migrate_legacy_sound,
            log,
            flash_taskbar,
            show_toast,
            set_autostart,
            set_tray_labels,
            voice::voice_start,
            voice::voice_stop,
            #[cfg(debug_assertions)]
            voice::debug_wav::voice_list_debug,
            #[cfg(debug_assertions)]
            voice::debug_wav::voice_transcribe_debug,
            models::model_status,
            models::model_download,
            models::model_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
