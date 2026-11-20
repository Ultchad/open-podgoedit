# Android app

The Android app is a thin WebView shell around the same web editor. The Rust
core still runs as WASM; the shell adds three native pieces:

| Piece | JS name | Purpose |
|---|---|---|
| `MainActivity` | — | Serves the bundle from `assets/` under a virtual HTTPS origin, handles the system back button, maps JS dialogs to native dialogs and opens the file picker. |
| `PodgoUsbBridge` | `window.podgoAndroidUsb` | USB host transport for the POD Go. |
| `PodgoFileBridge` | `window.podgoAndroidFiles` | Saves exports into the app's Downloads folder. |

Nothing is downloaded at runtime: the APK contains the whole app, and the
service worker opts out on the shell origin.

## Package name and existing installs

The installed application ID is `io.github.ultchad.openpodgoedit`, matching the
GitHub repository `Ultchad/open-podgoedit` (hyphens are not allowed in an
Android package name). The Kotlin namespace stays `dev.openpodgo.edit`, so the
source tree and imports are unchanged. Changing the application ID does **not**
require a new keystore or signing key; the same certificate signs the new
package.

Android treats the new ID as a different app. An existing install of
`dev.openpodgo.edit` is not upgraded in place: uninstall the old app once before
installing a build with the new ID. This also avoids the package installer
stalling on a package/signature mismatch when an earlier debug or
differently-signed build is still present.

If a sideloaded build still spins in the package installer, check the file first
(`unzip -t podgo-editor-<version>.apk`), confirm "install unknown apps" is
allowed for the file manager, and then try `adb install -r <file>.apk`. `adb`
reports the real error (for example `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, which
means an old build with a different signing key is still installed).

## WebView dialogs and file imports

`MainActivity` installs a `WebChromeClient` that maps `window.alert`,
`window.confirm` and `window.prompt` to native `AlertDialog`s and implements
`onShowFileChooser` with the Activity Result API. Without it the page's write
confirmations were silently dropped — Save, paste, rename and restore looked
like no-ops in the Android shell — and `Import…` could not open the system file
picker. Both behaviours are covered by the browser suite using a fake Android
bridge where possible; a real-device check is still pending.

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

The release workflow accepts either shape of repository secret:

**One secret** — simplest. Name it `ANDROID_KEYSTORE` and paste the contents of
a `key=value` file:

```
PODGO_KEYSTORE_BASE64=<base64 -w0 podgo-release.jks>
PODGO_KEYSTORE_PASSWORD=<keystore password>
PODGO_KEY_ALIAS=podgo
PODGO_KEY_PASSWORD=<key password>
```

**Four secrets** — the same values set individually:

| Secret | Value |
|---|---|
| `PODGO_KEYSTORE_BASE64` | `base64 -w0 podgo-release.jks` |
| `PODGO_KEYSTORE_PASSWORD` | keystore password |
| `PODGO_KEY_ALIAS` | key alias |
| `PODGO_KEY_PASSWORD` | key password |

The `Prepare signing` step decodes the keystore, opens it with `keytool` using
those credentials, and writes them to a `podgo-keystore.properties` file outside
the workspace; Gradle reads it through `PODGO_SIGNING_PROPERTIES`. Secrets are
registered with `::add-mask::` first, so passwords never appear in a step's
environment dump (v0.2.0 printed them in a public log; rotate that password).
A wrong password, alias or truncated base64 fails the run with `::error::`, so
a broken secret cannot silently produce an unsigned release; only the complete
absence of signing secrets falls back to an unsigned APK, with a warning.

For a local signed build, write the same four values to a properties file and
point `PODGO_SIGNING_PROPERTIES` at it:

```sh
PODGO_SIGNING_PROPERTIES=$HOME/.keystore/podgo-keystore.properties \
  ./gradlew assembleRelease
```

The base64 value must stay on one line. If you build the `key=value` file by
hand, no quoting is needed — values must not contain spaces or quotes.

Create the keystore once and keep it out of the repository (the root
`.gitignore` and `apps/android/.gitignore` both exclude `*.jks`, `*.keystore`
and `podgo-secrets.env`):

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
