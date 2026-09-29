// Proceso principal (Rust) de NES Player, versión Tauri.
//
// Aviso de verificación: este archivo NO se ha podido compilar en el entorno donde lo
// escribí (no hay Windows, ni GTK/WebKit2GTK, ni una versión de Rust suficientemente
// reciente para la crate `tauri`). Solo `config.rs` se compiló y probó de forma aislada
// (ver tests al final de ese archivo). Revisa el README para más detalle.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod menu;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use config::AppConfig;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

const ROM_EXT: [&str; 2] = ["nes", "zip"];
const MAX_ROM_BYTES: u64 = 32 * 1024 * 1024;
const MAX_BLOB_BYTES: usize = 16 * 1024 * 1024;

struct AppState {
    config: Mutex<AppConfig>,
    pending_rom: Mutex<Option<RomPayload>>,
    closing: AtomicBool,
    flush_tx: Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Serialize, Clone)]
struct RomPayload {
    name: String,
    path: String,
    key: String,
    #[serde(rename = "dataBase64")]
    data_base64: String,
}

#[derive(Serialize)]
struct ReadyPayload {
    config: AppConfig,
    defaults: AppConfig,
    rom: Option<RomPayload>,
}

// ---------- Rutas de datos ----------
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("config.json"))
}
fn sram_path(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("saves").join(format!("{key}.sram")))
}
fn state_path(app: &AppHandle, key: &str, slot: i64) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("states").join(format!("{key}.slot{slot}.state")))
}
fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

fn load_config(app: &AppHandle) -> AppConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) => config::sanitize(&AppConfig::default(), &v),
            Err(_) => AppConfig::default(),
        },
        Err(_) => AppConfig::default(),
    }
}
fn save_config(app: &AppHandle, cfg: &AppConfig) {
    if let Ok(path) = config_path(app) {
        if let Ok(text) = serde_json::to_string_pretty(cfg) {
            let _ = write_atomic(&path, text.as_bytes());
        }
    }
}

fn is_rom_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| ROM_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn read_rom_file(path: &str) -> Result<RomPayload, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("Ruta no válida".into());
    }
    if !is_rom_ext(p) {
        return Err("Solo se admiten archivos .nes o .zip".into());
    }
    let meta = fs::metadata(p).map_err(|e| format!("No se pudo leer el archivo: {e}"))?;
    if !meta.is_file() {
        return Err("No es un archivo".into());
    }
    if meta.len() > MAX_ROM_BYTES {
        return Err("Archivo demasiado grande".into());
    }
    let data = fs::read(p).map_err(|e| format!("No se pudo leer el archivo: {e}"))?;
    let mut hasher = Sha1::new();
    hasher.update(&data);
    let key = hex_prefix(&hasher.finalize(), 16);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("rom").to_string();
    Ok(RomPayload { name, path: path.to_string(), key, data_base64: B64.encode(&data) })
}
fn hex_prefix(bytes: &[u8], n: usize) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>().chars().take(n).collect()
}

fn valid_key(k: &str) -> bool {
    k.len() == 16 && k.chars().all(|c| c.is_ascii_hexdigit())
}
fn valid_slot(s: i64) -> bool {
    (1..=config::SLOTS).contains(&s)
}

fn rom_from_args(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| {
        let p = Path::new(a);
        is_rom_ext(p) && p.exists()
    }).cloned()
}
fn auto_rom_path() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            dirs.push(d.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd);
    }
    for d in dirs {
        let p = d.join("roms").join("game.nes");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

// ---------- Comandos invocables desde el renderer ----------

#[tauri::command]
async fn app_ready(app: AppHandle, state: State<'_, AppState>) -> Result<ReadyPayload, String> {
    let cfg = state.config.lock().unwrap().clone();
    let rom = state.pending_rom.lock().unwrap().take();
    if let Some(win) = app.get_webview_window("main") {
        let title = match &rom {
            Some(r) => format!("NES Player — {}", r.name),
            None => "NES Player".to_string(),
        };
        let _ = win.set_title(&title);
        let _ = win.show(); // ventana creada oculta (windows[0].visible=false) para evitar el "flash" en blanco
    }
    Ok(ReadyPayload { config: cfg, defaults: AppConfig::default(), rom })
}

#[tauri::command]
fn flush_done(state: State<'_, AppState>) {
    if let Some(tx) = state.flush_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

/// Abre el selector de archivos del sistema, de forma no bloqueante (evita el problema de
/// hilos de la variante `blocking_*` cuando se llama fuera del hilo principal de la interfaz,
/// que en la primera versión dejaba el diálogo sin aparecer nunca).
async fn pick_rom_path(app: &AppHandle) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("ROMs de NES (.nes, .zip)", &["nes", "zip"])
        .add_filter("Todos los archivos", &["*"])
        .set_title("Abrir ROM de NES")
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    match rx.await {
        Ok(Some(fp)) => fp.into_path().ok().map(|p| p.to_string_lossy().to_string()),
        _ => None,
    }
}

#[tauri::command]
async fn rom_open_dialog(app: AppHandle) -> Result<(), String> {
    if let Some(path) = pick_rom_path(&app).await {
        open_rom(&app, path, true).await?;
    }
    Ok(())
}

#[tauri::command]
async fn rom_open_path(app: AppHandle, path: String) -> Result<(), String> {
    open_rom(&app, path, true).await
}

async fn open_rom(app: &AppHandle, path: String, remember: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    match read_rom_file(&path) {
        Ok(rom) => {
            if remember {
                let mut cfg = state.config.lock().unwrap();
                cfg.recent.retain(|p| p != &path);
                cfg.recent.insert(0, path.clone());
                cfg.recent.truncate(config::MAX_RECENT);
                let snapshot = cfg.clone();
                drop(cfg);
                save_config(app, &snapshot);
                menu::rebuild(app, &snapshot);
            }
            request_flush(app).await;
            *state.pending_rom.lock().unwrap() = Some(rom);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("location.reload()");
            }
            Ok(())
        }
        Err(err) => {
            let mut cfg = state.config.lock().unwrap();
            cfg.recent.retain(|p| p != &path);
            let snapshot = cfg.clone();
            drop(cfg);
            save_config(app, &snapshot);
            menu::rebuild(app, &snapshot);
            if let Some(win) = app.get_webview_window("main") {
                let _ = app
                    .dialog()
                    .message(format!("No se pudo abrir la ROM:\n{err}"))
                    .title("NES Player")
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .blocking_show();
                let _ = win; // silenciar warning si no se usa más
            }
            Err(err)
        }
    }
}

/// Pide al renderer que guarde la SRAM pendiente y espera su confirmación
/// (con un máximo de 1.5 s), igual que en la versión Electron.
async fn request_flush(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (tx, rx) = oneshot::channel();
    *state.flush_tx.lock().unwrap() = Some(tx);
    let _ = app.emit("app:flush", ());
    let _ = tokio::time::timeout(std::time::Duration::from_millis(1500), rx).await;
    *state.flush_tx.lock().unwrap() = None;
}

#[tauri::command]
fn config_set(app: AppHandle, state: State<'_, AppState>, patch: serde_json::Value) -> Result<AppConfig, String> {
    let mut cfg = state.config.lock().unwrap();
    let next = config::apply_patch(&cfg, &patch);
    if !config::find_duplicates(&next).is_empty() {
        return Err("Hay teclas duplicadas".into());
    }
    *cfg = next.clone();
    drop(cfg);
    save_config(&app, &next);
    menu::rebuild(&app, &next);
    let _ = app.emit("config:changed", &next);
    Ok(next)
}

#[tauri::command]
fn window_set_fullscreen(win: WebviewWindow, value: bool) -> Result<(), String> {
    win.set_fullscreen(value).map_err(|e| e.to_string())?;
    let _ = win.emit("window:fullscreen", value);
    Ok(())
}
#[tauri::command]
fn window_toggle_fullscreen(win: WebviewWindow) -> Result<(), String> {
    let cur = win.is_fullscreen().map_err(|e| e.to_string())?;
    window_set_fullscreen(win, !cur)
}

fn decode_bytes(b64: &str) -> Result<Vec<u8>, String> {
    let bytes = B64.decode(b64).map_err(|_| "Datos no válidos".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BLOB_BYTES {
        return Err("Datos no válidos".into());
    }
    Ok(bytes)
}

#[tauri::command]
fn sram_save(app: AppHandle, key: String, data_base64: String) -> Result<(), String> {
    if !valid_key(&key) {
        return Err("Clave no válida".into());
    }
    let bytes = decode_bytes(&data_base64)?;
    write_atomic(&sram_path(&app, &key)?, &bytes).map_err(|e| e.to_string())
}
#[tauri::command]
fn sram_load(app: AppHandle, key: String) -> Result<Option<String>, String> {
    if !valid_key(&key) {
        return Err("Clave no válida".into());
    }
    match fs::read(sram_path(&app, &key)?) {
        Ok(bytes) => Ok(Some(B64.encode(bytes))),
        Err(_) => Ok(None),
    }
}
#[tauri::command]
fn state_save(app: AppHandle, key: String, slot: i64, data_base64: String) -> Result<(), String> {
    if !valid_key(&key) || !valid_slot(slot) {
        return Err("Parámetros no válidos".into());
    }
    let bytes = decode_bytes(&data_base64)?;
    write_atomic(&state_path(&app, &key, slot)?, &bytes).map_err(|e| e.to_string())
}
#[tauri::command]
fn state_load(app: AppHandle, key: String, slot: i64) -> Result<Option<String>, String> {
    if !valid_key(&key) || !valid_slot(slot) {
        return Err("Parámetros no válidos".into());
    }
    match fs::read(state_path(&app, &key, slot)?) {
        Ok(bytes) => Ok(Some(B64.encode(bytes))),
        Err(_) => Ok(None),
    }
}

// ---------- Ayudantes invocados desde el menú nativo (src/menu.rs) ----------

/// Igual que el comando `rom_open_dialog`, pero invocable directamente desde Rust
/// (el clic de menú "Abrir ROM…" no pasa por el mecanismo `invoke`).
pub(crate) async fn rom_open_dialog_internal(app: AppHandle) -> Result<(), String> {
    if let Some(path) = pick_rom_path(&app).await {
        open_rom(&app, path, true).await?;
    }
    Ok(())
}

fn with_config_mut(app: &AppHandle, f: impl FnOnce(&mut AppConfig)) {
    let state = app.state::<AppState>();
    let mut cfg = state.config.lock().unwrap();
    f(&mut cfg);
    let snapshot = cfg.clone();
    drop(cfg);
    save_config(app, &snapshot);
    menu::rebuild(app, &snapshot);
    let _ = app.emit("config:changed", &snapshot);
}

pub(crate) fn config_clear_recent(app: &AppHandle) {
    with_config_mut(app, |cfg| cfg.recent.clear());
}
pub(crate) fn config_toggle_view(app: &AppHandle, which: &str) {
    with_config_mut(app, |cfg| match which {
        "integer-scale" => cfg.view.integer_scale = !cfg.view.integer_scale,
        "pixelated" => cfg.view.pixelated = !cfg.view.pixelated,
        _ => {}
    });
}
pub(crate) fn config_set_aspect(app: &AppHandle, aspect: &str) {
    with_config_mut(app, |cfg| cfg.view.aspect = aspect.to_string());
}
pub(crate) fn config_toggle_gamepad(app: &AppHandle) {
    with_config_mut(app, |cfg| cfg.gamepad.enabled = !cfg.gamepad.enabled);
}
pub(crate) fn config_set_slot(app: &AppHandle, slot: i64) {
    if valid_slot(slot) {
        with_config_mut(app, |cfg| cfg.slot = slot);
    }
}
pub(crate) fn open_recent_by_index(app: &AppHandle, index: usize) {
    let path = {
        let state = app.state::<AppState>();
        let cfg = state.config.lock().unwrap();
        cfg.recent.get(index).cloned()
    };
    if let Some(path) = path {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = open_rom(&app, path, true).await;
        });
    }
}

// ---------- Arranque ----------
fn main() {
    run();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            if let Some(path) = rom_from_args(&argv) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_rom(&app, path, true).await;
                });
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config: Mutex::new(AppConfig::default()),
            pending_rom: Mutex::new(None),
            closing: AtomicBool::new(false),
            flush_tx: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            flush_done,
            rom_open_dialog,
            rom_open_path,
            config_set,
            window_set_fullscreen,
            window_toggle_fullscreen,
            sram_save,
            sram_load,
            state_save,
            state_load,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = load_config(&handle);
            *app.state::<AppState>().config.lock().unwrap() = cfg.clone();
            menu::rebuild(&handle, &cfg);

            if let Some(win) = app.get_webview_window("main") {
                if cfg.window.maximized {
                    let _ = win.maximize();
                } else {
                    let _ = win.set_size(tauri::LogicalSize::new(cfg.window.width, cfg.window.height));
                }
            }

            // ROM inicial: argumento de línea de comandos o roms/game.nes junto al ejecutable.
            let args: Vec<String> = std::env::args().collect();
            let arg_rom = rom_from_args(&args);
            let first = arg_rom.clone().map(PathBuf::from).or_else(auto_rom_path);
            if let Some(path) = first {
                match read_rom_file(&path.to_string_lossy()) {
                    Ok(rom) => {
                        *app.state::<AppState>().pending_rom.lock().unwrap() = Some(rom);
                        if let Some(p) = &arg_rom {
                            let app_state = app.state::<AppState>();
                            let mut c = app_state.config.lock().unwrap();
                            c.recent.retain(|r| r != p);
                            c.recent.insert(0, p.clone());
                            c.recent.truncate(config::MAX_RECENT);
                            let snap = c.clone();
                            drop(c);
                            save_config(&handle, &snap);
                            menu::rebuild(&handle, &snap);
                        }
                    }
                    Err(e) => eprintln!("ROM inicial no válida: {e}"),
                }
            }

            if let Some(win) = app.get_webview_window("main") {
                let win2 = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = win2.state::<AppState>();
                        if state.closing.swap(true, Ordering::SeqCst) {
                            return; // segunda vez: dejar que se cierre de verdad
                        }
                        api.prevent_close();
                        let win3 = win2.clone();
                        tauri::async_runtime::spawn(async move {
                            request_flush(win3.app_handle()).await;
                            let cfg_snapshot = {
                                let state = win3.state::<AppState>();
                                let mut cfg = state.config.lock().unwrap();
                                if let Ok(maximized) = win3.is_maximized() {
                                    cfg.window.maximized = maximized;
                                    if !maximized {
                                        if let Ok(size) = win3.inner_size() {
                                            cfg.window.width = size.width;
                                            cfg.window.height = size.height;
                                        }
                                    }
                                }
                                cfg.clone()
                            };
                            save_config(win3.app_handle(), &cfg_snapshot);
                            let _ = win3.close();
                        });
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error al iniciar NES Player");
}
