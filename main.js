'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { DEFAULTS, SLOTS, MAX_RECENT, clone, sanitize, applyPatch, findDuplicates } = require('./lib/config');

const APP_NAME = 'NES Player';
const ORIGIN = 'app://local/';
const ROM_EXT = ['.nes', '.zip'];
const MAX_ROM_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const DEVTOOLS = !app.isPackaged || process.env.NES_DEVTOOLS === '1';

// Esquema propio app:// para servir la interfaz y EmulatorJS (fetch/XHR/WASM funcionan
// mucho mejor que con file://).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

let win = null;
let config = sanitize({});
let pendingRom = null;
let rendererReady = false;
let initialLoad = Promise.resolve();
let flushWaiter = null;
let closing = false;
let saveTimer = null;

// ---------- Rutas de datos (carpeta de usuario) ----------
const userDir = () => app.getPath('userData');
const cfgFile = () => path.join(userDir(), 'config.json');
const sramFile = (key) => path.join(userDir(), 'saves', `${key}.sram`);
const stateFile = (key, slot) => path.join(userDir(), 'states', `${key}.slot${slot}.state`);
const iconPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(__dirname, 'assets', 'icon.ico'));

async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function loadConfig() {
  try {
    config = sanitize(JSON.parse(await fsp.readFile(cfgFile(), 'utf8')));
  } catch {
    config = sanitize({});
  }
}
async function saveConfigNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await writeAtomic(cfgFile(), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('No se pudo guardar config.json:', err);
  }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfigNow, 300);
}

// ---------- Utilidades ----------
const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};
const sendConfig = () => send('config:changed', config);
const validKey = (k) => typeof k === 'string' && /^[a-f0-9]{16}$/.test(k);
const validSlot = (s) => Number.isInteger(s) && s >= 1 && s <= SLOTS;
const toBuffer = (b) => {
  if (!ArrayBuffer.isView(b) || b.byteLength === 0 || b.byteLength > MAX_BLOB_BYTES) throw new Error('Datos no válidos');
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
};

// ---------- ROMs ----------
function romFromArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).find((a) => ROM_EXT.includes(path.extname(a).toLowerCase()) && fs.existsSync(a)) || null;
}
function autoRomPath() {
  const dirs = [process.env.PORTABLE_EXECUTABLE_DIR, path.dirname(process.execPath), app.isPackaged ? null : app.getAppPath(), process.cwd()].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, 'roms', 'game.nes');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
async function readRom(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Ruta no válida');
  if (!ROM_EXT.includes(path.extname(p).toLowerCase())) throw new Error('Solo se admiten archivos .nes o .zip');
  const st = await fsp.stat(p);
  if (!st.isFile()) throw new Error('No es un archivo');
  if (st.size > MAX_ROM_BYTES) throw new Error('Archivo demasiado grande');
  const data = await fsp.readFile(p);
  const key = crypto.createHash('sha1').update(data).digest('hex').slice(0, 16);
  return { name: path.basename(p), path: p, key, data };
}

function flushRenderer() {
  if (!win || win.isDestroyed() || !rendererReady) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { flushWaiter = null; resolve(); }, 1500);
    flushWaiter = () => { clearTimeout(t); flushWaiter = null; resolve(); };
    send('app:flush');
  });
}

async function openRom(p, { remember = true } = {}) {
  try {
    const rom = await readRom(p);
    if (remember) {
      config.recent = [p, ...config.recent.filter((r) => r !== p)].slice(0, MAX_RECENT);
      scheduleSave();
      rebuildMenu();
    }
    await flushRenderer(); // guarda la SRAM del juego actual antes de cambiar
    pendingRom = rom;
    // EmulatorJS no permite descargar un core limpiamente: se recarga la página.
    if (rendererReady && win) win.webContents.reloadIgnoringCache();
  } catch (err) {
    config.recent = config.recent.filter((r) => r !== p);
    scheduleSave();
    rebuildMenu();
    dialog.showErrorBox(APP_NAME, `No se pudo abrir la ROM:\n${err.message}`);
  }
}

async function openRomDialog() {
  const start = config.recent[0] ? path.dirname(config.recent[0]) : undefined;
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir ROM de NES',
    defaultPath: start,
    properties: ['openFile'],
    filters: [{ name: 'ROMs de NES (.nes, .zip)', extensions: ['nes', 'zip'] }, { name: 'Todos los archivos', extensions: ['*'] }]
  });
  if (!r.canceled && r.filePaths[0]) await openRom(r.filePaths[0]);
}

// ---------- Ventana / menú ----------
function setFullscreen(v) {
  if (win && !win.isDestroyed()) win.setFullScreen(!!v);
}
function setView(patch) {
  config = applyPatch(config, { view: patch });
  scheduleSave();
  sendConfig();
  rebuildMenu();
}

function rebuildMenu() {
  const act = (action) => () => send('menu:action', { action });
  const recent = config.recent.length
    ? config.recent.map((p) => ({ label: `${path.basename(p)}   (${path.basename(path.dirname(p))})`, click: () => openRom(p) }))
    : [{ label: '(vacío)', enabled: false }];

  const template = [
    {
      label: 'Archivo',
      submenu: [
        { label: 'Abrir ROM…', accelerator: 'CmdOrCtrl+O', click: openRomDialog },
        {
          label: 'Archivos recientes',
          submenu: [...recent, { type: 'separator' }, { label: 'Borrar lista', enabled: config.recent.length > 0, click: () => { config.recent = []; scheduleSave(); rebuildMenu(); } }]
        },
        { type: 'separator' },
        { label: 'Guardar estado', click: act('save-state') },
        { label: 'Cargar estado', click: act('load-state') },
        {
          label: 'Ranura de estado',
          submenu: Array.from({ length: SLOTS }, (_, i) => i + 1).map((n) => ({
            label: `Ranura ${n}`, type: 'radio', checked: config.slot === n,
            click: () => { config = applyPatch(config, { slot: n }); scheduleSave(); sendConfig(); rebuildMenu(); }
          }))
        },
        { label: 'Guardar partida (SRAM) ahora', click: act('save-sram') },
        { type: 'separator' },
        { label: 'Salir', role: 'quit' }
      ]
    },
    {
      label: 'Vista',
      submenu: [
        { label: 'Pantalla completa (F11)', click: () => setFullscreen(!win.isFullScreen()) },
        { type: 'separator' },
        { label: 'Escalado por enteros', type: 'checkbox', checked: config.view.integerScale, click: (mi) => setView({ integerScale: mi.checked }) },
        { label: 'Pixelado nítido', type: 'checkbox', checked: config.view.pixelated, click: (mi) => setView({ pixelated: mi.checked }) },
        {
          label: 'Relación de aspecto',
          submenu: [
            { label: '4:3 (televisor)', type: 'radio', checked: config.view.aspect === '4:3', click: () => setView({ aspect: '4:3' }) },
            { label: 'Píxeles cuadrados (256:240)', type: 'radio', checked: config.view.aspect === 'square', click: () => setView({ aspect: 'square' }) }
          ]
        },
        ...(DEVTOOLS ? [{ type: 'separator' }, { label: 'Herramientas de desarrollo', role: 'toggleDevTools' }] : [])
      ]
    },
    {
      label: 'Controles',
      submenu: [
        { label: 'Configurar teclado…', click: act('open-controls') },
        {
          label: 'Mando (Gamepad)', type: 'checkbox', checked: config.gamepad.enabled,
          click: (mi) => { config = applyPatch(config, { gamepad: { enabled: mi.checked } }); scheduleSave(); sendConfig(); }
        },
        { type: 'separator' },
        { label: 'Pausa / Reanudar', click: act('pause') },
        { label: 'Reiniciar juego', click: act('reset') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    useContentSize: true,
    minWidth: 400,
    minHeight: 300,
    title: APP_NAME,
    icon: iconPath(),
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: DEVTOOLS
    }
  });
  if (config.window.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', (e) => e.preventDefault());

  win.on('enter-full-screen', () => { win.setMenuBarVisibility(false); send('window:fullscreen', true); });
  win.on('leave-full-screen', () => { win.setMenuBarVisibility(true); send('window:fullscreen', false); });

  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      setFullscreen(!win.isFullScreen());
    }
  });

  win.on('close', (e) => {
    if (win.isDestroyed()) return;
    config.window.maximized = win.isMaximized();
    if (!win.isMaximized() && !win.isFullScreen()) {
      const [w, h] = win.getContentSize();
      config.window.width = w;
      config.window.height = h;
    }
    if (closing) return;
    e.preventDefault();
    closing = true;
    flushRenderer().then(saveConfigNow).finally(() => win.close());
  });
  win.on('closed', () => { win = null; });

  win.loadURL(ORIGIN + 'index.html');
}

// ---------- Protocolo app:// ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.data': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8'
};
// 'unsafe-eval' / 'wasm-unsafe-eval': el core WASM de EmulatorJS (Emscripten) podría necesitarlos.
// Todo el contenido es local; puedes probar a quitar 'unsafe-eval' cuando confirmes que no hace falta.
const CSP = [
  "default-src 'none'",
  "script-src 'self' app://local 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "style-src 'self' app://local 'unsafe-inline'",
  "img-src 'self' app://local data: blob:",
  "media-src 'self' app://local blob:",
  "font-src 'self' app://local data:",
  "connect-src 'self' app://local blob: data:",
  "worker-src 'self' app://local blob:",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function registerAppProtocol() {
  const root = path.join(__dirname, 'src');
  protocol.handle('app', async (request) => {
    try {
      let rel = decodeURIComponent(new URL(request.url).pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const abs = path.normalize(path.join(root, rel));
      if (!abs.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      const buf = await fsp.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': String(buf.length), 'Cache-Control': 'no-store' };
      if (ext === '.html') headers['Content-Security-Policy'] = CSP;
      return new Response(buf, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------- IPC (solo desde nuestra página) ----------
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith(ORIGIN)) throw new Error('Remitente no autorizado');
    return fn(...args);
  });
}

function registerIpc() {
  handle('app:ready', async () => {
    await initialLoad;
    rendererReady = true;
    const rom = pendingRom;
    pendingRom = null;
    if (win && rom) win.setTitle(`${APP_NAME} — ${rom.name}`);
    else if (win) win.setTitle(APP_NAME);
    return { config, defaults: clone(DEFAULTS), rom };
  });
  handle('rom:open-dialog', () => openRomDialog());
  handle('rom:open-path', (p) => openRom(p));

  handle('config:set', (patch) => {
    const next = applyPatch(config, patch);
    if (findDuplicates(next).length) throw new Error('Hay teclas duplicadas');
    config = next;
    scheduleSave();
    rebuildMenu();
    sendConfig();
    return config;
  });

  handle('window:toggle-fullscreen', () => setFullscreen(!win.isFullScreen()));
  handle('window:set-fullscreen', (v) => setFullscreen(v));

  handle('sram:save', async (key, bytes) => {
    if (!validKey(key)) throw new Error('Clave no válida');
    await writeAtomic(sramFile(key), toBuffer(bytes));
  });
  handle('sram:load', async (key) => {
    if (!validKey(key)) throw new Error('Clave no válida');
    try { return await fsp.readFile(sramFile(key)); } catch { return null; }
  });
  handle('state:save', async (key, slot, bytes) => {
    if (!validKey(key) || !validSlot(slot)) throw new Error('Parámetros no válidos');
    await writeAtomic(stateFile(key, slot), toBuffer(bytes));
  });
  handle('state:load', async (key, slot) => {
    if (!validKey(key) || !validSlot(slot)) throw new Error('Parámetros no válidos');
    try { return await fsp.readFile(stateFile(key, slot)); } catch { return null; }
  });

  ipcMain.on('app:flush-done', (event) => {
    if (event.senderFrame && event.senderFrame.url.startsWith(ORIGIN) && flushWaiter) flushWaiter();
  });
}

// ---------- Arranque ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      const p = romFromArgs(argv);
      if (p) openRom(p);
    }
  });

  app.whenReady().then(async () => {
    await loadConfig();
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    registerAppProtocol();
    registerIpc();
    rebuildMenu();

    // ROM inicial: argumento de línea de comandos o roms/game.nes junto al proyecto/ejecutable.
    const argRom = romFromArgs(process.argv);
    const first = argRom || autoRomPath();
    if (first) {
      initialLoad = readRom(first)
        .then((rom) => {
          pendingRom = rom;
          if (argRom) {
            config.recent = [argRom, ...config.recent.filter((r) => r !== argRom)].slice(0, MAX_RECENT);
            rebuildMenu();
          }
        })
        .catch((err) => console.error('ROM inicial no válida:', err.message));
    }
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
