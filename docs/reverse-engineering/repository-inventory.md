# Repository inventory

Phase: 1 — analysis.
Date: 2026-11-10.
Status: complete for the material present in the workspace.

This document inventories every relevant path examined. It records purpose,
main symbols, inputs/outputs, dependencies, protocol knowledge and limitations.
Confidence labels follow the project convention: **confirmed**, **strongly
supported**, **hypothesis**, **unknown**, **platform limitation**.

## 1. Workspace root

| Path | Type | Notes |
|---|---|---|
| `reverse/bin/POD_Go_Edit_v2.50_Installer.exe` | PE32 i386 NSIS installer, 69,906,696 bytes | Official Windows 2.50 installer |
| `reverse/bin/PODGoEdit.dmg` | bzip2 UDIF DMG, 33,593,977 bytes | Official macOS 2.50 disk image |
| `reverse/openpodgo/` | Python project + git metadata | Behavioural/protocol reference |
| `reverse/work/` | empty | Scratch directory |

The workspace root is **not** a git repository at the time of analysis
(`git status` → `fatal: not a git repository`). `reverse/openpodgo` has its own
`.git`.

## 2. `reverse/openpodgo` top level

| File | Purpose | Notes |
|---|---|---|
| `README.md` | Feature overview, hardware claim `0e41:4247`, disclaimer | Claims live validation against a real POD Go |
| `CLAUDE.md` | Contributor/agent guidance | Records architecture and conventions |
| `pyproject.toml` | Package metadata and dependencies | Python ≥ 3.11, PySide6, pyusb, msgpack, pytest |
| `LICENSE` | MIT | Reusable knowledge, not code |
| `NOTICE` | Attribution to openhx/helix_usb | Prior art |
| `CONTRIBUTING.md` | Contribution rules | |
| `99-podgo.rules` | Linux udev rule for `0e41:4247` | Confirms VID/PID intent |
| `cliff.toml` | git-cliff changelog config | |
| `.gitignore` | build/capture ignores | |

### Build configuration and dependencies

`pyproject.toml` declares runtime dependencies on `pyusb` (libusb bindings),
`msgpack`, and PySide6 for the UI; tests use `pytest`. The core protocol path
(`packets.py`, `session.py`, `usb_transport.py`, `preset.py`) depends only on
`pyusb` + `msgpack`, which makes it a clean behavioural reference for a Rust
port.

## 3. Source modules (`src/openpodgo/`)

### `usb_transport.py`

- **Purpose:** open the vendor interface, claim it, and provide strict
  write→read bulk helpers with stale-data drain.
- **Main symbols:** `VENDOR_ID = 0x0E41`, `KNOWN_PRODUCT_IDS` (0x4247 POD Go,
  0x4246 HX Stomp, 0x4253 HX Stomp XL, 0x5055 HX Stomp alt),
  `USB_CLASS_VENDOR_SPECIFIC = 0xFF`, `EP_OUT = 0x01`, `EP_IN = 0x81`,
  `READ_BUFFER = 512`, `OP_TIMEOUT_MS = 2000`, `DRAIN_TIMEOUT_MS = 50`,
  `DeviceInfo`, `UsbTransport`, `TransportError`.
- **Inputs/outputs:** USB descriptors in; raw byte frames out; raw byte frames
  in; `DeviceInfo` out.
- **Protocol knowledge encoded:** device discovery by VID and vendor-specific
  interface with a bulk endpoint pair; `set_configuration(1)`,
  `claim_interface`, `clear_halt` on both endpoints, drain before first packet;
  never two writes without a read.
- **Limitations:** endpoint discovery heuristics; no isochronous/control
  transfer support; no hotplug; assumes interface 0 in practice.
- **Test vectors:** endpoint/interface selection logic; drain behaviour.
- **Do not reuse directly:** Python/pyusb specifics; port the *contract*.

### `packets.py`

- **Purpose:** byte-exact frame templates and builders.
- **Main symbols:** `SRC = 0x1001`, `DST = 0x03EF`, `HANDSHAKE`,
  `SESSION_OPEN_1`, `SESSION_CHUNK_1`, `SESSION_OPEN_2`, `SESSION_CHUNK_2`,
  `HANDSHAKE_SEQUENCE`, `OPEN_PRESETS`, `OPEN_STREAM`,
  `build_chunk_request`, `build_vendor_open`, `build_vendor_write`,
  `decode_open_body`.
- **Protocol knowledge encoded:** 8-byte transport header
  (`len`, `0x00 0x00`, magic, src LE, dst LE), byte 9 seq, byte 11 cmd,
  bytes 12–15 cursor/offset LE, optional subheader at 16–19; magic `0x28`
  only on first handshake packet, `0x18` otherwise; MessagePack body.
- **Limitations:** templates are opaque byte arrays; not all fields are
  understood; no generic validator.
- **Test vectors:** `tests/test_packets.py` asserts exact lengths and header
  bytes, e.g. `build_chunk_request(0x08, 0x1138)` equals
  `08 00 00 18 01 10 EF 03 00 08 00 08 38 11 00 00`.
- **Reuse:** the header layout and handshake bytes are reusable as golden
  vectors; the Python builders are not.

### `session.py`

- **Purpose:** application session: 5-packet handshake, retry/backoff, read /
  write / event sessions, cursor semantics.
- **Main symbols:** `MAX_INIT_ATTEMPTS = 5`, `BACKOFF_BASE_MS = 300`,
  `_frame_desc`, `Session`, `WriteSession`, `EventSession`.
- **Protocol knowledge encoded:** one read per handshake write; app sequence
  starts at `0x06`; read channel `0x1001→0x03EF`, write channel
  `0x1080→0x03ED`, event poll `0x1002→0x03F0` with notifications on the reverse
  `0x03F0→0x1002`; polling command `0x10`;
  retry with linear backoff on timeout.
- **Limitations:** no explicit state enum; exceptions used for control flow;
  no cancellation; event parser tries several offsets heuristically.
- **Test vectors:** handshake sequence order, sequence increments, recovery
  after dropped response.

### `preset.py`

- **Purpose:** paginated preset streaming, parsing of the 128-entry list, and
  bridge to `.pgp`.
- **Main symbols:** `PresetEntry`, `PresetStream`, `read_preset_list`,
  `parse_preset_stream`, `select_setlist`.
- **Protocol knowledge encoded:** `OPEN_STREAM` byte 34 selects the setlist;
  base offset `0x1000`; a fresh `0x100`-byte window per 512-byte chunk; 128
  presets; `slot` = stream position, `index` = stable ID.
- **Limitations:** pattern scan rather than a schema; no strict bounds model;
  assumes one container shape.
- **Fixtures:** `spec02_*.bin`, `user_setlist.bin`.

### `l6helix.py`

- **Purpose:** decode the `l6-helix` container (active preset, object 22).
- **Main symbols:** `MAGIC = b"l6-helix\0"`, `KEY_STATUS = 103`,
  `KEY_RESULT = 104`, `KEY_ERROR_CODE = 111`, `text`, `parse_body`,
  `build_blob`, `DeviceStatusError`.
- **Protocol knowledge encoded:** magic + offset table + a single MessagePack
  map; chain of blocks, snapshots and metadata; NUL-terminated strings.
- **Limitations:** offset table meaning is partial; some keys untyped.
- **Fixtures:** `spec02_obj22_blob.bin` (3823 bytes) starts
  `a9 6c 36 2d 68 65 6c 69 78 00`; `spec02_a.bin` wraps it in a MessagePack
  map (`83 66 cd 03 ea …`).

### `notifications.py`

- **Purpose:** parse unsolicited events arriving on `0x03F0→0x1002` (the host
  polls the reverse `0x1002→0x03F0`).
- **Main symbols:** `parse_notification`, `NotificationReader`.
- **Protocol knowledge encoded:** body `{105: opcode, 106: data}`; events
  `set_param` 30, `bypass_state` 49, `bypass` 39, `snapshot` 42/46,
  `preset_loaded` 8, `tempo` 22; framing offset varies (16 or 24), so the
  parser tries candidates.
- **Limitations:** heuristic offsets; untyped payloads; Qt thread coupling.
- **Test vectors:** each opcode with a minimal body.

### `device.py`

- **Purpose:** high-level orchestration: connect, list setlists/presets, read
  objects, write parameters/snapshots/presets.
- **Main symbols:** `PodGo`, object constants, `_OBJ14_CRC_CONFIRMED = False`,
  write status handling for key `103`.
- **Protocol knowledge encoded:** object map 0/1/13/14/22/23/24; object 14 is
  a per-slot u32 "seal"; `zlib.crc32` over the object-22 blob does **not**
  match; write ops 20/21/30/40/71/88; status `0` OK for set/save, `0/1`
  accepted for op 21.
- **Limitations:** checksum unknown; writes are live-only; no rollback.

### `editor.py`

- **Purpose:** in-memory editing of the active preset and `.pgp` export/import.
- **Main symbols:** `DEVICE_ID = 2162695`, `PGP_SCHEMA = "L6Preset"`,
  `PGP_VERSION = 6`, `APP_NAME = "POD Go Edit"`, `APP_VERSION = 33554432`,
  `PresetEditor`, `_pgp_to_dsp0`, `_pgp_to_footswitch`,
  `_pgp_to_controllers`, `to_pgp`, `from_pgp`.
- **Protocol knowledge encoded:** complete blob↔`.pgp` positional mapping;
  block model, controller ranges, footswitch groups, snapshots; mutations
  operate on the raw MessagePack map to avoid losing unknown keys.
- **Limitations:** large module; some attributes positional; device identity
  constants are compatibility values.

### `catalog.py`

- **Purpose:** on-wire model id → name, parameter order, defaults.
- **Main symbols:** `MODELS_JSON`, `CONTROLS_JSON`, model lookup helpers.
- **Protocol knowledge encoded:** key 25 of a block is the model id; param
  order is positional; `@trails`/`@mic` are stored as trailing params;
  `@enabled` is bypass, not a param. `models.json` contains 571 models.
- **Limitations:** catalog derived from a backup; may lag firmware.

### `l6res.py`

- **Purpose:** parse official resources (`PodGo.sym`, `*.models`,
  `PGModelCatalog.json`).
- **Protocol knowledge encoded:** `PodGo.sym` index equals the on-wire model
  id; `parameters` is the positional value order; `*.models` adds defaults,
  min/max, `valueType` and attribute params; `PGModelCatalog.json` gives
  categories/subcategories.
- **Limitations:** depends on user-supplied proprietary resources; not
  redistributed.

### `pgb.py`

- **Purpose:** read `.pgb` backups (`AF6L` container).
- **Protocol knowledge encoded:** magic `AF6L` + binary header + consecutive
  zlib streams; streams decompress to JSON (globals, `L6UMDArchive`, two
  `L6Setlist`) or WAV IRs; setlist entries carry the same `L6Preset` body as
  `.pgp`.
- **Limitations:** header layout partial; no writer.

## 4. Documentation

| File | Value |
|---|---|
| `docs/protocol.md` | Consolidated transport/handshake/object notes |
| `docs/specs/00-roadmap.md` | Status of validated features |
| `docs/specs/01-user-setlist-stream.md` | Slot vs index semantics |
| `docs/specs/02-*.md` | Preset dump discovery and blob↔`.pgp` mapping |
| `docs/specs/03-*.md` | Write commands, channel handshake, live validation |
| `docs/specs/04-live-sync.md` | Event opcodes and sync behaviour |
| `docs/features/*.md` | Feature intent (IR, backup, snapshots, etc.) |
| `docs/podgo-edit-vs-openpodgo-features.md` | Feature comparison |

## 5. Tests and fixtures

`tests/` includes codec, device-write, editor, preset and catalog tests. The
gated `set_param` write path is covered by
`crates/podgo-protocol/src/write.rs` (golden vector), `apps/web/wasm/src/write.rs`
(flow) and `apps/web/tests/usb.spec.ts` (fake WebUSB device).
`tests/fixtures/` contains legally obtained sample data:

| Fixture | Bytes | Use |
|---|---|---|
| `spec02_obj22_blob.bin` | 3823 | Raw `l6-helix` container |
| `spec02_obj22.bin` | 3836 | Open response wrapping the blob |
| `spec02_a.bin`, `spec02_knob.bin` | 3836 | Variants for round-trip |
| `spec02_obj14.bin` | 1004 | Object-14 checksum table |
| `spec02_preset2.bin`, `.pgp` | 3904 / 10140 | Second preset pair |
| `spec02_a.pgp` | 8206 | `.pgp` export reference |
| `eq_acoustic_sim_obj22.bin` | 3912 | Additional preset |
| `user_setlist.bin` | 3332 | Streamed user setlist |

These become golden vectors. They contain user/preset data and must be reviewed
before publication; the repository should ship only fixtures with clear
redistribution permission.

## 6. What not to reuse

- Python/pyusb/Qt implementation details.
- Any copied proprietary resource file or binary.
- The `.pgp` compatibility constants as if they were protocol truth — they are
  file-format compatibility values, documented as such.

## 7. Gaps

- No packet captures in the workspace (`captures/` absent).
- No hardware attached during this analysis.
- No firmware update protocol analysis.
- Object-14 checksum unresolved.
- iOS transport unverified.
