//! Construye el menú nativo (Archivo, Vista, Controles) y despacha sus clics.
//! Se reconstruye entero cada vez que cambia la configuración (recientes, marcas de
//! verificación, ranura activa), igual que `rebuildMenu()` en la versión Electron.
//! Aviso: no compilado (ver nota al principio de main.rs).

use crate::config::{AppConfig, SLOTS};
use std::path::Path;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

fn action_item(app: &AppHandle, id: &str, label: &str, accel: Option<&str>) -> MenuItem<tauri::Wry> {
    MenuItem::with_id(app, id, label, true, accel).expect("menu item")
}

pub fn rebuild(app: &AppHandle, cfg: &AppConfig) {
    let menu = build(app, cfg).expect("no se pudo construir el menú");
    let _ = app.set_menu(menu);
}

fn build(app: &AppHandle, cfg: &AppConfig) -> tauri::Result<Menu<tauri::Wry>> {
    // ---- Archivo ----
    let open = action_item(app, "open", "Abrir ROM…", Some("CmdOrCtrl+O"));

    let recent_items: Vec<MenuItem<tauri::Wry>> = if cfg.recent.is_empty() {
        vec![MenuItem::with_id(app, "recent-empty", "(vacío)", false, None::<&str>)?]
    } else {
        cfg.recent
            .iter()
            .enumerate()
            .map(|(i, path)| {
                let base = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path);
                let dir = Path::new(path)
                    .parent()
                    .and_then(|d| d.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                let label = format!("{base}   ({dir})");
                MenuItem::with_id(app, format!("recent:{i}"), label, true, None::<&str>).expect("menu item")
            })
            .collect()
    };
    let mut recent_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = recent_items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    let sep1 = PredefinedMenuItem::separator(app)?;
    let clear_recent = MenuItem::with_id(app, "recent-clear", "Borrar lista", !cfg.recent.is_empty(), None::<&str>)?;
    recent_refs.push(&sep1);
    recent_refs.push(&clear_recent);
    let recent_menu = Submenu::with_items(app, "Archivos recientes", true, &recent_refs)?;

    let save_state = action_item(app, "save-state", "Guardar estado", None);
    let load_state = action_item(app, "load-state", "Cargar estado", None);

    let slot_items: Vec<CheckMenuItem<tauri::Wry>> = (1..=SLOTS)
        .map(|n| {
            CheckMenuItem::with_id(app, format!("slot:{n}"), format!("Ranura {n}"), true, cfg.slot == n, None::<&str>)
                .expect("menu item")
        })
        .collect();
    let slot_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = slot_items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    let slot_menu = Submenu::with_items(app, "Ranura de estado", true, &slot_refs)?;

    let save_sram = action_item(app, "save-sram", "Guardar partida (SRAM) ahora", None);
    let quit = PredefinedMenuItem::quit(app, Some("Salir"))?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let file_menu = Submenu::with_items(
        app,
        "Archivo",
        true,
        &[
            &open,
            &recent_menu,
            &sep2,
            &save_state,
            &load_state,
            &slot_menu,
            &save_sram,
            &sep3,
            &quit,
        ],
    )?;

    // ---- Vista ----
    let fullscreen = action_item(app, "fullscreen", "Pantalla completa (F11)", None);
    let sep4 = PredefinedMenuItem::separator(app)?;
    let integer_scale = CheckMenuItem::with_id(app, "integer-scale", "Escalado por enteros", true, cfg.view.integer_scale, None::<&str>)?;
    let pixelated = CheckMenuItem::with_id(app, "pixelated", "Pixelado nítido", true, cfg.view.pixelated, None::<&str>)?;
    let aspect_43 = CheckMenuItem::with_id(app, "aspect:4:3", "4:3 (televisor)", true, cfg.view.aspect == "4:3", None::<&str>)?;
    let aspect_sq = CheckMenuItem::with_id(app, "aspect:square", "Píxeles cuadrados (256:240)", true, cfg.view.aspect == "square", None::<&str>)?;
    let aspect_menu = Submenu::with_items(app, "Relación de aspecto", true, &[&aspect_43, &aspect_sq])?;

    let view_menu = Submenu::with_items(app, "Vista", true, &[&fullscreen, &sep4, &integer_scale, &pixelated, &aspect_menu])?;

    // ---- Controles ----
    let open_controls = action_item(app, "open-controls", "Configurar teclado…", None);
    let gamepad = CheckMenuItem::with_id(app, "gamepad", "Mando (Gamepad)", true, cfg.gamepad.enabled, None::<&str>)?;
    let sep5 = PredefinedMenuItem::separator(app)?;
    let pause = action_item(app, "pause", "Pausa / Reanudar", None);
    let reset = action_item(app, "reset", "Reiniciar juego", None);

    let controls_menu = Submenu::with_items(app, "Controles", true, &[&open_controls, &gamepad, &sep5, &pause, &reset])?;

    let menu = Menu::with_items(app, &[&file_menu, &view_menu, &controls_menu])?;

    // Despacho de clics. Como reconstruimos el menú entero en cada cambio de configuración,
    // basta con un único listener global (registrado la primera vez) que lee `event.id()`.
    let app_for_handler = app.clone();
    app.on_menu_event(move |app, event| {
        dispatch(app, event.id().0.as_str());
        let _ = &app_for_handler;
    });

    Ok(menu)
}

fn emit_action(app: &AppHandle, action: &str) {
    let _ = app.emit("menu:action", serde_json::json!({ "action": action }));
}

fn dispatch(app: &AppHandle, id: &str) {
    match id {
        "open" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::rom_open_dialog_internal(app).await;
            });
        }
        "save-state" => emit_action(app, "save-state"),
        "load-state" => emit_action(app, "load-state"),
        "save-sram" => emit_action(app, "save-sram"),
        "pause" => emit_action(app, "pause"),
        "reset" => emit_action(app, "reset"),
        "open-controls" => emit_action(app, "open-controls"),
        "fullscreen" => {
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(cur) = win.is_fullscreen() {
                    let _ = win.set_fullscreen(!cur);
                    let _ = win.emit("window:fullscreen", !cur);
                }
            }
        }
        "recent-clear" => crate::config_clear_recent(app),
        "integer-scale" | "pixelated" => crate::config_toggle_view(app, id),
        "aspect:4:3" => crate::config_set_aspect(app, "4:3"),
        "aspect:square" => crate::config_set_aspect(app, "square"),
        "gamepad" => crate::config_toggle_gamepad(app),
        other if other.starts_with("recent:") => {
            if let Ok(i) = other["recent:".len()..].parse::<usize>() {
                crate::open_recent_by_index(app, i);
            }
        }
        other if other.starts_with("slot:") => {
            if let Ok(n) = other["slot:".len()..].parse::<i64>() {
                crate::config_set_slot(app, n);
            }
        }
        _ => {}
    }
}
