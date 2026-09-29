'use strict';
// Copia EmulatorJS (motor) y el core "nes" (fceumm) desde node_modules a
// src/vendor/emulatorjs/data para que la app funcione sin internet.
// No descarga nada por su cuenta: usa los paquetes npm oficiales
// @emulatorjs/emulatorjs y @emulatorjs/core-fceumm (versión fijada en package.json).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules', '@emulatorjs');
const srcEngine = path.join(nm, 'emulatorjs');
const srcCore = path.join(nm, 'core-fceumm');
const dest = path.join(root, 'src', 'vendor', 'emulatorjs');
const destData = path.join(dest, 'data');
const destCores = path.join(destData, 'cores');

function fail(msg) {
  console.error('[prepare-emulatorjs] ERROR: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(path.join(srcEngine, 'data', 'loader.js'))) fail('Falta @emulatorjs/emulatorjs. Ejecuta "npm install".');
if (!fs.existsSync(path.join(srcCore, 'fceumm-wasm.data'))) fail('Falta @emulatorjs/core-fceumm. Ejecuta "npm install".');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(destCores, { recursive: true });

// Motor: todo "data/" salvo la carpeta cores (solo tiene metadatos del paquete).
const engineData = path.join(srcEngine, 'data');
fs.cpSync(engineData, destData, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(engineData, src);
    return rel !== 'cores' && !rel.startsWith('cores' + path.sep);
  }
});
for (const f of ['LICENSE', 'package.json']) {
  if (fs.existsSync(path.join(srcEngine, f))) fs.copyFileSync(path.join(srcEngine, f), path.join(dest, f === 'package.json' ? 'engine-package.json' : f));
}

// Core nes = fceumm. Solo las variantes sin hilos (las "thread" exigen
// SharedArrayBuffer/COOP+COEP y no hacen falta para NES).
//  - fceumm-wasm.data         -> WebGL2
//  - fceumm-legacy-wasm.data  -> respaldo si no hay WebGL2
for (const f of ['fceumm-wasm.data', 'fceumm-legacy-wasm.data']) {
  fs.copyFileSync(path.join(srcCore, f), path.join(destCores, f));
}
fs.mkdirSync(path.join(destCores, 'reports'), { recursive: true });
fs.copyFileSync(path.join(srcCore, 'reports', 'fceumm.json'), path.join(destCores, 'reports', 'fceumm.json'));

const need = [
  'loader.js', 'src/emulator.js', 'src/GameManager.js', 'src/storage.js', 'src/gamepad.js',
  'src/compression.js', 'src/shaders.js', 'src/socket.io.min.js', 'src/nipplejs.js', 'emulator.css',
  'compression/extract7z.js', 'compression/extractzip.js', 'compression/libunrar.js',
  'cores/fceumm-wasm.data', 'cores/fceumm-legacy-wasm.data', 'cores/reports/fceumm.json'
];
const missing = need.filter((f) => !fs.existsSync(path.join(destData, f)));
if (missing.length) fail('Faltan archivos tras copiar: ' + missing.join(', '));

const version = JSON.parse(fs.readFileSync(path.join(engineData, 'version.json'), 'utf8')).version;
fs.writeFileSync(path.join(dest, 'VERSION.txt'), `EmulatorJS ${version} (core: fceumm)\n`);

function size(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0);
}
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`[prepare-emulatorjs] EmulatorJS ${version} listo en src/vendor/emulatorjs`);
console.log(`  total: ${mb(size(dest))} | cores: ${mb(size(destCores))}`);
