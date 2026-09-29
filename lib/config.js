'use strict';
// Lógica de configuración pura (sin Electron) para poder probarla con Node.

const DEFAULTS = Object.freeze({
  keys: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'KeyX', b: 'KeyZ', start: 'Enter', select: 'ShiftRight' },
  shortcuts: { saveState: 'F5', loadState: 'F7', pause: 'KeyP', reset: 'KeyR' },
  view: { integerScale: false, pixelated: true, aspect: '4:3' },
  gamepad: { enabled: true },
  slot: 1,
  recent: [],
  window: { width: 1024, height: 768, maximized: false }
});

const SLOTS = 4;
const MAX_RECENT = 10;
const ASPECTS = ['4:3', 'square'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const isCode = (v) => typeof v === 'string' && v.length > 0 && v.length <= 32 && /^[A-Za-z0-9_+\-]+$/.test(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function sanitize(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = clone(DEFAULTS);
  for (const g of ['keys', 'shortcuts']) {
    if (src[g] && typeof src[g] === 'object') {
      for (const k of Object.keys(DEFAULTS[g])) if (isCode(src[g][k])) out[g][k] = src[g][k];
    }
  }
  if (src.view && typeof src.view === 'object') {
    if (typeof src.view.integerScale === 'boolean') out.view.integerScale = src.view.integerScale;
    if (typeof src.view.pixelated === 'boolean') out.view.pixelated = src.view.pixelated;
    if (ASPECTS.includes(src.view.aspect)) out.view.aspect = src.view.aspect;
  }
  if (src.gamepad && typeof src.gamepad.enabled === 'boolean') out.gamepad.enabled = src.gamepad.enabled;
  if (isInt(src.slot, 1, SLOTS)) out.slot = src.slot;
  if (Array.isArray(src.recent)) {
    out.recent = [...new Set(src.recent.filter((p) => typeof p === 'string' && p.length < 1024))].slice(0, MAX_RECENT);
  }
  if (src.window && typeof src.window === 'object') {
    if (isInt(src.window.width, 320, 10000)) out.window.width = src.window.width;
    if (isInt(src.window.height, 240, 10000)) out.window.height = src.window.height;
    if (typeof src.window.maximized === 'boolean') out.window.maximized = src.window.maximized;
  }
  return out;
}

// El renderer solo puede cambiar keys, shortcuts, view, gamepad y slot.
function applyPatch(current, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = clone(current);
  for (const g of ['keys', 'shortcuts', 'view', 'gamepad']) {
    if (p[g] && typeof p[g] === 'object') Object.assign(merged[g], p[g]);
  }
  if ('slot' in p) merged.slot = p.slot;
  return sanitize(merged);
}

// Devuelve los códigos de tecla repetidos entre mando y atajos.
function findDuplicates(cfg) {
  const count = new Map();
  for (const g of ['keys', 'shortcuts']) {
    for (const code of Object.values(cfg[g])) count.set(code, (count.get(code) || 0) + 1);
  }
  return [...count].filter(([, n]) => n > 1).map(([code]) => code);
}

module.exports = { DEFAULTS, SLOTS, MAX_RECENT, ASPECTS, clone, sanitize, applyPatch, findDuplicates };
