# Roadmap

Status date: 2026-11-27.
Companion documents: [requirements](architecture/requirements.md),
[testing strategy](architecture/testing-strategy.md),
[platform support matrix](architecture/platform-support-matrix.md),
[unknowns](reverse-engineering/unknowns-and-hypotheses.md).

## Status vocabulary

| Label | Meaning |
|---|---|
| Done | Merged, tested, and documented. |
| In progress | Code exists; tests pass; not yet validated on hardware. |
| Planned | Designed, not implemented. |
| Blocked | Needs hardware, captures or an external decision. |
| Out of scope | Deliberately excluded. |

Platform claims use the stricter vocabulary from
[platform-support-matrix](architecture/platform-support-matrix.md):
`ITH` / `ITM` / `BU` / `PL` / `UNS`. **No platform row may claim `ITH` without a
recorded hardware session.**

## Platform tiers

**One version, one changelog, one tag.** The web bundle is the product; Android
and desktop are thin shells that add a native USB transport. Tiers describe how
much the project claims and tests, not separate releases. Artifacts ship per
channel (Pages, APK, optional local desktop build), never per-platform branches.

| Tier | Target | Transport | Scope | Evidence |
|---|---|---|---|---|
| **Supported** | Web app and PWA, desktop Chromium | WebUSB | Full editor, librarian, snapshots, live sync, `.pgp`/`.pgb` import and export, offline precache | Reads `ITH` (fw 2.50); `set_param` `ITH`; other writes `ITM` |
| **Beta** | Android 8.0+ APK | USB Host bridge | The same UI in a WebView, on-phone pedal editing | Fake-bridge `ITM`; no real-phone pass |
| **Experimental** | Desktop Tauri 2 (Windows, macOS, Linux) | libusb | The same UI plus a native save dialog; local build only, not in `release.yml` | `BU`: compiles, no hardware pass |
| **Untested** | Safari, Firefox and iOS browsers | none | Offline browse, edit and import/export only | Not exercised; the browser suite is Chromium-only |
| **Not planned** | iOS/iPadOS app | none | No public vendor-USB path for this project: WebKit has no WebUSB, and MFi/DriverKit entitlements are not available | Documented platform limit |

Tier changes require the same evidence as the matrix: a fake-device suite moves
a shell from `BU` to `ITM`, and a recorded hardware session moves it to `ITH`.
An untested browser is never described as supported just because the bundle
loads.

## Phase 0 — Analysis (Done)

- Inventory of the workspace and the MIT-licensed `openpodgo` reference.
- Static analysis of the official Windows 2.50 and macOS 2.50 clients.
- VID/PID confirmed from disassembly: `0x0E41`, `0x4247`, `0x424B`,
  `0x1FC9:0x000C`.
- `l6-helix`, `.pgp`, `.pgb` and notification structures identified.

Artifacts: `docs/reverse-engineering/`.

## Phase 1 — Documentation and architecture (Done)

- Requirements, technology evaluation, seven ADRs, system design, platform
  matrix, security model and testing strategy.
- Transport-independent protocol specification with confidence labels and
  evidence.
- Developer and user documentation.

Artifacts: `docs/architecture/`, `docs/protocol/`, `docs/development/`,
`docs/user/`.

**Exit criterion:** every claim is labelled and traceable; no write feature is
enabled.

## Phase 2 — Read-only Rust core (Done)

Delivered:

- `podgo-domain`: byte-preserving MessagePack codec and `l6-helix` container
  with a typed preset view; fixture round-trip and malformed-input tests.
- `podgo-protocol`: frame accessors, handshake templates, open request/response
  and notification decoding; golden vectors.
- `podgo-transport`: `Transport`/`Discovery` traits, typed errors and a
  scripted mock transport.
- `podgo-session`: state enum, retry policy, five-packet handshake,
  one-request/one-response transactions, object reads, event-channel open,
  burst polling with cursor acknowledgements, a streamed setlist reader with
  freshness/size guards, and close.
- `podgo-test-support`: fixture loaders and response builders.
- `apps/podgo-cli`: offline read-only probe over a `.bin` preset (with a
  byte-identity check) and a `--setlist` mode that prints streamed entries.
- Deterministic property/fuzz-style tests for the MessagePack codec and the
  `l6-helix` container: generated-value byte identity, exhaustive truncation,
  bit-flip and corruption sweeps, trailing-byte preservation.

Two hardening items follow the core into Phase 6:

1. Add a `Preset::validate()` pass for model ids, parameter ranges and
   snapshot consistency (warnings only, never destructive).
2. Confirm the remaining semantic gaps in the opcode table (`1`, `20`, `40`,
   `41`, field ids inside `34`) and capture opcode `6` without a personal
   preset name; the opcode↔action mapping itself is covered by
   `events_actions_fw250.bin`.

**Exit criterion:** `cargo fmt`, `cargo clippy -D warnings`, `cargo test` green
offline. The read-only core itself passes this; write encoders live behind
`device-write` and are covered by Phases 6–7.

## Phase 3 — Preset file import/export (Import, selective and `.pgp`/`.pgb` export delivered)

Delivered:

- **`.pgp` / `.pgb` reader in the web page**
  (`apps/web/src/podgoEdit.ts`). `.pgp` is JSON; `.pgb` uses the `AF6L`
  container with zlib members and the `IDGP` directory. The reader resolves the
  `IDGP` records, inflates each member with the platform
  `DecompressionStream`, maps `L6Setlist` entries and converts a `tone` object
  into the same `PresetStructure` the editor already renders.
- Imported presets have no `l6-helix` body, so device writes, save, copy and
  `.bin` download stay disabled.
- **Offline edit and `.pgp` export.** The adapter keeps the parsed `L6Preset`
  document. An imported preset can be renamed, its continuous parameters
  edited, its amp/effects swapped and blocks deleted in the page, then
  downloaded with **Export .pgp** from the preset's right-click or **⋯** menu;
  `JSON.stringify(doc, null, 1)` preserves every field the reader does not
  understand. A preset taken from a `.pgb` only carries its `data` body, so the
  envelope is rebuilt from the observed `.pgp` shape (`ITM`). The export of an
  untouched real `.pgp` was compared with the original: 0 semantic differences,
  whitespace only.
- **`.pgb` (setlist/backup) export.** **Export .pgb** rebuilds the imported
  `AF6L` container with the working preset in the slot it came from. The
  header, `IDGP` directory body, trailer and every untouched member keep their
  exact bytes, including impulse responses and `UMDS`; only the edited setlist
  is re-serialized and recompressed with `CompressionStream('deflate')`. The
  directory offsets are patched. A local round trip on a real backup produced a
  setlist that deep-equals the original and byte-identical untouched members.
  The writer layout is `ITM` until POD Go Edit opens an exported backup.
- **Selective `.pgb` import/export.** The header dialog lists Factory, User and
  IR groups with counts. Unticked setlists are hidden from the slot browser and
  dropped on export; bulk import adds the non-empty presets of ticked setlists
  as offline copies without overwriting existing ones, and IRs are retained for
  re-export without an editor. `SLNM` and unknown members are always kept.
- Files are parsed in memory only, never uploaded or persisted. Automated
  tests build synthetic files with invented names, so no personal backup is
  committed.

Still planned:

- JSON ↔ `l6-helix` conversion; this needs an evidenced encoder and is not
  attempted, so an exported or imported preset cannot be written to the pedal.
- `.hlx` import/export (JSON authoring format).
- A semantic round-trip test against a fixture that can be committed (the
  local real export is not stored in the repository).

**Exit criterion (import):** a `.pgp` and a `.pgb` open without network access,
show the expected chain and names, and leave every write path disabled.
**Exit criterion (export):** import → domain → export preserves all known and
unknown fields for both `.pgp` and `.pgb`; malformed and oversized files are
rejected without panic.

## Phase 4 — Browser application (Delivered; persistence still open)

Delivered:

- `apps/web/`: React + TypeScript + Vite bootstrap running the Rust core
  as WebAssembly.
- Local page on `127.0.0.1:5173` that parses an `l6-helix` preset and a
  streamed setlist, loads the bundled fixtures, and accepts local files.
- WASM host tests (`apps/web/wasm`) and a Node smoke test of the generated module.
- Playwright browser suite (68 specs on Chromium, plus a separate spec against
  the built bundle): both reports render, no external request, malformed input
  is rejected, a full User-setlist read through a fake WebUSB device
  (handshake, `OPEN_PRESETS`, `OPEN_STREAM`, 13 chunks, 128 entries), the
  library actions (copy/paste/move/rename, delete, "New preset here"), the
  live `set_param`/model/save/delete/snapshot flows and backup/restore, and an
  offline `.pgp` edit → export → re-import round trip.
- WebUSB transport: vendor-interface discovery, bulk IN/OUT with
  mirrored-channel response filtering, handshake retry, setlist and active
  preset flows, and the live write paths used by the editor. Hardware evidence
  is tracked in Phase 6; native shells reuse the same page.
- Active-preset read through the Rust `PresetFlow`: object 23 (active state)
  then object 22 (preset), with a fresh handshake per object. The WASM binding
  exposes a structured JSON view (chain, parameters, snapshots, tempo,
  footswitch/controller assignments) that drives the editor.
- Librarian slot read: clicking a preset sends operation 4 with the target
  `{107, 108}` and opens that slot's body, so any Factory/User preset can be
  inspected without recalling it on the pedal. Evidence: the official backup
  capture performs 134 such reads.
- Active-preset fallback: if the pedal ignores object 23, `for_active_body`
  reads object 22 alone with the two-object flow's open request; the UI keeps
  the chain and labels the preset `Active preset`. Event-channel frames are
  routed to the live-sync decoder and never mistaken for a response.
- POD Go Edit–style UI: librarian (Factory/User, `01A` labels, amber loaded
  slot), signal chain with category colours and switch labels, editable
  parameter inspector, Model Select grid, snapshot editor, undo/redo and
  effect copy/paste.
- Live sync: the event channel (`0x03F0 → 0x1002`) is opened once after the
  handshake; op-30/49 notifications apply immediately and op-42/46/4/8
  schedule a debounced re-read of the active preset. Transports without events
  keep manual reads and log a warning.
- Snapshots: recall (op 88), rename (op 89), LED colour (op 98) and
  parameter→snapshot assignment (op 37) are live and marked dirty so **Save**
  (op 71) persists them. Removing an op-37 assignment stays offline-only
  because no capture exists for it.
- Installable PWA: a custom service worker precaches the build with a
  content-hash id, and GitHub Pages publishes the same bundle on every push to
  `main`.
- Model catalog (571 models, 4978 parameters) generated from the MIT
  `openpodgo` data by `tools/export_catalog.py`; the Rust core only emits
  on-wire ids and raw values. `tools/validate_catalog.py` validates the
  catalog against 125 presets / 1199 blocks from a real capture.
- The binding crate stays outside the root workspace so the core keeps its
  zero-dependency offline build.

Remaining:

- IndexedDB `PresetRepository` (the library currently lives in memory for the
  tab and is rebuilt from a read or import).
- A strict CSP for the Pages build.
- Capture object 22 during a knob sweep to correlate values with parameter
  indexes on hardware.

**Exit criterion:** Playwright offline flows pass; bundle within the size
budget; no network requests.

## Phase 5 — Desktop shell (Built; experimental)

Delivered:

- Tauri 2 shell in `apps/desktop` reusing the web UI from `apps/web/dist`.
- `rusb`/libusb transport with discovery, interface claiming, a single reader
  thread and a native save dialog.
- Windows WinUSB, macOS and Linux udev and packaging documentation.

Remaining:

- A recorded hardware session for reads and writes on each OS.
- Packaging decisions (Windows signing, macOS notarization, Linux bundles) and
  inclusion in `release.yml`, if the shell graduates past experimental.

**Exit criterion:** a mock device passes end-to-end in CI on every OS; hardware
results are recorded separately.

## Phase 6 — Hardware validation (In progress)

One WebUSB session is recorded on a POD Go Wireless (fw 2.50): discovery,
handshake, Factory and User setlist reads, active-preset reads and one
controlled `set_param` write. The evidence and hashes are in the
[platform support matrix](architecture/platform-support-matrix.md#5-hardware-evidence-log).

Still open:

1. Write sessions for store/rename (op 71), recall (op 20), delete (op 28/78),
   body copy (op 5), snapshots (ops 88/89/98/37) and backup/restore.
2. A live-sync run: change a parameter and recall a snapshot on the pedal while
   the page is open, and confirm the page follows.
3. A first run of the Android and desktop transports against a real pedal.
4. The op-21 move test on a dedicated User slot backed up as `.pgb`; the menu
   stays disabled until it passes.
5. The knob-sweep capture (object 22) and the `Preset::validate()` follow-up
   from Phase 2.

The step-by-step checklist (local, Docker, WASM, browser and USB capture) is
[manual-testing-todo](development/manual-testing-todo.md); experiments V1–V7 in
the [analysis log](reverse-engineering/analysis-log.md) are the queue for the
remaining protocol questions.

**Exit criterion:** each completed item is recorded with firmware version,
commands, observed frames and confidence. Only then may platform rows move to
`ITH` for those features.

## Phase 7 — Device writes (In progress)

Writes are live in the UI: there is no arming step and no per-action prompt.
The only prompts are **Save** (button or `Ctrl/Cmd+S`) and leaving a preset
with unsaved changes (`save` / `no` / cancel).

- `device-write` Cargo feature, disabled by default in the core crates and
  enabled by the web build.
- `set_param` (op 30) for one continuous effect parameter: encoder, WASM
  `ParamWriteFlow`, WebUSB driver. **Done and hardware-validated (`ITH`,
  fw 2.50).** See [docs/protocol/writes.md](protocol/writes.md).
- Model change (op 40) on the active preset, including a live model swap from
  the Model Select grid. **Done offline; hardware validation pending.**
- `save_preset` (op 71), metadata only: encoder and golden vector from the
  editor capture, WASM `SavePresetFlow`, shared WebUSB driver, save dialog
  with destination backup/SHA-256 and post-save setlist verification.
  **Done offline; hardware validation pending.** Direct rename of a non-active
  User slot recalls it (op 20), renames with op 71, recalls the previous preset
  back and verifies the setlist.
- Delete an effect (ops 28 then 78) from the block menu, the
  `Delete`/`Backspace` key or the **None** model tile. Works offline (JSON
  draft) and live on the pedal. **Done offline.**
- Copy/paste between User slots with an op-5 body write. **Done offline.**
- Snapshots: recall (op 88), rename (op 89), LED colour (op 98) and
  parameter→snapshot assignment (op 37) are live and dirty so Save persists
  them. Removing an op-37 assignment stays offline-only with a notice.
  **Done offline.**
- Move an effect (op 21): the encoder now matches both captured uploads byte
  for byte, but the menu stays **disabled** until a dedicated hardware test on
  a User slot backed up as `.pgb`.
- Full backup and restore: `.pgbak` container with per-entry and whole-file
  SHA-256, `BackupBuilder` reading every non-empty slot of both setlists, and
  an op-5 replay of the captured stream framing. **Done offline; restore is
  not hardware-validated.** Scope is deliberately op-5 only: the operation
  9/86/113 traffic and the final op-254 in the capture are not replayed. See
  [docs/protocol/writes.md](protocol/writes.md) §2.6–2.7.
- Mandatory backup, diff preview and re-read verification for restore. The
  object-14 seal experiment (V3) still has to be resolved or explicitly
  bypassed with a documented re-read strategy.

**Exit criterion:** one controlled parameter write, one preset save on a
dedicated slot, one effect delete, one snapshot rename and one restore of a
small backup, each with a verified backup and a recorded result.

## Phase 8 — Mobile shells (Android delivered; iOS not planned)

Delivered:

- Android 8.0+ WebView shell serving the bundle from `assets/` under a virtual
  HTTPS origin, mapping JS dialogs to native dialogs, opening the file picker,
  saving exports through a file bridge and exposing a USB Host transport
  (`window.podgoAndroidUsb`). Same WASM core and write paths as the web app.
  **`ITM`: covered by the browser suite through a fake bridge, never run on a
  phone with a pedal.**

Remaining:

- A real-phone session with a connected pedal (permission flow, reads, edits,
  Save).
- A shared storage schema and migrations, together with the IndexedDB
  repository from Phase 4.
- iOS/iPadOS is **not planned**: there is no public vendor-USB path for this
  project. See [Platform tiers](#platform-tiers) and the
  [support matrix](architecture/platform-support-matrix.md).

**Exit criterion:** Android USB permission flow and reads pass against a real
pedal; the app states which transport is unavailable and why.

## Out of scope

- Per-platform forks, branches or version numbers. One version and one
  changelog cover every target; support is tiered instead.
- A native iOS/iPadOS app or direct vendor USB on iOS until a public,
  supported device path exists.
- Firmware update protocol.
- Authentication, licensing or copy-protection bypass.
- Cloud sync, accounts or a marketplace.
- Audio rendering or IR processing.
- Redistribution of Line 6 binaries, firmware, resources or decompiled code.

## Decision points

| Date gate | Decision | Owner |
|---|---|---|
| Before IndexedDB repository | Adopt a storage schema and migration policy | Maintainers |
| Before the next write session | Obtain hardware, a capture setup and a verified `.pgb` backup | Maintainers |
| Before enabling op 21 move | Run the dedicated hardware test on a backed-up User slot | Maintainers |
| Before any iOS transport | Revisit only if Apple exposes a public, supported vendor-USB path | Maintainers |
