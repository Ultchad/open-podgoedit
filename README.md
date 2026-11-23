# Open POD Go Edit

An **unofficial**, open-source, cross-platform editor and preset manager for the
Line 6 POD Go, built around a reusable **Rust core**.

He was inspired by the project [openpodgo](https://github.com/agarat/openpodgo)

> **Not affiliated with Line 6 or Yamaha Guitar Group.** "Line 6", "POD Go",
> "POD Go Edit" and "Helix" are trademarks of their respective owners and are
> used only to describe interoperability. See [NOTICE](NOTICE) and
> [docs/reverse-engineering/legal-notes.md](docs/reverse-engineering/legal-notes.md).

## Disclaimer

- **Unofficial.** This project is not made, endorsed, sponsored or supported by
  Line 6 or Yamaha Guitar Group, and it is **not linked to** the official
  POD Go Edit software in any way.
- **Use at your own risk.** The software is provided "as is", without warranty
  of any kind. The author is **not responsible** for any damage to your pedal,
  its firmware, your presets or any other data, nor for any loss arising from
  its use.
- **Keep a backup.** Before editing a preset on the pedal, export a full backup
  from POD Go Edit. With a pedal connected every edit is written to it
  immediately; Save stores the preset in its slot.
- Some features (device writes, restore, `.pgb` export) are inferred from
  observation and are not all validated on hardware. See the
  [roadmap](docs/roadmap.md) for the evidence level of each feature.

The [open-podgoedit](https://ultchad.github.io/open-podgoedit/) website runs entirely in your browser (only Chromium-based browsers are supported)

## Status

Phase 1 (analysis and architecture) is documented in
[`docs/`](docs/). Phase 2 (read-only proof of concept) is in progress. The
workspace contains the transport-independent `podgo-domain`, `podgo-protocol`,
`podgo-session` and `podgo-transport` crates, a shared `podgo-test-support`
crate, and an offline `podgo-probe` CLI. The full plan is in the
[roadmap](docs/roadmap.md).

**Device writes are opt-in and gated.** This build sends `set_param`
(operation 30, one continuous effect parameter of the active preset),
`save_preset` (operation 71, metadata only, User setlist), and a full backup /
restore (`.pgbak` container plus streamed operation 5). All of it is compiled
behind the `device-write` feature and enabled at runtime only after the user
arms writes. `set_param` is hardware-validated; save and restore are not. See
[docs/protocol/writes.md](docs/protocol/writes.md).

## Goals

- Connect to a POD Go, identify it, and read presets, setlists, blocks,
  parameters and device state.
- Edit and organize presets and setlists offline.
- Import `.pgp` presets and `.pgb` backups, edit a preset offline and export
  it back as `.pgp`, or rebuild the backup as `.pgb` with untouched members
  copied byte-for-byte.
- Synchronize with the device, detect device-side changes, undo/redo locally.
- Preserve unknown fields byte-for-byte across read/modify/write cycles.
- Run entirely without a backend or cloud service.
- Share one Rust core across web (WASM), desktop (Tauri), Android and iOS.

## Planned targets

| Target | Transport | Status |
|---|---|---|
| Web (Chromium) | WebUSB + WASM | Planned |
| Web (Safari/Firefox) | offline only | Planned |
| Windows | libusb / WinUSB via Tauri | Preview, unvalidated on hardware |
| macOS | libusb via Tauri | Preview, unvalidated on hardware |
| Linux | libusb + udev rule via Tauri | Preview, unvalidated on hardware |
| Android | USB Host (native bridge) via WebView | Beta, unvalidated on hardware |
| iOS/iPadOS | offline first; direct vendor USB unverified | Planned |

See [docs/architecture/platform-support-matrix.md](docs/architecture/platform-support-matrix.md)
for the honest, evidence-backed matrix.

## Documentation map

| Area | Start here |
|---|---|
| Roadmap | [phases and exit criteria](docs/roadmap.md) |
| Reverse engineering | [repository-inventory](docs/reverse-engineering/repository-inventory.md) |
| Protocol | [protocol specification](docs/reverse-engineering/protocol-specification.md) |
| Architecture | [requirements](docs/architecture/requirements.md) |
| Decisions | [ADRs](docs/architecture/decision-records/) |
| Development | [setup](docs/development/setup.md) |
| Android | [build, USB bridge and releases](docs/development/android.md) |
| Users | [device connection](docs/user/device-connection.md) |

## Building

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The core crates currently use **only the Rust standard library**, so they build
offline. Platform crates add their own dependencies later.

## Trying the read-only core

`podgo-probe` parses a raw `l6-helix` preset blob and verifies that a local
re-encode is byte-identical. With `--setlist`, it parses a captured streamed
setlist and prints entries in slot order. It never opens a USB device.

```sh
cargo run -p podgo-cli -- fixtures/spec02_obj22_blob.bin
cargo run -p podgo-cli -- --setlist fixtures/user_setlist.bin
```

Exit code `0` means the blob parsed and round-tripped exactly; `1` means the
blob is malformed or the round-trip differs (do not write it back); `2` is a
usage error.

The full manual test checklist, including Docker, WASM and hardware-capture
steps, is in
[docs/development/manual-testing-todo.md](docs/development/manual-testing-todo.md).

The web UI can also be served from the root `Dockerfile` (Rust → WASM → Node →
nginx):

```sh
docker compose up --build   # http://127.0.0.1:8080
```

The `.github/workflows/ci.yml` workflow runs the Rust formatting, Clippy and
offline tests, the WASM host tests, the TypeScript build and the Playwright
browser suite on pull requests and pushes to `dev`/`main`. The
`.github/workflows/pages.yml` workflow publishes the same static build to
GitHub Pages on every push to `main`.

## Local web app

A React + Vite page runs the Rust core in WebAssembly and presents a
POD Go Edit–style editor: Factory/User librarian, signal chain, parameter
inspector and model catalog. In Chrome or Edge it can also open the POD Go
through WebUSB and read a Factory or User setlist, or the active preset
(object 23, then object 22). Reads are validated by automated fake-device tests
plus recorded setlist reads on a POD Go Wireless (firmware 2.50). With the
pedal connected, a continuous effect parameter can be changed as you drag it
(op 30, RAM only) and the active preset stored with Save (op 71). **Full backup / restore** downloads a
self-checking `.pgbak` of both setlists and every non-empty slot, and can stream
it back with operation 5 after verifying the file in Rust and showing a
destination diff, followed by one explicit confirmation. Restore is destructive
and has not
been validated on hardware yet. **Import .pgp / .pgb…** opens POD Go Edit's own
preset export or full backup and renders the chain. A preset opened this way can
be renamed and its continuous parameters edited in the page, then downloaded
with **Export .pgp**; the export keeps every field it does not understand. It
cannot be written to the pedal, because the JSON is not the `l6-helix` body. The
file stays in the browser tab and is never uploaded or saved.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130
cd apps/web
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Click **Connect** (the same button turns into
**Disconnect** while a pedal is open), select the Line 6
device, then **Read User**, **Read Factory** or **Read active preset**. After a
setlist read, click any preset in the librarian to open that slot's chain
without recalling it on the pedal. Reads are always safe; writes stay off until
you arm them. Details, tests and troubleshooting are in
[apps/web/README.md](apps/web/README.md).

## License

MIT. See [LICENSE](LICENSE).
