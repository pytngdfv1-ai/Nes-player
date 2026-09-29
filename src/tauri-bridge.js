'use strict';
// Expone `window.nes` con la MISMA forma que preload.js en la versión Electron,
// para que src/renderer.js apenas tenga que cambiar. Por debajo usa los comandos
// Rust (`invoke`) y el sistema de eventos de Tauri (`window.__TAURI__`, activado
// con "app.withGlobalTauri": true en tauri.conf.json).
//
// Aviso: no se ha podido probar en un WebView2 real (solo se revisó a ojo).
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  function b64ToBytes(b64) {
    if (!b64) return null;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function romFromPayload(r) {
    if (!r) return null;
    return { name: r.name, path: r.path, key: r.key, data: b64ToBytes(r.dataBase64) };
  }

  const EVENTS = new Set(['menu:action', 'config:changed', 'window:fullscreen', 'app:flush']);
  const listeners = new Map();
  for (const ev of EVENTS) {
    listen(ev, (e) => { const cb = listeners.get(ev); if (cb) cb(e.payload); });
  }

  window.nes = {
    ready: async () => {
      const r = await invoke('app_ready');
      return { config: r.config, defaults: r.defaults, rom: romFromPayload(r.rom) };
    },
    flushDone: () => { invoke('flush_done').catch(() => {}); },

    openRomDialog: () => invoke('rom_open_dialog'),
    openRomPath: (p) => invoke('rom_open_path', { path: p }),

    setConfig: (patch) => invoke('config_set', { patch }),

    toggleFullscreen: () => invoke('window_toggle_fullscreen'),
    setFullscreen: (v) => invoke('window_set_fullscreen', { value: !!v }),

    saveSram: (key, bytes) => invoke('sram_save', { key, dataBase64: bytesToB64(bytes) }),
    loadSram: async (key) => b64ToBytes(await invoke('sram_load', { key })),
    saveState: (key, slot, bytes) => invoke('state_save', { key, slot, dataBase64: bytesToB64(bytes) }),
    loadState: async (key, slot) => b64ToBytes(await invoke('state_load', { key, slot })),

    on: (channel, cb) => { if (EVENTS.has(channel)) listeners.set(channel, cb); }
  };

  // Arrastrar y soltar: se usa la API oficial de ventana de Tauri (más fiable que
  // escuchar a mano el evento interno "tauri://drag-drop", que en la primera versión
  // no llegaba nunca al listener genérico). Se registra ya mismo (sin esperar a
  // DOMContentLoaded: este script va al final de <body>, así que ese evento ya pasó
  // por el momento en que se ejecuta este archivo; esperarlo dejaba el listener sin
  // registrarse nunca, que era el motivo real de que no funcionara).
  const ROM_EXT = ['.nes', '.zip'];
  const isRom = (p) => ROM_EXT.some((ext) => p.toLowerCase().endsWith(ext));
  (async () => {
    const dropEl = document.getElementById('dropzone');
    const getWin = (window.__TAURI__.webviewWindow && window.__TAURI__.webviewWindow.getCurrentWebviewWindow)
      || (window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow);
    if (!getWin) { console.error('nes: no se encontró la API de ventana de Tauri para arrastrar y soltar'); return; }
    await getWin().onDragDropEvent((e) => {
      const type = e.payload.type; // 'enter' | 'over' | 'drop' | 'leave'
      if (dropEl) dropEl.hidden = !(type === 'enter' || type === 'over');
      if (type === 'drop') {
        const rom = (e.payload.paths || []).find(isRom);
        if (rom) window.nes.openRomPath(rom);
      }
    });
  })();
})();
