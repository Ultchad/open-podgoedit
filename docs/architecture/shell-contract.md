# Shell contract

The web bundle is the UI for every platform. `apps/web` is built once and is
then embedded unchanged by each native shell:

| Consumer | How it gets the bundle | What it adds |
|---|---|---|
| Browser / PWA | served by Pages or any static host | nothing (WebUSB is built in) |
| Android app | `apps/android/tools/sync-web-assets.mjs` copies `apps/web/dist` into the APK assets | USB host transport, Downloads-folder save, file picker, native dialogs, back button |
| Desktop app (Tauri 2) | `build.frontendDist` in `tauri.conf.json` embeds `apps/web/dist` at compile time | libusb transport, native save dialog |

There is no platform-specific UI and no second version of the editor. A shell
is an adapter, not a fork. This is also why iOS is not planned: the UI would
embed fine, but WebKit exposes no WebUSB and the POD Go has no MFi path, so
there is no transport to adapt.

## What a shell may add

A shell implements only this surface; everything else stays in the bundle:

1. **USB transport** implementing `PodgoConnection`
   (`apps/web/src/usb/podgoUsb.ts`): `open`, `close`, `discard`, `write`,
   `read`, plus the device info the editor displays. The POD Go protocol,
   packet framing and every write gate live in the shared WASM flows.
2. **File save** for exports, when a `blob:` download is not enough
   (`window.podgoDesktopFiles` / `window.podgoAndroidFiles`).
3. **Platform glue**: file picker, native `alert`/`confirm`/`prompt`, the
   system back button (`window.__podgoBack`), and disabling the service worker
   on the shell origin.

Anything else that exists only in a shell is a bug: it could not be tested by
the browser suite and it would drift from the web app.

## Adapter version

`SHELL_API_VERSION` (`apps/web/src/shell.ts`) versions the adapter surface. It
changes only when a shell must implement something new or differently. The same
number appears in three places and CI keeps them equal:

| Place | Declaration |
|---|---|
| `apps/web/src/shell.ts` | `export const SHELL_API_VERSION = 1;` |
| `apps/android/.../PodgoUsbBridge.kt` | `const val API_VERSION = 1` |
| `apps/desktop/src-tauri/src/lib.rs` | `const SHELL_API_VERSION: u32 = 1;` |

`scripts/verify-shell-consumers.mjs` runs in CI after the web build. It fails
when the versions disagree, when the desktop `frontendDist` or the Android sync
source stops pointing at `apps/web/dist`, or when Pages stops building
`apps/web`.

## Startup handshake

On load, `checkShellBridge()` (`apps/web/src/shell.ts`) detects the shell and
asks it for its adapter version:

- **Android**: `window.podgoAndroidUsb.apiVersion()` (a `@JavascriptInterface`
  method, so it is synchronous).
- **Desktop**: the Tauri command `shell_api_version`.
- **Browser**: no shell, so the bundle and its adapter always match.

Capabilities are returned with the status:

| Field | Meaning |
|---|---|
| `kind` | `browser`, `android` or `desktop` |
| `pedal` | some transport can reach the pedal (not that one is connected) |
| `nativeSave` | exports use the shell's save path instead of a download |
| `installable` | the browser may offer an install prompt |

A shell whose reported version differs from `SHELL_API_VERSION` is **outdated**.
That is diagnostic, not fatal: the editor still loads, the page's `<main>`
exposes `data-shell` / `data-shell-outdated`, and the header shows an
**App update needed** chip. The condition is also written to the diagnostics
log. A missing version counts as outdated, which covers packages built before
the handshake existed.

## Adding another shell

1. Build the UI from `apps/web`; do not copy or rewrite it.
2. Implement `PodgoConnection` and inject it the same way the existing shells
   do, or add a transport branch to `apps/web/src/usb/index.ts`.
3. Report `SHELL_API_VERSION` from the shell and answer the handshake.
4. Add the shell to `scripts/verify-shell-consumers.mjs` if it ships a copy of
   the bundle.
5. Document its evidence tier in
   [`platform-support-matrix.md`](platform-support-matrix.md); a shell without
   a hardware pass is **Beta** or **Experimental**, never **Supported**.

## Tests

- `apps/web/tests/shell.spec.ts` covers a current Android shell, an outdated
  Android shell, a desktop shell that does not answer, and the browser.
- `apps/web/tests/usb.spec.ts` runs the real USB protocol through fake Android
  and desktop bridges.
- The shell contract itself is compile-checked in CI: Kotlin and Rust must
  build with the version constants above.
