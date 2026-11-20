# Android app

The Android app is a thin WebView shell around the same web editor. The Rust
core still runs as WASM; the shell adds three native pieces:

| Piece | JS name | Purpose |
|---|---|---|
| `MainActivity` | — | Serves the bundle from `assets/` under a virtual HTTPS origin and handles the system back button. |
| `PodgoUsbBridge` | `window.podgoAndroidUsb` | USB host transport for the POD Go. |
| `PodgoFileBridge` | `window.podgoAndroidFiles` | Saves exports into the app's Downloads folder. |

Nothing is downloaded at runtime: the APK contains the whole app, and the
service worker opts out on the shell origin.

> **Hardware status.** The Android USB transport is exercised in the browser
> test suite through a fake bridge (`tests/usb.spec.ts`). It has **not** been
> run against a real POD Go on an Android device yet, so treat reads and every
> write path as unvalidated on hardware, like the WebUSB ones. Writes keep the
> same gates: `device-write`, one explicit confirmation and one "Enable
> writing" arm.

## Why a virtual HTTPS origin

WASM instantiation, module scripts and `crypto.subtle` need a secure context,
and a `file://` page is not one. The activity uses `WebViewAssetLoader` with the
host `appassets.androidplatform.net`, so the page runs at
`https://appassets.androidplatform.net/www/index.html` while every byte comes
from the APK. Off-origin links open in the system browser.

## USB transport

`PodgoUsbBridge` claims the Line 6 vendor interface (`0x0e41:0x4247` /
`0x0e41:0x424b`) and moves bulk packets only; frames are built and parsed by the
same WASM flows as on the web. One reader thread owns the IN endpoint and
appends packets to a queue:

- `open()` finds the pedal, asks for USB permission once, claims the interface.
- `write(base64)` sends one OUT transfer.
- `read(timeoutMs)` returns the next packet (or several, newline-joined) and
  `null` on timeout. Event frames (`0x03F0 → 0x1002`) are dropped natively so
  they can never replace a pending reply.
- `discard()` and `close()` clear the queue and release the interface.

On the page, `src/usb/bridge.ts` exposes these as a `PodgoConnection` with the
same `request`/`send`/`readWrite`/`readRead` surface as WebUSB.

## Building locally

Requirements: JDK 17+, Android SDK with platform 35 and build-tools 35.0.0,
Node 22, Rust with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.130.

```sh
npm --prefix apps/web run build          # wasm + fixtures + vite → apps/web/dist
node apps/android/tools/sync-web-assets.mjs
cd apps/android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release-unsigned.apk
```

Without the signing variables the APK is unsigned but installable with
`adb install -r app-release-unsigned.apk`. The version comes from
`PODGO_VERSION_NAME` (default `0.1.0`).

## Signing

The release workflow signs the APK when these repository secrets exist:

| Secret | Value |
|---|---|
| `PODGO_KEYSTORE_BASE64` | `base64 -w0 podgo-release.jks` |
| `PODGO_KEYSTORE_PASSWORD` | keystore password |
| `PODGO_KEY_ALIAS` | key alias |
| `PODGO_KEY_PASSWORD` | key password |

Create the keystore once and keep it out of the repository
(`apps/android/.gitignore` already excludes `*.jks` and `*.keystore`):

```sh
keytool -genkeypair -v -keystore podgo-release.jks -alias podgo \
  -keyalg RSA -keysize 4096 -validity 10000
```

Losing this keystore means future releases cannot update an installed app;
back it up somewhere private.

## Releasing

```sh
git switch main && git pull
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` then:

1. builds the web bundle with a relative base (`VITE_BASE=./`),
2. copies it into the app and builds `assembleRelease` on JDK 21,
3. publishes a GitHub Release with `podgo-editor-<version>.apk` and
   `podgo-editor-<version>-web.zip`, and the current `[Unreleased]` changelog
   entries as release notes.

`Actions → Release → Run workflow` does the same for an arbitrary version
without a tag, with an optional pre-release flag.
