'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Solo estos canales pueden llegar desde el proceso principal al renderer.
const EVENTS = new Set(['menu:action', 'config:changed', 'window:fullscreen', 'app:flush']);

contextBridge.exposeInMainWorld('nes', {
  // Arranque
  ready: () => ipcRenderer.invoke('app:ready'),
  flushDone: () => ipcRenderer.send('app:flush-done'),

  // ROMs
  openRomDialog: () => ipcRenderer.invoke('rom:open-dialog'),
  openRomPath: (p) => ipcRenderer.invoke('rom:open-path', p),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Configuración (archivo JSON en userData, gestionado por el proceso principal)
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // Ventana
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  setFullscreen: (v) => ipcRenderer.invoke('window:set-fullscreen', !!v),

  // Guardado (archivos en userData)
  saveSram: (key, bytes) => ipcRenderer.invoke('sram:save', key, bytes),
  loadSram: (key) => ipcRenderer.invoke('sram:load', key),
  saveState: (key, slot, bytes) => ipcRenderer.invoke('state:save', key, slot, bytes),
  loadState: (key, slot) => ipcRenderer.invoke('state:load', key, slot),

  // Eventos del proceso principal
  on: (channel, cb) => {
    if (!EVENTS.has(channel) || typeof cb !== 'function') return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  }
});
