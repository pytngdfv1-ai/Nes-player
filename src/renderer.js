'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), screen = $('screen'), toastEl = $('toast'), pauseEl = $('pause'), dropEl = $('dropzone'), settingsEl = $('settings');

  const DATA_PATH = 'app://local/vendor/emulatorjs/data/';
  // Índices de botón de RetroArch/EmulatorJS para NES.
  const NES = { b: 0, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8 };
  const KEY_LABELS = { up: 'Arriba', down: 'Abajo', left: 'Izquierda', right: 'Derecha', a: 'A', b: 'B', start: 'Start', select: 'Select' };
  const SHORTCUT_LABELS = { saveState: 'Guardar estado', loadState: 'Cargar estado', pause: 'Pausa', reset: 'Reiniciar' };
  const NAMED = {
    ArrowUp: '↑ Flecha arriba', ArrowDown: '↓ Flecha abajo', ArrowLeft: '← Flecha izquierda', ArrowRight: '→ Flecha derecha',
    Enter: 'Enter', NumpadEnter: 'Enter (numérico)', ShiftRight: 'Shift derecho', ShiftLeft: 'Shift izquierdo',
    ControlLeft: 'Ctrl izquierdo', ControlRight: 'Ctrl derecho', AltLeft: 'Alt izquierdo', AltRight: 'Alt derecho',
    Space: 'Espacio', Backspace: 'Retroceso', Tab: 'Tab', CapsLock: 'Bloq Mayús', Delete: 'Supr', Insert: 'Insert',
    Home: 'Inicio', End: 'Fin', PageUp: 'Re Pág', PageDown: 'Av Pág'
  };

  let cfg = null, defaults = null, rom = null, emu = null;
  let started = false, userPaused = false, pausedByModal = false, isFullscreen = false;
  let modalOpen = false, capturing = null, draft = null;
  let lastSramHash = null, layoutMap = null;
  const input = {};

  // ---------- Utilidades ----------
  let toastTimer;
  function toast(msg, ms = 1800) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }
  function hashBytes(b) { // FNV-1a
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function keyLabel(code) {
    if (!code) return '—';
    if (NAMED[code]) return NAMED[code];
    if (layoutMap && layoutMap.has(code)) return layoutMap.get(code).toUpperCase();
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
    return code;
  }
  function duplicates(d) {
    const count = new Map();
    for (const g of ['keys', 'shortcuts']) for (const c of Object.values(d[g])) count.set(c, (count.get(c) || 0) + 1);
    return [...count].filter(([, n]) => n > 1).map(([c]) => c);
  }

  // ---------- Pantalla: escalado 4:3, enteros, pixelado ----------
  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H || !cfg) return;
    const ar = cfg.view.aspect === 'square' ? 256 / 240 : 4 / 3;
    let w = 0, h = 0;
    if (cfg.view.integerScale) {
      const k = Math.floor(Math.min(H / 240, W / (240 * ar)));
      if (k >= 1) { h = 240 * k; w = Math.round(240 * ar * k); }
    }
    if (!w) {
      if (W / H > ar) { h = H; w = Math.round(H * ar); } else { w = W; h = Math.round(W / ar); }
    }
    screen.style.width = w + 'px';
    screen.style.height = h + 'px';
    if (emu && typeof emu.handleResize === 'function') { try { emu.handleResize(); } catch { /* ignorar */ } }
  }
  function applyView() {
    document.body.classList.toggle('pixelated', cfg.view.pixelated);
    layout();
  }
  new ResizeObserver(layout).observe(stage);

  let cursorTimer;
  function pokeCursor() {
    stage.classList.remove('hide-cursor');
    clearTimeout(cursorTimer);
    if (started && !modalOpen) cursorTimer = setTimeout(() => stage.classList.add('hide-cursor'), 2000);
  }
  stage.addEventListener('mousemove', pokeCursor);
  stage.addEventListener('dblclick', () => { if (!modalOpen) window.nes.toggleFullscreen(); }, true);

  // ---------- Entrada (teclado + mando) ----------
  function setInput(btn, source, down) {
    const s = input[btn] || (input[btn] = { kb: false, pad: false, sent: 0 });
    s[source] = down;
    const v = s.kb || s.pad ? 1 : 0;
    if (v !== s.sent) {
      s.sent = v;
      if (started && emu && emu.gameManager) { try { emu.gameManager.simulateInput(0, NES[btn], v); } catch { /* ignorar */ } }
    }
  }
  function releaseAll() { for (const b of Object.keys(NES)) { setInput(b, 'kb', false); setInput(b, 'pad', false); } }

  function btnForCode(code) { return Object.keys(NES).find((b) => cfg.keys[b] === code); }
  function shortcutForCode(code) { return Object.keys(SHORTCUT_LABELS).find((s) => cfg.shortcuts[s] === code); }

  window.addEventListener('keydown', (e) => {
    if (!cfg) return;
    e.stopImmediatePropagation(); // EmulatorJS no debe procesar teclado propio
    if (capturing) return onCapture(e);
    if (modalOpen) { if (e.code === 'Escape') { e.preventDefault(); closeSettings(); } return; }
    if (e.code === 'Escape') { if (isFullscreen) { e.preventDefault(); window.nes.setFullscreen(false); } return; }
    const sc = shortcutForCode(e.code);
    if (sc) { e.preventDefault(); if (!e.repeat) ({ saveState: doSaveState, loadState: doLoadState, pause: togglePause, reset: doReset })[sc](); return; }
    const b = btnForCode(e.code);
    if (b) { e.preventDefault(); if (!userPaused) setInput(b, 'kb', true); }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!cfg) return;
    e.stopImmediatePropagation();
    if (capturing || modalOpen) return;
    const b = btnForCode(e.code);
    if (b) { e.preventDefault(); setInput(b, 'kb', false); }
  }, true);
  window.addEventListener('blur', () => { releaseAll(); persistSram(false); });

  function padLoop() {
    requestAnimationFrame(padLoop);
    const st = { up: false, down: false, left: false, right: false, a: false, b: false, start: false, select: false };
    if (cfg && cfg.gamepad.enabled && !modalOpen && !userPaused && navigator.getGamepads) {
      const pad = Array.from(navigator.getGamepads() || []).find((p) => p && p.connected);
      if (pad) {
        const bt = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
        const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
        st.b = bt(0) || bt(2); st.a = bt(1) || bt(3);
        st.select = bt(8); st.start = bt(9);
        st.up = bt(12) || ay < -0.5; st.down = bt(13) || ay > 0.5;
        st.left = bt(14) || ax < -0.5; st.right = bt(15) || ax > 0.5;
      }
    }
    for (const b of Object.keys(st)) setInput(b, 'pad', st[b]);
  }
  window.addEventListener('gamepadconnected', (e) => { if (cfg && cfg.gamepad.enabled) toast('Mando conectado: ' + e.gamepad.id.slice(0, 40)); });

  // ---------- Emulador ----------
  function startRom(r) {
    rom = r;
    document.body.classList.add('playing');
    screen.hidden = false;
    layout();
    const file = new File([r.data], r.name, { type: 'application/octet-stream' });
    Object.assign(window, {
      EJS_player: '#game',
      EJS_core: 'nes',
      EJS_gameUrl: file,
      EJS_gameName: r.name.replace(/\.[^.]+$/, ''),
      EJS_pathtodata: DATA_PATH,
      EJS_DEBUG_XX: true,              // carga src/*.js (el paquete npm no trae emulator.min.js)
      EJS_startOnLoaded: true,
      EJS_disableLocalStorage: true,   // nada importante en localStorage
      EJS_noAutoFocus: true,
      EJS_language: 'es-ES',
      EJS_volume: 0.8,
      EJS_defaultControls: { 0: {}, 1: {}, 2: {}, 3: {} }, // el teclado lo gestionamos nosotros
      EJS_onGameStart: onGameStart
    });
    const s = document.createElement('script');
    s.src = DATA_PATH + 'loader.js';
    s.onerror = () => toast('No se pudo cargar EmulatorJS (¿falta npm run prepare-emulator?)', 6000);
    document.body.appendChild(s);
  }

  async function onGameStart() {
    emu = window.EJS_emulator;
    started = true;
    layout();
    pokeCursor();
    try { await restoreSram(); } catch (err) { console.warn('SRAM: no se pudo restaurar', err); }
    setInterval(() => persistSram(false), 15000);
  }

  function setCorePaused(p) {
    try {
      if (typeof emu.pause === 'function' && typeof emu.play === 'function') { if (p) emu.pause(); else emu.play(); }
      else emu.gameManager.toggleMainLoop(p ? 0 : 1);
    } catch (err) { console.warn('pausa', err); }
  }
  function togglePause() {
    if (!started) return;
    userPaused = !userPaused;
    setCorePaused(userPaused);
    pauseEl.hidden = !userPaused;
    if (userPaused) releaseAll();
  }
  function doReset() {
    if (!started) return;
    try { emu.gameManager.restart(); toast('Juego reiniciado'); } catch (err) { console.warn(err); }
  }

  // ---------- Guardado ----------
  async function restoreSram() {
    const data = await window.nes.loadSram(rom.key);
    if (!data || !data.length) return;
    const gm = emu.gameManager;
    const p = gm.getSaveFilePath();
    const parts = p.split('/');
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parts[i]) continue;
      cur += '/' + parts[i];
      if (!gm.FS.analyzePath(cur).exists) gm.FS.mkdir(cur);
    }
    if (gm.FS.analyzePath(p).exists) gm.FS.unlink(p);
    gm.FS.writeFile(p, new Uint8Array(data));
    gm.loadSaveFiles();
    lastSramHash = hashBytes(data);
    toast('Partida guardada cargada');
  }
  async function persistSram(force) {
    if (!started || !rom) return false;
    try {
      const d = emu.gameManager.getSaveFile(); // null si el juego no tiene batería
      if (!d || !d.length) return false;
      const h = hashBytes(d);
      if (!force && h === lastSramHash) return false;
      lastSramHash = h;
      await window.nes.saveSram(rom.key, new Uint8Array(d));
      return true;
    } catch (err) { console.warn('SRAM:', err); return false; }
  }
  async function doSaveState() {
    if (!started) return;
    try {
      const st = new Uint8Array(emu.gameManager.getState());
      await window.nes.saveState(rom.key, cfg.slot, st);
      toast(`Estado guardado (ranura ${cfg.slot})`);
    } catch (err) { console.warn(err); toast('No se pudo guardar el estado'); }
  }
  async function doLoadState() {
    if (!started) return;
    try {
      const st = await window.nes.loadState(rom.key, cfg.slot);
      if (!st) { toast(`Ranura ${cfg.slot} vacía`); return; }
      emu.gameManager.loadState(new Uint8Array(st));
      toast(`Estado cargado (ranura ${cfg.slot})`);
    } catch (err) { console.warn(err); toast('No se pudo cargar el estado'); }
  }

  // ---------- Diálogo de teclado ----------
  const groups = [['keys', KEY_LABELS, 'rows-keys'], ['shortcuts', SHORTCUT_LABELS, 'rows-shortcuts']];
  function renderSettings() {
    const dups = new Set(duplicates(draft));
    for (const [g, labels, boxId] of groups) {
      const box = $(boxId);
      box.textContent = '';
      for (const id of Object.keys(labels)) {
        const row = document.createElement('div');
        row.className = 'row';
        const name = document.createElement('span');
        name.textContent = labels[id];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'keybtn';
        const active = capturing === `${g}.${id}`;
        btn.textContent = active ? 'Pulsa una tecla…' : keyLabel(draft[g][id]);
        if (active) btn.classList.add('capturing');
        if (dups.has(draft[g][id])) btn.classList.add('dup');
        btn.addEventListener('click', () => { capturing = `${g}.${id}`; renderSettings(); });
        row.append(name, btn);
        box.append(row);
      }
    }
    $('pad-enabled').checked = draft.gamepad.enabled;
    $('dup-msg').hidden = dups.size === 0;
    $('btn-save').disabled = dups.size > 0;
  }
  function onCapture(e) {
    e.preventDefault();
    if (e.code === 'Escape') { capturing = null; renderSettings(); return; }
    if (!e.code || e.code === 'Unidentified' || /^(Meta|OS)/.test(e.code)) return;
    const [g, id] = capturing.split('.');
    draft[g][id] = e.code;
    capturing = null;
    renderSettings();
  }
  function openSettings() {
    if (!cfg || modalOpen) return;
    draft = { keys: { ...cfg.keys }, shortcuts: { ...cfg.shortcuts }, gamepad: { enabled: cfg.gamepad.enabled } };
    modalOpen = true;
    capturing = null;
    releaseAll();
    if (started && !userPaused) { pausedByModal = true; setCorePaused(true); }
    stage.classList.remove('hide-cursor');
    settingsEl.hidden = false;
    renderSettings();
  }
  function closeSettings() {
    modalOpen = false;
    capturing = null;
    settingsEl.hidden = true;
    if (pausedByModal) { pausedByModal = false; setCorePaused(false); }
    pokeCursor();
  }
  $('btn-cancel').addEventListener('click', closeSettings);
  $('btn-defaults').addEventListener('click', () => {
    draft.keys = { ...defaults.keys };
    draft.shortcuts = { ...defaults.shortcuts };
    capturing = null;
    renderSettings();
  });
  $('pad-enabled').addEventListener('change', (e) => { draft.gamepad.enabled = e.target.checked; });
  $('btn-save').addEventListener('click', async () => {
    try {
      cfg = await window.nes.setConfig({ keys: draft.keys, shortcuts: draft.shortcuts, gamepad: draft.gamepad });
      closeSettings();
      toast('Controles guardados');
    } catch (err) {
      $('dup-msg').textContent = 'No se pudo guardar: ' + err.message;
      $('dup-msg').hidden = false;
    }
  });

  // ---------- Arrastrar y soltar ----------
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropEl.hidden = false; }, true);
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.hidden = true; }, true);
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dropEl.hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    const p = window.nes.getPathForFile(f);
    if (p) window.nes.openRomPath(p); else toast('No se pudo obtener la ruta del archivo');
  }, true);

  // ---------- Eventos del proceso principal ----------
  window.nes.on('menu:action', ({ action }) => {
    ({
      'save-state': doSaveState,
      'load-state': doLoadState,
      'save-sram': async () => { toast((await persistSram(true)) ? 'Partida (SRAM) guardada' : 'Este juego no genera partida en batería'); },
      pause: togglePause,
      reset: doReset,
      'open-controls': openSettings
    })[action]?.();
  });
  window.nes.on('config:changed', (c) => { cfg = c; applyView(); });
  window.nes.on('window:fullscreen', (v) => { isFullscreen = !!v; layout(); });
  window.nes.on('app:flush', async () => {
    try { await persistSram(true); } finally { window.nes.flushDone(); }
  });

  // ---------- Arranque ----------
  (async () => {
    if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
      navigator.keyboard.getLayoutMap().then((m) => { layoutMap = m; if (modalOpen) renderSettings(); }).catch(() => {});
    }
    const r = await window.nes.ready();
    cfg = r.config;
    defaults = r.defaults;
    applyView();
    requestAnimationFrame(padLoop);
    if (r.rom) startRom(r.rom); else screen.hidden = true;
  })();
})();
