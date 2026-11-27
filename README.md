**▶ [Open the editor on GitHub Pages](https://ultchad.github.io/open-podgoedit/)**

# Open POD Go Edit

An **unofficial**, open-source, cross-platform editor and preset manager for the
Line 6 POD Go, built around a reusable **Rust core**. It was inspired by the
project [openpodgo](https://github.com/agarat/openpodgo).

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

## What works today

One codebase, one version. The web bundle is the product; Android and desktop
are thin shells that add a native USB transport.

| Tier | Target | What you get |
|---|---|---|
| **Supported** | Web app and PWA, desktop Chromium | Full editor, librarian, snapshots, live pedal sync, `.pgp`/`.pgb` import and export, and an offline precache. Installs as a PWA from Chrome or Edge. |
| **Beta** | Android 8.0+ APK | The same editor in a WebView with a USB Host bridge, so a phone can read and edit a connected pedal. Automated tests use a fake bridge; no real-phone pass yet. |
| **Experimental** | Desktop, Tauri 2 (Windows, macOS, Linux) | The same editor with a libusb transport and a native save dialog. Built locally, not part of the release workflow and not run on hardware. |
| **Untested** | Safari, Firefox and iOS browsers | Offline browse, edit and import/export only. WebUSB is Chromium-only, so these browsers cannot reach the pedal. |
| **Not planned** | iOS/iPadOS app | iOS has no public vendor-USB path for this project (no WebUSB in WebKit; MFi/DriverKit entitlements are not available), so there is no native iOS build. |

Download the APK from [Releases](https://github.com/Ultchad/open-podgoedit/releases).
The evidence matrix is in
[docs/architecture/platform-support-matrix.md](docs/architecture/platform-support-matrix.md)
and the tier policy is in the [roadmap](docs/roadmap.md#platform-tiers).

**Hardware status.** Parameter writes (operation 30) and the WebUSB read paths
are validated on a POD Go Wireless with firmware 2.50. Live pedal sync, model
changes (op 40), preset store and rename (op 71), recall (op 20), delete
(op 28/78), body copies (op 5), snapshots (ops 88/89/98/37) and backup/restore
are implemented and covered by fake-device tests, but have not all been
confirmed on hardware.
Moving an effect (op 21) is decoded from a capture but disabled in the UI until
it passes a dedicated hardware test on a backed-up User slot. No native
transport (Android, desktop) has been run against a pedal yet.

Nothing leaves the browser: there is no backend, account or telemetry, and
imported files are never uploaded.

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
- Share one Rust core across web (WASM), desktop (Tauri) and Android.
- Keep one version, one changelog and one tag for every target; support is
  tiered, not forked.

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
| Desktop | [Tauri shell and libusb transport](docs/development/desktop.md) |
| Users | [device connection](docs/user/device-connection.md) |
| Import/export | [`.pgp` and `.pgb`](docs/user/import-export.md) |

## Building

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The core crates use **only the Rust standard library**, so they build offline.
The web, desktop and Android shells add their own dependencies.

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
inspector, model catalog and snapshots. In desktop Chrome or Edge it opens the
POD Go through WebUSB and reads a Factory or User setlist, or the active preset
(object 23, then object 22), and keeps the two in sync while the pedal is
connected. Reads are validated by automated fake-device tests plus recorded
setlist reads on a POD Go Wireless (firmware 2.50). With the pedal connected a
continuous effect parameter changes as you drag it (op 30), a model swap is
sent as you pick it (op 40), and **Save** stores the active preset (op 71);
snapshot recalls, renames and LED colours apply immediately. The build also
installs as a PWA and reloads offline from its precache.

**Backup / restore** downloads a self-checking `.pgbak` of both setlists and
every non-empty slot, and can stream it back with operation 5 after verifying
the file in Rust and showing a destination diff, followed by one explicit
confirmation. Restore is destructive and has not been validated on hardware
yet. **Import .pgp / .pgb…** opens POD Go Edit's own preset export or full
backup and renders the chain. A preset opened this way can be renamed, its
continuous parameters edited, models swapped and blocks deleted in the page,
then downloaded with **Export .pgp** from the preset's right-click or **⋯**
menu; the export keeps every field it does not understand. Imported JSON is not
the `l6-helix` body, so it stays an offline document; pedal slots can still be
copied between User slots with operation 5. The file stays in the browser tab
and is never uploaded or saved.

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
without recalling it on the pedal. Reads never change the pedal. On a connected
pedal, edits are sent as you make them; **Save** stores the slot, and leaving a
preset with unsaved changes asks before discarding them. Details, tests and
troubleshooting are in [apps/web/README.md](apps/web/README.md).

## License

MIT. See [LICENSE](LICENSE).
