# NES Player (escritorio, Windows) — versión Tauri

Misma app que la versión Electron (mismo `src/index.html` + `styles.css` + `renderer.js`,
casi sin cambios), pero con el proceso principal reescrito en **Rust + Tauri 2** en vez de
Node. El motivo de este cambio: el .exe pesa mucho menos porque usa **WebView2** (ya viene
en Windows 10/11) en vez de empaquetar su propio Chromium+Node como hace Electron.

## ⚠️ Aviso de verificación (importante, léelo antes de nada)

La versión Electron la compilé y probé de verdad en este entorno: la ejecuté con Electron
real bajo Linux/xvfb, cargué una ROM, pulsé teclas, guardé/cargué estados, cambié de
escalado, etc., y until vi capturas de pantalla funcionando.

**Con esta versión Tauri no he podido hacer lo mismo.** Este entorno no tiene Windows, ni
GTK/WebKit2GTK (necesarios para compilar el backend de Tauri en Linux), ni una versión de
Rust lo bastante reciente (aquí solo hay 1.75 vía `apt`; Tauri 2.12 pide 1.95+). Así que:

- **`src-tauri/src/config.rs`** sí lo compilé y le pasé pruebas unitarias de forma aislada
  (sin las dependencias de Tauri) — funciona.
- **`main.rs` y `menu.rs`** (toda la integración con Tauri: menú nativo, diálogo de
  archivo, ventana, eventos) **no se han compilado ni ejecutado**. Están escritos con el
  cuidado que puedo tener sin poder comprobarlos, usando la API de Tauri 2.12 tal como la
  recuerdo, pero es razonable que al primer `cargo build` en Windows salgan uno o varios
  errores de compilación (nombre de método distinto, tipo de retorno distinto, etc.).
  Los puntos con más riesgo de ese tipo de error, por si tienes que tocarlos:
  - `FileDialogBuilder::blocking_pick_file()` y cómo se extrae la ruta del `FilePath`
    devuelto (`rom_open_dialog_internal` / `rom_open_dialog` en `main.rs`).
  - Los métodos exactos del menú (`MenuItem::with_id`, `CheckMenuItem::with_id`,
    `Submenu::with_items`, `app.on_menu_event`) en `menu.rs`.
  - `WebviewWindow::unminimize()`, `.eval()`, `.is_fullscreen()`.
- El **frontend** (`src/*.js|html|css`) es casi idéntico al de Electron, así que hereda la
  confianza de esas pruebas, salvo `tauri-bridge.js` (nuevo, sin probar) y el bloque de
  arrastrar y soltar de `renderer.js` (reescrito para el modelo de Tauri).
- El tamaño final del .exe (ver más abajo) es una **estimación**, no una medida real.

Dicho de otro modo: la versión Electron (`nes-player.zip` que te pasé antes) es la que sé
con certeza que funciona. Esta es la que pesa menos, pero probablemente necesite algún
ajuste al compilarla por primera vez en GitHub Actions o en tu PC. Si prefieres no arriesgar,
quédate con la de Electron; si el peso del .exe es la prioridad, esta es el camino, pero
cuenta con una primera vuelta de arreglos.

## Por qué pesa menos

| | Electron | Tauri |
|---|---|---|
| Motor de ventana | Chromium propio empaquetado (~130–150 MB) | WebView2 del sistema (no se empaqueta) |
| Runtime | Node.js empaquetado | Binario nativo de Rust |
| .exe portable (estimado) | ~80–110 MB | ~5–12 MB |
| Instalador NSIS (estimado) | ~70–100 MB | ~4–10 MB |

Los números de Tauri son estimaciones típicas para una app así de sencilla; no los he
medido en este proyecto porque no he podido compilarlo aquí. El primer build en GitHub
Actions te dará el tamaño real (mira el paso "Localizar artefactos" del workflow).

Nota: el .exe suelto de `target/release/nes-player.exe` **debería** funcionar ya como
"portable" sin nada más al lado — Tauri incrusta los archivos de `frontendDist` (esta
carpeta `src/`, con EmulatorJS incluido) dentro del propio binario al compilar en modo
release. Esto no está verificado con un build real, pero es el comportamiento estándar de
Tauri, así que el workflow simplemente copia y renombra ese .exe como "portable".

## Qué cambia respecto a la versión Electron

- `main.js` + `preload.js` (Node) → `src-tauri/src/{main.rs, config.rs, menu.rs}` (Rust).
- El menú (Archivo, Vista, Controles) es nativo de Tauri en vez de `Menu.buildFromTemplate`.
- Guardado (config/SRAM/estados) en `app_data_dir` igual que antes, pero implementado en
  Rust; los datos binarios viajan como Base64 entre Rust y JS (Tauri no tiene un
  equivalente directo al `Buffer`/`ArrayBuffer` que usaba el IPC de Electron aquí).
- Arrastrar y soltar: Tauri lo captura a nivel de ventana y entrega rutas de archivo
  reales directamente (mejor que Electron, que necesitaba `webUtils.getPathForFile`).
- Sin `preload.js`: Tauri no tiene Node en el proceso de renderizado en absoluto (ni con
  `contextIsolation`, simplemente no existe), así que la superficie de ataque es aún menor
  que en Electron. La comunicación sigue pasando solo por comandos con nombre concretos
  (`#[tauri::command]`), nunca por una API genérica de sistema de archivos.
- Sin `localStorage`/`sessionStorage` para datos propios, igual que antes.
- **No portable de un clic con dos targets como electron-builder**: Tauri en Windows genera
  un instalador NSIS; el "portable" aquí es simplemente el .exe de `target/release` copiado
  tal cual (ver nota de arriba).

## Estructura

```
src-tauri/Cargo.toml, build.rs, tauri.conf.json, icons/icon.ico
src-tauri/src/main.rs     Comandos, ventana, guardado, ciclo de vida
src-tauri/src/config.rs   Configuración (compilado y probado de forma aislada)
src-tauri/src/menu.rs     Menú nativo Archivo/Vista/Controles
src/                      Mismo frontend que la versión Electron
src/tauri-bridge.js       Nuevo: implementa window.nes usando la API de Tauri
scripts/prepare-emulatorjs.js   Igual que en Electron (copia EmulatorJS a src/vendor)
scripts/make_icon.py            Igual que en Electron (PNG -> .ico), y copia a src-tauri/icons/
.github/workflows/build.yml     CI en windows-latest: Rust + Node + tauri build
```

## Compilar y probar en local (Windows)

Necesitas: Node 20, [Rust](https://rustup.rs) (`rustup default stable`) y las
["Herramientas de compilación de C++" de Visual Studio](https://tauri.app/start/prerequisites/)
(prerequisito estándar de Tauri en Windows). WebView2 ya viene en Windows 10/11.

```
npm install
npm run dev       # prepara EmulatorJS y abre la app en modo desarrollo
npm run build     # genera src-tauri/target/release/bundle/nsis/*.exe (instalador)
                   # y src-tauri/target/release/nes-player.exe (portable)
```

Icono: sustituye `assets/icon-source.png` por la portada de Lunar Pool y ejecuta
`npm run make-icon` (usa `scripts/make_icon.py`, igual que en la versión Electron, y
además copia el resultado a `src-tauri/icons/icon.ico`).

## GitHub Actions

`.github/workflows/build.yml`: push a `main` o manual. Instala Node 20 y Rust estable,
prepara EmulatorJS, compila con `tauri build` y sube el instalador NSIS y el .exe portable
como artefactos. **No lo he ejecutado** — es razonable que la primera vuelta necesite algún
ajuste si `cargo build` falla por alguno de los puntos señalados arriba.

## Guardado, atajos, teclado, ROM automática

Igual que en la versión Electron (mismo `renderer.js`): F11/doble clic para pantalla
completa, F5/F7 guardar/cargar estado, P pausa, R reiniciar, Ctrl+O abrir, arrastrar y
soltar, `roms/game.nes` automática junto al ejecutable, teclado configurable con detección
de duplicados y restaurar valores por defecto, SRAM y save states en la carpeta de datos
de usuario. Ver el README de la versión Electron para el detalle completo de esa parte del
comportamiento — es el mismo código.

## Riesgos y limitaciones (además del aviso de verificación de arriba)

- **Sin firma de código**: SmartScreen avisará igual que con el .exe de Electron.
- **WebView2**: si algún Windows muy antiguo o muy recortado no lo tiene instalado, el
  instalador NSIS por defecto (`webviewInstallMode` no especificado = descarga el
  bootstrapper) necesitará internet en el PC de destino la primera vez. Es infrecuente
  hoy en día (viene con Windows 11 y se distribuye por Windows Update en Windows 10), pero
  es una diferencia frente a Electron, que no depende de nada externo.
- **Licencias**: igual que en la versión Electron, EmulatorJS/fceumm son GPL.
- **fceumm/EmulatorJS dentro de WebView2**: no he podido comprobar que el core WASM
  funcione igual de bien en WebView2 que en el Chromium de Electron (donde sí lo probé).
  Debería funcionar — WebView2 es Chromium también — pero es otro punto sin verificar aquí.
