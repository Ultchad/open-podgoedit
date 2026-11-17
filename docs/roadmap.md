# Roadmap

Status date: 2026-11-12.
Companion documents: [requirements](architecture/requirements.md),
[testing strategy](architecture/testing-strategy.md),
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

## Phase 2 — Read-only Rust core (In progress)

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

Remaining for this phase:

1. Add a `Preset::validate()` pass for model ids, parameter ranges and
   snapshot consistency (warnings only, never destructive).
2. Confirm the remaining semantic gaps in the opcode table (`1`, `20`, `40`,
   `41`, field ids inside `34`) and capture opcode `6` without a personal
   preset name; the opcode↔action mapping itself is covered by
   `events_actions_fw250.bin`.

**Exit criterion:** `cargo fmt`, `cargo clippy -D warnings`, `cargo test` green
offline; no command capable of mutating device state.

## Phase 3 — Preset file import/export (Import, `.pgp` and `.pgb` export delivered)

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
  document. An imported preset can be renamed and its continuous block
  parameters edited in the page, then downloaded with **Export .pgp**;
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

## Phase 4 — Offline web application (In progress)

Delivered:

- `apps/web/`: React + TypeScript + Vite bootstrap running the read-only Rust core
  as WebAssembly.
- Local page on `127.0.0.1:5173` that parses an `l6-helix` preset and a
  streamed setlist, loads the bundled fixtures, and accepts local files.
- WASM host tests (`apps/web/wasm`) and a Node smoke test of the generated module.
- Playwright browser tests (28): both reports render, no external request,
  malformed input is rejected, a full User-setlist read through a fake WebUSB
  device (handshake, `OPEN_PRESETS`, `OPEN_STREAM`, 13 chunks, 128 entries),
  the local library actions (copy/paste/move/rename with pending markers), the
  gated `set_param`/save/backup/restore flows, and an offline `.pgp` edit →
  export → re-import round trip.
- Read-only WebUSB transport: vendor-interface discovery, bulk IN/OUT with
  mirrored-channel response filtering, handshake retry, and setlist read
  orchestration driven by the Rust `ReadFlow` state machine. No write channel.
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
  always ignored by the WebUSB transport, never mistaken for a response.
- POD Go Edit–style UI: librarian (Factory/User, `01A` labels, amber loaded
  slot), signal chain with category colours and switch labels, read-only
  parameter inspector and Model Select grid.
- Model catalog (571 models, 4978 parameters) generated from the MIT
  `openpodgo` data by `tools/export_catalog.py`; the Rust core only emits
  on-wire ids and raw values. `tools/validate_catalog.py` validates the
  catalog against 125 presets / 1199 blocks from a real capture.
- The binding crate stays outside the root workspace so the core keeps its
  zero-dependency offline build.

Remaining:

- IndexedDB `PresetRepository`.
- `.hlx` export, undo/redo, and model swapping
  (read-only until the gated whole-chain write exists).
- Capture object 22 during a knob sweep to correlate values with parameter
  indexes on hardware.
- Static build suitable for GitHub Pages; strict CSP; no backend calls.

**Exit criterion:** Playwright offline flows pass; bundle within the size
budget; no network requests.

## Phase 5 — Desktop transport (Planned)

- Tauri 2 shell reusing the web UI.
- `rusb`/libusb transport with discovery and interface claiming.
- Windows WinUSB, macOS, Linux udev and packaging documentation.

**Exit criterion:** a mock device passes end-to-end in CI on every OS; hardware
results are recorded separately.

## Phase 6 — Read-only hardware validation (Blocked)

Needs a physical POD Go and USB captures. Experiments V1–V7 in the
[analysis log](reverse-engineering/analysis-log.md) are the queue. The
step-by-step checklist (local, Docker, WASM, browser and USB capture) is
[manual-testing-todo](development/manual-testing-todo.md).

Required before any write claim:

1. USBPcap/`usbmon` capture of connect and handshake.
2. Descriptor dump confirming interface and endpoints.
3. Read 128 presets and compare names with the device screen.
4. Active preset read, parse, local re-encode, byte comparison.
5. Event capture per opcode.

**Exit criterion:** each completed item is recorded with firmware version,
commands, observed frames and confidence. Only then may platform rows move to
`ITH` for read features.

## Phase 7 — Gated device writes (in progress, behind a feature flag)

- `device-write` Cargo feature, disabled by default. **Done.**
- `set_param` (op 30) for one continuous effect parameter: encoder, WASM
  `ParamWriteFlow`, WebUSB driver, arming checkbox and per-change
  confirmation. **Done and hardware-validated (`ITH`, fw 2.50).**
  See [docs/protocol/writes.md](protocol/writes.md).
- `save_preset` (op 71), metadata only: encoder and golden vector from the
  editor capture, WASM `SavePresetFlow`, shared WebUSB driver, save dialog
  with destination backup/SHA-256 and post-save setlist verification.
  **Done offline; hardware validation pending.**
- Full backup and restore: `.pgbak` container with per-entry and whole-file
  SHA-256, `BackupBuilder` reading every non-empty slot of both setlists, and
  an op-5 replay of the captured stream framing. **Done offline; restore is
  not hardware-validated.** Scope is deliberately op-5 only: the operation
  9/86/113 traffic and the final op-254 in the capture are not replayed. See
  [docs/protocol/writes.md](protocol/writes.md) §2.6–2.7.
- Preset library actions: in-page copy/paste/move/rename, plus a gated op-5
  body write and an op-71 rename of the active User preset. No delete/clear
  operation is evidenced, so a move leaves its source on the pedal. See
  [docs/protocol/writes.md](protocol/writes.md) §2.8.
- Encoders for operations 20/21/40/88, unit-tested offline only.
- Mandatory backup, explicit confirmation, diff preview and re-read
  verification.
- Object-14 seal experiment (V3) must be resolved or explicitly bypassed with a
  documented re-read strategy.
- Restore procedure and incident advisory process.

**Exit criterion:** one controlled parameter write, one preset save on a
dedicated slot and one restore of a small backup, each with a verified backup
and a recorded result.

## Phase 8 — Mobile (Planned)

- Android: UniFFI bindings plus Kotlin USB Host `bulkTransfer`.
- iOS: offline-first; CoreMIDI only if the device proves class-compliant, and
  never claimed before hardware verification.
- Shared storage schema and migrations.

**Exit criterion:** Android USB permission flow and mock reads pass; iOS
offline flows pass; unsupported transport is stated in the app.

## Out of scope

- Firmware update protocol.
- Authentication, licensing or copy-protection bypass.
- Cloud sync, accounts or a marketplace.
- Audio rendering or IR processing.
- Redistribution of Line 6 binaries, firmware, resources or decompiled code.

## Decision points

| Date gate | Decision | Owner |
|---|---|---|
| Phase 2 exit | Adopt `serde_json` for `.pgp`/`.hlx`, or defer import/export | Maintainers |
| Before Phase 6 | Obtain hardware and a capture setup | Maintainers |
| Before Phase 7 | Write safety review and backup procedure | Maintainers |
| Before iOS transport | Prove a public, supported device path | Maintainers |
