# Desktop app

The desktop build is a Tauri 2 shell around the same web editor. The UI is the
bundle produced by `apps/web`; the shell adds two native pieces:

| Piece | JS name | Purpose |
|---|---|---|
| `src-tauri/src/usb.rs` | `window.__TAURI__.core.invoke` | libusb transport for the POD Go (`usb_open`, `usb_read`, `usb_write`, …). |
| `src-tauri/src/files.rs` | `window.podgoDesktopFiles` | Native save dialog for exports (`save_file`). |

The transport mirrors the Android bridge: one reader thread owns the IN
endpoint and queues replies, event frames (`0x03F0 → 0x1002`) are dropped
before they reach the page, and writes travel through the same thread so the
libusb handle is never shared. The POD Go protocol and every write gate stay in
the shared WASM flows, so desktop behaves exactly like WebUSB and Android.

> **Hardware status.** The desktop transport has **not** been run against a real
> POD Go yet. Reads and writes keep the same gates as the other shells:
> `device-write`, one explicit confirmation and one "Enable writing" arm. Mobile
> and desktop USB traffic still needs a real-device check.

## Prerequisites

- Rust 1.82 or newer.
- Node 22 (the same version as CI).
- Linux only: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`,
  `libayatana-appindicator3-dev`, `patchelf`, `pkg-config` and `libusb-1.0-0-dev`.
- Windows: bind the pedal to WinUSB (Zadig or the Line 6 driver) before
  libusb can claim it.
- Linux: install the udev rule from the repository root so the pedal is
  writable without root:

  ```sh
  sudo cp 99-podgo.rules /etc/udev/rules.d/
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

## Build and run

The shell embeds `apps/web/dist` at compile time, so build the web bundle first:

```sh
cd apps/web
npm ci
npm run build

cd ../desktop/src-tauri
cargo run
```

`cargo check` is enough to compile-check the shell; CI runs it on Linux for
every pull request.

## Packaging

Install the Tauri CLI once, then bundle for the current OS:

```sh
cargo install tauri-cli --version '^2'
cd apps/desktop/src-tauri
cargo tauri build
```

`tauri.conf.json` lists only `icons/icon.png` (the Android launcher artwork).
Run `cargo tauri icon <source.png>` to generate the `.ico`, `.icns` and sized
PNGs before producing Windows or macOS installers; Linux uses the PNG directly.

Sign Windows binaries and notarize macOS builds before publishing. The release
checklist lives in `docs/development/releasing.md`.

## Tests

The browser suite drives the shell's command surface with a fake
`window.__TAURI__` bridge (`apps/web/tests/usb.spec.ts`): one test reads both
setlists through `usb_open`/`usb_write`/`usb_read`, another exports a preset
through `save_file`. A real-device run is still required before claiming
support.
