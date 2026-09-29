//! Configuración persistente de la app (equivalente a lib/config.js de la versión Electron).
//! Se guarda como JSON en `app_data_dir/config.json`. Toda entrada que llega de fuera
//! (archivo en disco o parche desde el renderer) pasa por `sanitize`/`merge_patch`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const SLOTS: i64 = 4;
pub const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyMap {
    pub up: String,
    pub down: String,
    pub left: String,
    pub right: String,
    pub a: String,
    pub b: String,
    pub start: String,
    pub select: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shortcuts {
    #[serde(rename = "saveState")]
    pub save_state: String,
    #[serde(rename = "loadState")]
    pub load_state: String,
    pub pause: String,
    pub reset: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewCfg {
    #[serde(rename = "integerScale")]
    pub integer_scale: bool,
    pub pixelated: bool,
    pub aspect: String, // "4:3" | "square"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GamepadCfg {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowCfg {
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub keys: KeyMap,
    pub shortcuts: Shortcuts,
    pub view: ViewCfg,
    pub gamepad: GamepadCfg,
    pub slot: i64,
    pub recent: Vec<String>,
    pub window: WindowCfg,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            keys: KeyMap {
                up: "ArrowUp".into(),
                down: "ArrowDown".into(),
                left: "ArrowLeft".into(),
                right: "ArrowRight".into(),
                a: "KeyX".into(),
                b: "KeyZ".into(),
                start: "Enter".into(),
                select: "ShiftRight".into(),
            },
            shortcuts: Shortcuts {
                save_state: "F5".into(),
                load_state: "F7".into(),
                pause: "KeyP".into(),
                reset: "KeyR".into(),
            },
            view: ViewCfg { integer_scale: false, pixelated: true, aspect: "4:3".into() },
            gamepad: GamepadCfg { enabled: true },
            slot: 1,
            recent: Vec::new(),
            window: WindowCfg { width: 1024, height: 768, maximized: false },
        }
    }
}

fn is_code(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 32
        && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '+' || c == '-')
}

/// Aplica un JSON arbitrario (leído de disco o mandado por el renderer) sobre una
/// configuración base, ignorando/descartando cualquier campo no válido en vez de fallar.
pub fn sanitize(base: &AppConfig, incoming: &Value) -> AppConfig {
    let mut out = base.clone();
    let obj = match incoming.as_object() {
        Some(o) => o,
        None => return out,
    };

    if let Some(keys) = obj.get("keys").and_then(|v| v.as_object()) {
        macro_rules! set_key { ($field:ident, $name:literal) => {
            if let Some(s) = keys.get($name).and_then(|v| v.as_str()) {
                if is_code(s) { out.keys.$field = s.to_string(); }
            }
        }; }
        set_key!(up, "up"); set_key!(down, "down"); set_key!(left, "left"); set_key!(right, "right");
        set_key!(a, "a"); set_key!(b, "b"); set_key!(start, "start"); set_key!(select, "select");
    }
    if let Some(sc) = obj.get("shortcuts").and_then(|v| v.as_object()) {
        if let Some(s) = sc.get("saveState").and_then(|v| v.as_str()) { if is_code(s) { out.shortcuts.save_state = s.to_string(); } }
        if let Some(s) = sc.get("loadState").and_then(|v| v.as_str()) { if is_code(s) { out.shortcuts.load_state = s.to_string(); } }
        if let Some(s) = sc.get("pause").and_then(|v| v.as_str()) { if is_code(s) { out.shortcuts.pause = s.to_string(); } }
        if let Some(s) = sc.get("reset").and_then(|v| v.as_str()) { if is_code(s) { out.shortcuts.reset = s.to_string(); } }
    }
    if let Some(view) = obj.get("view").and_then(|v| v.as_object()) {
        if let Some(b) = view.get("integerScale").and_then(|v| v.as_bool()) { out.view.integer_scale = b; }
        if let Some(b) = view.get("pixelated").and_then(|v| v.as_bool()) { out.view.pixelated = b; }
        if let Some(s) = view.get("aspect").and_then(|v| v.as_str()) {
            if s == "4:3" || s == "square" { out.view.aspect = s.to_string(); }
        }
    }
    if let Some(gp) = obj.get("gamepad").and_then(|v| v.as_object()) {
        if let Some(b) = gp.get("enabled").and_then(|v| v.as_bool()) { out.gamepad.enabled = b; }
    }
    if let Some(n) = obj.get("slot").and_then(|v| v.as_i64()) {
        if (1..=SLOTS).contains(&n) { out.slot = n; }
    }
    if let Some(arr) = obj.get("recent").and_then(|v| v.as_array()) {
        let mut seen = HashMap::new();
        let mut list = Vec::new();
        for v in arr {
            if let Some(s) = v.as_str() {
                if s.len() < 1024 && !seen.contains_key(s) {
                    seen.insert(s.to_string(), ());
                    list.push(s.to_string());
                    if list.len() >= MAX_RECENT { break; }
                }
            }
        }
        out.recent = list;
    }
    if let Some(w) = obj.get("window").and_then(|v| v.as_object()) {
        if let Some(n) = w.get("width").and_then(|v| v.as_u64()) { if (320..=10000).contains(&n) { out.window.width = n as u32; } }
        if let Some(n) = w.get("height").and_then(|v| v.as_u64()) { if (240..=10000).contains(&n) { out.window.height = n as u32; } }
        if let Some(b) = w.get("maximized").and_then(|v| v.as_bool()) { out.window.maximized = b; }
    }
    out
}

/// Parches que puede mandar el renderer: solo keys/shortcuts/view/gamepad/slot
/// (recent y window los gestiona el proceso principal).
pub fn apply_patch(current: &AppConfig, patch: &Value) -> AppConfig {
    let mut merged = serde_json::to_value(current).unwrap();
    if let (Some(cur), Some(p)) = (merged.as_object_mut(), patch.as_object()) {
        for group in ["keys", "shortcuts", "view", "gamepad"] {
            if let Some(pg) = p.get(group).and_then(|v| v.as_object()) {
                if let Some(cg) = cur.get_mut(group).and_then(|v| v.as_object_mut()) {
                    for (k, v) in pg {
                        cg.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        if let Some(slot) = p.get("slot") {
            cur.insert("slot".to_string(), slot.clone());
        }
    }
    sanitize(current, &merged)
}

/// Códigos de tecla repetidos entre el mando NES y los atajos.
pub fn find_duplicates(cfg: &AppConfig) -> Vec<String> {
    let mut count: HashMap<String, u32> = HashMap::new();
    let codes = [
        &cfg.keys.up, &cfg.keys.down, &cfg.keys.left, &cfg.keys.right,
        &cfg.keys.a, &cfg.keys.b, &cfg.keys.start, &cfg.keys.select,
        &cfg.shortcuts.save_state, &cfg.shortcuts.load_state, &cfg.shortcuts.pause, &cfg.shortcuts.reset,
    ];
    for c in codes {
        *count.entry(c.clone()).or_insert(0) += 1;
    }
    count.into_iter().filter(|(_, n)| *n > 1).map(|(k, _)| k).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_have_no_duplicates() {
        assert!(find_duplicates(&AppConfig::default()).is_empty());
    }

    #[test]
    fn sanitize_rejects_bad_values() {
        let base = AppConfig::default();
        let out = sanitize(&base, &json!({ "keys": { "a": "KeyQ", "b": "<script>" }, "view": { "aspect": "raro" }, "slot": 99 }));
        assert_eq!(out.keys.a, "KeyQ");
        assert_eq!(out.keys.b, "KeyZ"); // valor inválido descartado -> se queda el de base
        assert_eq!(out.view.aspect, "4:3");
        assert_eq!(out.slot, 1);
    }

    #[test]
    fn recent_dedupes_and_caps() {
        let base = AppConfig::default();
        let out = sanitize(&base, &json!({ "recent": ["a", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] }));
        assert_eq!(out.recent.len(), MAX_RECENT);
    }

    #[test]
    fn patch_detects_duplicate() {
        let base = AppConfig::default();
        let out = apply_patch(&base, &json!({ "keys": { "a": "KeyZ" } }));
        assert_eq!(find_duplicates(&out), vec!["KeyZ".to_string()]);
    }
}
