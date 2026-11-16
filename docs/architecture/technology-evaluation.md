# Technology evaluation

Status: accepted.
Method: compare against the requirements in `requirements.md`, not popularity.

## 1. Core language: Rust

**Decision:** Rust.

Reasons: memory safety for untrusted binary parsing, strong typing for the
domain model, first-class WASM target, mature FFI tooling (UniFFI), good
cross-compilation, and no GC pauses during streaming. Alternatives (C++,
TypeScript everywhere, Go, Swift/Kotlin shared logic) either lose safety, lose
WASM ergonomics, or fail the single-core goal.

Risks: steeper learning curve; longer compile times; async ecosystem choices.

## 2. Web UI

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| React + TypeScript | Huge ecosystem, accessibility tooling, test libraries | Bundle size, dependency churn | **Chosen** |
| Svelte | Small bundles, simple reactivity | Smaller ecosystem | Viable alternative |
| Vue | Good DX | Similar to React, no decisive edge | Not chosen |
| Leptos/Yew/Dioxus | Single language | WASM size, smaller ecosystem, weaker a11y patterns | Watch list |
| Plain TS | Minimal deps | Reinventing state/UI | No |

**Decision:** React + TypeScript + Vite, with a strict content-security policy.
The UI is a thin shell over a WASM API; all logic lives in Rust.

## 3. WASM boundary

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| `wasm-bindgen` + `web-sys` | Standard, typed WebUSB bindings | Generated glue, size | **Chosen** |
| `wasm-pack` | Convenient packaging | Extra tool, not installed here | Chosen as packaging tool |
| Raw `extern "C"` | Minimal | Manual memory/JS glue | Only for measurement |
| `wasmtime` in browser | N/A | Not a browser runtime | No |

**Decision:** `wasm-bindgen` with a narrow, versioned API. WebUSB is behind a
feature flag so the same WASM builds for offline-only browsers.

## 4. Browser USB

**Decision:** WebUSB for Chromium-based browsers; feature-detect and degrade to
offline mode elsewhere. WebUSB cannot work on Safari/Firefox; this is a
documented platform limitation, not a bug.

## 5. Desktop shell

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Tauri 2 | Small binaries, Rust backend, reuse web UI, native USB via rusb | WebView differences, signing setup | **Chosen** |
| Electron | Mature | Large binaries, Node dependency, weaker Rust integration | No |
| egui | Pure Rust, fast | UI rewrite, accessibility gaps | No |
| Native per OS | Best fidelity | 3× UI cost | No |

**Decision:** Tauri 2 reusing the web UI; `rusb` (libusb) for the native
transport. The official Windows client already relies on WinUSB/libusb, which
reduces driver risk.

## 6. Native USB

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| `rusb` | libusb binding, cross-platform, matches official | Needs libusb/udev/WinUSB setup | **Chosen** |
| `nusb` | Pure Rust, async | Younger, less field experience | Watch list |
| `hidapi` | Simple | Device is vendor bulk, not HID | Not applicable |
| Platform APIs directly | No dependency | 3× transport code | Only for mobile adapters |

## 7. Mobile

**Android:** Kotlin shell + UniFFI. `UsbManager`/`UsbDeviceConnection` provides
permission, attach/detach and bulk transfers; bytes are handed to the Rust
session through a generated FFI. This is the only reliable route because Android
USB Host is not exposed to Rust without JNI/NDK plumbing.

**iOS:** Swift shell + UniFFI. Direct vendor USB is **not** available to
third-party apps through public APIs in the way libusb needs; ExternalAccessory
requires MFi program membership and device support. CoreMIDI/Network MIDI may
control the device if it exposes a class-compliant MIDI interface. The app is
therefore **offline-first** on iOS, with any MIDI transport added only after
hardware verification.

## 8. State management and UI state

| Option | Verdict |
|---|---|
| Redux Toolkit | **Chosen** for predictable undo/redo and command log |
| Zustand | Simpler but weaker audit trail |
| XState | Good for connection state, overkill for editing |
| Signals | Framework-specific |

The connection state machine lives in Rust (`podgo-session`), not in the UI.
UI state (selection, panels, dialogs) lives in React.

## 9. Storage

| Platform | Choice | Reason |
|---|---|---|
| Web | IndexedDB via a small repository interface | No backend, large presets |
| Native | SQLite (bundled) or atomic JSON files | Queryable, durable |
| Mobile | SQLite | Same schema as native |

**Decision:** define a `PresetRepository` trait; provide IndexedDB (WASM) and
SQLite (native/mobile) implementations. Export always produces portable files.

## 10. Serialization

- On-wire: a purpose-built MessagePack subset codec that preserves raw bytes and
  key order. Generic `serde`/`rmp-serde` would normalize maps and lose unknown
  ordering, so it is used only for the typed `.pgp`/`.pgb` JSON layer.
- Files: `serde_json` with explicit schemas; unknown fields retained via
  `serde_json::Value` side-tables or a raw-preserving wrapper.
- Versioning: an explicit `schema_version` on stored documents with migrations.

## 11. Testing and CI

- `cargo test`, `cargo clippy -D warnings`, `cargo fmt --check`.
- `proptest` for codecs, `cargo-fuzz`/`libFuzzer` for parsers.
- `wasm-bindgen-test` in headless Chromium for WebUSB mocks.
- Playwright for UI flows that do not need hardware.
- `cargo-audit`, `cargo-deny`, `cargo-llvm-cov`.

## 12. Rejected options (summary)

- Electron: binary size and Node attack surface.
- Full native UIs: 3× maintenance for no protocol benefit.
- `serde`-only wire model: loses unknown-field byte fidelity.
- Cloud backend: violates the offline/no-backend requirement.
- Firmware update support: unsafe and out of scope.
