# NES Player (escritorio, Windows)

Reproductor de ROMs de NES con **Electron + EmulatorJS (core `nes` = fceumm)**, HTML/CSS/JS puro.
Uso personal. No incluye ni descarga ROMs.

## Estructura

```
main.js                 Proceso principal: ventana, menú, IPC, protocolo app://, guardado
preload.js              Puente seguro (contextBridge) con lista blanca de canales
lib/config.js           Valores por defecto, validación y detección de teclas duplicadas
src/index.html|styles.css|renderer.js   Interfaz, entrada, escalado, guardado, ajustes
src/vendor/emulatorjs/  (generado, no versionado) motor + core nes
scripts/prepare-emulatorjs.js   Copia EmulatorJS y el core desde node_modules
scripts/make_icon.py            PNG -> assets/icon.ico (16, 32, 48, 64, 128, 256)
scripts/test-config.js          Prueba de la lógica de configuración
assets/icon-source.png|icon.ico Icono (ahora un marcador de posición: ver más abajo)
electron-builder.yml    NSIS + portable
.github/workflows/build.yml     CI en windows-latest, Node 20
roms/                   Opcional: roms/game.nes se carga al abrir (ignorada por git)
```

## Icono

`assets/icon-source.png` es un marcador de posición. Sustitúyelo por la portada de Lunar Pool
(cualquier PNG/JPG, cuadrado o no; se recorta al centro) y ejecuta:

```
pip install pillow
npm run make-icon          # o: python scripts/make_icon.py --fit pad   (rellena en vez de recortar)
```

En GitHub Actions el `.ico` se regenera solo si existe `assets/icon-source.png`. Se usa para el
ejecutable, el instalador y la ventana.

## Motor EmulatorJS (sin internet)

`scripts/prepare-emulatorjs.js` **no descarga desde una CDN**: copia los paquetes npm oficiales,
fijados a la versión 4.2.3 en `package.json`:

- `@emulatorjs/emulatorjs` → `data/` (loader, `src/*.js`, compresión, localización)
- `@emulatorjs/core-fceumm` → `fceumm-wasm.data` y `fceumm-legacy-wasm.data` (+ `reports/fceumm.json`)

Solo se copian las variantes sin hilos (las `thread` requieren SharedArrayBuffer y no hacen falta).
Se ejecuta con `npm start`, `npm run dist` y en el workflow. Tamaño en disco: ~3,5 MB (core ≈ 2 MB).
El .exe pesa sobre todo por Electron/Chromium: **espera ~80–110 MB** (portable) y algo menos el
instalador (medida real: mírala en el paso "Tamaños" del workflow).

## Compilar y probar en local

```
npm install
npm start            # prepara EmulatorJS y abre la app
npm test             # prueba de la configuración
npm run dist         # genera dist/NES-Player-Setup-*.exe y NES-Player-Portable-*.exe (en Windows)
```

En Windows sin "Modo desarrollador" o sin admin, `electron-builder` puede fallar al extraer
`winCodeSign` (enlaces simbólicos). Actívalo o compila con GitHub Actions.

## GitHub Actions

Se ejecuta en cada push a `main` y manualmente (Actions → Build Windows → Run workflow).
Sube dos artefactos: **NES-Player-Setup** (NSIS) y **NES-Player-Portable**. Usa `npm ci`,
por lo que `package-lock.json` debe estar en el repo.

## Uso

| Acción | Cómo |
|---|---|
| Abrir ROM | Ctrl+O, menú Archivo, arrastrar y soltar, recientes, argumento de línea de comandos |
| ROM automática | `roms/game.nes` junto al proyecto, al .exe instalado o al portable |
| Pantalla completa | F11 o doble clic en la pantalla · Esc sale |
| Guardar / cargar estado | F5 / F7 (ranura 1–4 en Archivo → Ranura de estado) |
| Pausa / Reiniciar | P / R |
| Teclado | Controles → Configurar teclado (mando NES + atajos, con detección de duplicados y restaurar) |
| Vista | Escalado por enteros, pixelado nítido, aspecto 4:3 o píxeles cuadrados |

Valores por defecto: flechas, **X** = A, **Z** = B, **Enter** = Start, **Shift derecho** = Select.
F11 y Esc (salir de pantalla completa) y Ctrl+O son fijos. Mando (Gamepad API): mapeo estándar,
D-pad o stick izquierdo, botones 0/2 = B, 1/3 = A, 8 = Select, 9 = Start (activable en Controles).

### Dónde se guarda todo

`app.getPath('userData')` (en Windows: `%APPDATA%\nes-player` o `%APPDATA%\NES Player`, según cómo se ejecute):

```
config.json                     teclas, atajos, vista, ranura, recientes, tamaño de ventana
saves/<hash-rom>.sram           partida en batería (SRAM), si el juego la tiene
states/<hash-rom>.slotN.state   save states
```

`<hash-rom>` es el SHA-1 (16 primeros caracteres) del archivo, por lo que renombrar la ROM no pierde el progreso.

## Seguridad

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; el preload solo expone funciones
concretas; los IPC comprueban que el remitente sea `app://local/`; permisos, ventanas nuevas y
navegación externa denegados; CSP en la página. No se usa `localStorage`/`sessionStorage` para datos
propios (EmulatorJS se lanza con `EJS_disableLocalStorage`).

## Riesgos y limitaciones conocidos

- **Verificación:** la prueba de humo (core cargando la ROM, teclas → botones NES, pausa, F5/F7 y
  archivos de estado, escalado 4:3/enteros, duplicados, diálogo de teclado, recarga de otra ROM,
  pantalla completa) se hizo con Electron 33 **en Linux bajo xvfb** con una ROM de prueba vacía.
  **No** se ha probado en Windows ni se ha generado el .exe: el primer build real está por comprobar.
- **Sin firma de código:** Windows SmartScreen avisará ("Windows protegió tu PC" → Más información →
  Ejecutar de todos modos). Un antivirus puede marcar falsos positivos en un .exe sin firmar.
- **SRAM:** solo existe si el juego tiene batería y el core la expone. Muchos juegos (posiblemente
  Lunar Pool) no la usan; ahí solo sirven los save states. La SRAM se guarda cada 15 s si cambia,
  al perder foco, al cambiar de ROM y al cerrar (con un máximo de espera de 1,5 s al cerrar).
  Si se mata el proceso a la fuerza se puede perder lo de los últimos segundos.
- **Save states:** dependen de la versión del core; un estado guardado con otra versión puede no cargar.
- **Pixelado:** RetroArch redimensiona el canvas a la ventana y escala con `video_smooth = false`
  (vecino más cercano); la casilla "Pixelado nítido" añade `image-rendering: pixelated` y su efecto
  visible puede ser mínimo. Con 4:3, "escalado por enteros" es entero en vertical (×240) pero la
  anchura no es múltiplo exacto de 256; para píxeles perfectamente uniformes usa "Píxeles cuadrados".
- **CSP:** incluye `'unsafe-eval'`/`'wasm-unsafe-eval'` por si el core WASM los necesita; el contenido
  es todo local. Puedes intentar quitar `'unsafe-eval'` en `main.js` y probar.
- **EmulatorJS en modo `EJS_DEBUG_XX`:** el paquete npm no trae `emulator.min.js`, así que se cargan
  los `src/*.js` sin minificar (unos 0,5 MB más). Funciona igual, con más mensajes en consola.
- **Cambiar de ROM recarga la ventana** (EmulatorJS no permite descargar un core limpiamente).
- **Un solo jugador** (puerto 1). Sin teclas para volumen/silencio; se usa el mezclador de Windows.
- **Licencias:** EmulatorJS y fceumm son GPL. Para uso personal no hay problema; si redistribuyes el
  .exe, tendrías que cumplir la GPL (ofrecer el código fuente).
- **Versiones:** Electron 33 y electron-builder 25 (probadas aquí). Hay versiones más nuevas; actualízalas
  cuando quieras y vuelve a probar.
- **DevTools:** desactivadas en el ejecutable empaquetado; para depurar: `set NES_DEVTOOLS=1` antes de lanzarlo.
