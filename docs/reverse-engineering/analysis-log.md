# Analysis log

Chronological record of Phase 1. Each entry states date, phase, tool, input,
action, result, interpretation, confidence and next validation step. No tool
output is invented; unavailable tools are recorded as limitations.

## 2026-11-10 — Phase 1.1 — repository inventory

- **Tool:** shell (`pwd`, `ls`, `find`, `du`, `git status`)
- **Input:** workspace root, `reverse/`
- **Action:** enumerate structure, sizes, git state
- **Result:** only `reverse/bin`, `reverse/openpodgo`, empty `reverse/work`; not a
  git repo at root
- **Interpretation:** greenfield project; reference material is read-only input
- **Confidence:** confirmed
- **Next:** read `reverse/openpodgo` sources and docs

## 2026-11-10 — Phase 1.2 — Python source analysis

- **Tool:** `read`, `grep`, shell
- **Input:** `src/openpodgo/*.py`, `tests/`, `docs/`, `pyproject.toml`
- **Action:** read transport, packets, session, device, preset, `l6helix`,
  notifications, catalog, editor, `l6res`, `pgb`; inspect tests and fixtures
- **Result:** layered architecture; byte templates; object map; blob↔`.pgp`
  mapping; event opcodes; write ops
- **Interpretation:** reliable behavioural reference; several heuristic and
  unconfirmed areas
- **Confidence:** strongly supported (claims are the project's own live-test
  reports; not independently reproduced)
- **Next:** validate against binaries

## 2026-11-10 — Phase 1.3 — binary identification

- **Tool:** `file`, `7z l`, `objdump`, `rabin2`, `rizin`, `strings`
- **Input:** `reverse/bin/*`
- **Action:** identify container types and extract to `/tmp/opencode/podgo-re`
- **Result:** NSIS PE32 i386; bzip2 UDIF DMG → pkg → cpio; app v2.50
- **Interpretation:** both official clients available for static analysis
- **Confidence:** confirmed
- **Next:** imports and strings

## 2026-11-10 — Phase 1.4 — REA PE resource inspection

- **Tool:** MCP REA `open_binary`, `inspect_pe_resources`
- **Input:** `/tmp/opencode/podgo-re/win/POD Go Edit/POD Go Edit.exe`
- **Action:** open, enumerate PE resources
- **Result:** success; evidence `ev_25aa388a1b419cd3acb28e938d987ec4cf85f0a6eed8a447f3e473823128fa8e`;
  sha256 `1edab677ffedbf0cb15ab9accb6a9c44a7b7b11229e74d8a88d711f901e9240b`
- **Interpretation:** PE is well-formed; resources are icon/version, protocol
  data is in `.rdata`/resources on disk, not PE version resources
- **Confidence:** confirmed
- **Next:** binary overview

## 2026-11-10 — Phase 1.5 — REA binary overview

- **Tool:** MCP REA `binary_overview`
- **Input:** Windows exe
- **Action:** request inventory summary
- **Result:** `provider_timeout` after 330 s (Ghidra import/analysis)
- **Interpretation:** function-level decompilation unavailable in this
  environment; fall back to static tools
- **Confidence:** platform limitation
- **Next:** `rabin2`/`rizin`/`objdump`

## 2026-11-10 — Phase 1.6 — REA layout/Mach-O

- **Tool:** MCP REA `inspect_binary_layout`, `inspect_macho`
- **Input:** Windows exe, macOS exe
- **Action:** request section/import layout and Mach-O inspection
- **Result:** `provider_unavailable` (pwntools Python not configured); Mach-O
  provider unavailable on Linux
- **Interpretation:** use `rabin2` and `objdump`
- **Confidence:** platform limitation
- **Next:** linked libraries and imports

## 2026-11-10 — Phase 1.7 — imports and frameworks

- **Tool:** `objdump -p`, `rabin2 -I/-i/-l`
- **Input:** both executables
- **Action:** list DLLs, imports, linked frameworks
- **Result:** WINMM/SETUPAPI/KERNEL32/Interposer on Windows; CoreMIDI/WebKit/
  IOKit/bundled libusb on macOS
- **Interpretation:** shared vendor bulk transport, OS-specific MIDI
- **Confidence:** confirmed (imports), strongly supported (roles)
- **Next:** protocol strings

## 2026-11-10 — Phase 1.8 — protocol strings and class names

- **Tool:** `strings -a -n 5`, `rabin2 -zz`
- **Input:** both executables
- **Action:** search for device/protocol/serialization identifiers
- **Result:** `L6DeviceCenter_Win`, `L6UsbBulkMsgChannel`, `L6HelixMsgPort`,
  `L6LibUsbControlEndpointItf`, `MsgPackL6Variant`, `MurmurHash3`,
  `L6PodGoPreset_*`, `L6UpdateEngine`, `AuthenticationManager`
- **Interpretation:** confirms architecture and serialization; `MurmurHash3` is
  only a candidate for object 14
- **Confidence:** confirmed (strings), hypothesis (use of MurmurHash3)
- **Next:** VID/PID xrefs

## 2026-11-10 — Phase 1.9 — VID/PID disassembly

- **Tool:** `rizin` (`pd`, `px`, `/x`)
- **Input:** Windows `0x5be6c0`, macOS `0x10000e2a0`
- **Action:** disassemble comparison block
- **Result:** comparisons against `0x0E41`, `0x4247`, `0x424B`, `0x1FC9`,
  sub-id `0x0C`
- **Interpretation:** confirms VID/PID and reveals update/bootloader identity
- **Confidence:** confirmed
- **Next:** resolve `0x424B` role and firmware behaviour

## 2026-11-10 — Phase 1.10 — resource extraction

- **Tool:** `7z`, `cpio`, `gzip`, `file`, `od`
- **Input:** extracted `res/` on both platforms
- **Action:** list and inspect `PodGo.sym`, `*.models`, `PGModelCatalog.json`,
  `default_preset_p34.hlx`
- **Result:** `PodGo.sym` is a JSON array; `*.models` JSON; `.hlx` is JSON text;
  catalog has categories/models
- **Interpretation:** same data model on both platforms; `.hlx` ≠ device blob
- **Confidence:** confirmed
- **Next:** map symbol indices to wire model ids on hardware

## 2026-11-10 — Phase 1.11 — fixture inspection

- **Tool:** `od`, `python3`, `read`
- **Input:** `tests/fixtures/*`
- **Action:** inspect headers and parse sample JSON
- **Result:** `l6-helix` magic, 48-byte table, MessagePack map; `.pgp` schema;
  object-14 u32 table
- **Interpretation:** fixtures are valid golden vectors
- **Confidence:** confirmed
- **Next:** encode/decode round-trip in Rust

## 2026-11-10 — Phase 1.12 — documentation and architecture

- **Tool:** `write`
- **Input:** all of the above
- **Action:** produce Phase 1 documentation and ADRs
- **Result:** files under `docs/`
- **Interpretation:** evidence is sufficient to start a read-only PoC; writing
  remains out of scope
- **Confidence:** n/a
- **Next:** Phase 2 implementation

## 2026-11-11 — Phase 4 — WebUSB read on hardware

- **Tool:** `apps/web` (React + WASM) in Chrome, `podgo-probe --setlist`,
  `sha256sum`
- **Input:** POD Go Wireless, firmware 2.50 (build `6e984472`), PID `0e41:424b`;
  local exports `reverse/exports/podgo-setlist-{factory,user}.bin`
- **Action:** connect over WebUSB, read Factory and User, download raw streams,
  replay them through the CLI scanner
- **Result:** both reads returned 128 entries; every slot 0–127 present;
  Factory 3668 B (`1caa7b70…`, 128 unique slots), User 3416 B (`b8fe30b0…`,
  ids 128–255, all unique)
- **Interpretation:** the read-only WebUSB path and the setlist scanner work on
  real firmware, not just the fake device. Factory's open ack is a plain ack,
  so its 8-byte data header (`00 00 02 00` + length `0x0e4c` = 3660) appears at
  the front of the first chunk; the scanner tolerates it, so no stripping is
  needed (and stripping would shift every later chunk by 8 bytes)
- **Confidence:** confirmed for these two reads; Factory header placement is
  observed once
- **Next:** record host OS and browser version, take a second-read/disconnect
  cycle, then use the captures to settle the event-framing question

## 2026-11-11 — Phase 4 — event framing from the USBPcap capture

- **Tool:** Python (stdlib pcapng parser modelled on `reverse/openpodgo`'s
  `usbpcap.py`), `podgo-probe`
- **Input:** `reverse/exports/podgo-connect.pcapng` (official POD Go Edit on
  Windows 11, fw 2.50; 334 bulk transfers)
- **Action:** extract bulk payloads, classify by channel, decode every
  event-channel frame at candidate offsets and reconstruct cursor arithmetic
- **Result:** 87/86 transfers on the write channel, 46/45 on the read channel,
  30 host polls and 38 device frames on the event channel (24 acks/keepalives,
  14 notifications). Every notification is framed: `00 00 04 00`, u32 body
  length, MessagePack at offset 24, 0–3 zero padding. Header length at bytes
  0–1 equals `16 + body length`. Opcodes observed: 20, 8, 22 (twice per burst),
  39, 4. Cursor: polls at `0x1009`, device echo always `0x0209`, advance is
  `8 + body length` (13 and 17 → ack `0x1037`, 23 → `0x1056`, burst 23+17+19 →
  `0x10a9`). One ack can cover a burst; interleaved acks are equivalent.
- **Interpretation:** the offset-16 variant does not occur for notifications on
  this firmware; it is legacy recovery only. Copying the device echo cursor
  into the host cursor would desynchronise the session.
- **Confidence:** confirmed for 14 events and two preset-change bursts
- **Next:** capture the remaining opcodes (30, 46, 49, 21, 31, 34) with known
  triggers; then re-check write-path cursor semantics

## 2026-11-11 — Phase 4 — opcode ↔ action mapping

- **Tool:** `tools/podgo-capture.py` (`summary`, `map`, `events`)
- **Input:** `reverse/exports/podgo-events.pcapng` (POD Go Edit 2.50, fw 2.50,
  241 s, 2306 bulk transfers, SHA-256 `b9291174…d10431a`)
- **Action:** the eleven guided actions from the manual-testing checklist, in
  order, one at a time with pauses; then per-burst opcode histograms
- **Result:** 278 event-channel data frames, 277 decodable notifications, 15
  bursts. Opcodes 1, 4, 6, 8, 20, 21, 22, 30, 31, 33, 34, 39, 40, 41, 42, 46,
  49 observed. Framing identical to the connect capture (offset 24, 0–3
  padding, header `[0:2] = 16 + body length`) for all 278 frames.
- **Interpretation:**
  - `8` then `4` bracket every preset change; `4` is not a save.
  - `20` follows editor requests and repeats the response object.
  - `22` is not tempo-only: field 16 is tempo, field 28 the active slot.
  - `30` is one frame per knob step; `49` is the absolute bypass state.
  - `42`/`46` pair on snapshot changes; `49` with a null payload also appears.
  - `31` adds and `33` removes a footswitch assignment.
- **Confidence:** C for the mapping on fw 2.50; H for the semantics of `1`,
  `20`, `40`, `41` and the inner field ids of `34`
- **Next:** confirm `6` (preset name) on a capture without personal names, and
  the field ids of `34`

## 2026-11-12 — catalog capture: preset switch, drive knob, bypass, assignments

- **Tool:** Python (stdlib pcapng/MessagePack readers in
  `tools/validate_catalog.py`), `tools/build_catalog.py`
- **Input:** `reverse/exports/podgo-catalog.pcapng` (USBPcap, Windows, POD Go
  Edit 2.50, 1896 bulk transfers, SHA-256 `c664ba86…6d2193e2`)
- **Action:** extract every bulk payload, classify by channel, decode the
  event-channel notifications, and read the two setlist streams
- **Result:** 349 write-channel frames, 966 read-channel responses, 317
  event-channel frames (68 decodable notifications). The capture starts with
  two setlist reads: User, 3415 B (128 entries) and Factory, 3660 B (128
  entries), each with the 8-byte `00 00 02 00` + u32-length header in the
  first data frame. Notifications: op 8/4 move the active preset from Factory
  01A (slot 0) to Factory 01D (slot 3); op 30 on block 6, param index 0
  (Drive) steps `0.2999→0.32` then `0.57→0.80`; op 49 toggles block 9 bypass
  on then off; op 31 assigns blocks 1/2→FS8, 3→FS1, 4→FS3, 8→FS2, 9→FS4;
  op 34 assigns controllers 1/2 to param 4 of blocks 1/2, then controller 1
  to param 0 of block 6.
- **Interpretation:** with Factory 01D's chain read from
  `podgo-full-backup.pcapng`, block 6 is `HD2_AmpCaliRectifire` and block 9 is
  `HD2_PhaserScriptModPhaseStereo`: the capture is a drive-knob sweep on the
  amp plus a Script Phase bypass, not a drive change on a distortion pedal.
  `param 0` is the catalog's `Drive` for that amp, consistent with
  `param_order`. The capture contains no object-22/23 read, so it cannot build
  the catalog by itself; it only fixes the parameter index for this model.
- **Confidence:** C for the notification opcodes and values; C for the
  block→model mapping (chain read from the same Factory slot in another
  capture); H for what the pedal displayed (0–10 scaling inferred from
  `value × 10`)
- **Next:** capture object 22 with a knob sweep so the value and the parameter
  index are recorded in the same object

## 2026-11-12 — full backup: official object framing and catalog validation

- **Tool:** `tools/validate_catalog.py` (stdlib only)
- **Input:** `reverse/exports/podgo-full-backup.pcapng` (USBPcap, Windows,
  6994 bulk transfers, SHA-256 `06cc8039…40fe37cf`)
- **Action:** reassemble every read-channel object from the capture and check
  each `l6-helix` body against the MIT `openpodgo` catalog
- **Result:** 140 read opens: operation 4 ×134, operation 1 ×2 (setlists),
  operations 0/254/255 (confirm/handshake). 125 presets decode (108 Factory,
  17 User); 8 User slots are empty (`104: null`, 9-byte body); Factory slot 98
  is short by 36 bytes (3832 of 3868) because one USBPcap URB is missing.
  1199 processing blocks, 206 distinct models, 1199/1199 resolve. Only three
  parameter-count mismatches (`HD2_LooperOneSwitchMono` 10 vs 4,
  `HD2_CabMicIr_4x12CaliV30` and `…Greenback25` 8 vs 7) and three category
  mismatches (`HD2_FXLoopMono1` 9 vs 8, `HD2_EQ_STATIC_ParametricStereo`
  23 vs 1, `HD2_CabMicIr_4x12Greenback25` 15 vs 26).
- **Interpretation:** official-editor responses use a different chunk framing
  from the project's own WebUSB path: the first data frame after an open has a
  u32 body length at offset 20 and the MessagePack body at 24; continuation
  frames carry raw stream bytes from offset 16. Frames are 272 bytes on the
  wire. The catalog's UI category is not the on-wire category byte for FX
  loop, parametric EQ and IR cabs — the validator must report both instead of
  treating the on-wire byte as authoritative. The looper and IR cab parameter
  counts are model-specific storage reductions, not catalog errors.
- **Confidence:** C for the framing (125 complete bodies, including the
  `str16` `l6-helix` payload); C for the model-id resolution; C for the
  parameter-count anomalies on these captures
- **Next:** re-capture Factory slot 98 without a dropped URB; treat `104:
  null` as an empty slot in the UI when reading User presets

## Open validation queue

| # | Experiment | Requires |
|---|---|---|
| V1 | Read-only USBPcap of connect | Windows + device |
| V2 | Descriptor dump (`lsusb -v`, `system_profiler`) | Linux/macOS + device |
| V3 | Object-14 before/after one param change | Device + backup |
| V4 | Event capture per opcode | Device |
| V5 | CoreMIDI-only preset change | macOS + device |
| V6 | Android USB Host enumeration | Android + OTG |
| V7 | iOS ExternalAccessory/CoreMIDI probe | iOS + device |

## 2026-11-13 — write path: op 30 payload and golden vector

- **Tool:** Python (stdlib reader reused from `tools/validate_catalog.py`),
  Rust unit tests
- **Input:** `reverse/exports/podgo-catalog.pcapng` (SHA-256
  `c664ba86…6d2193e2`), write channel `0x1080 → 0x03ED`
- **Action:** decode every write-channel frame and list the operations the
  official editor actually sent during the capture
- **Result:** 349 write-channel frames: the 4-packet handshake, then ops `24`
  (×4), `33` (×4), `78` (×4), `23` (×3), `22` (×3), `20` (×2), `76`, `99`,
  `37`, `36`. **No op 30 request** is present, so the editor-sent `set_param`
  frame cannot be taken from this capture.
- **Interpretation:** the op-30 frames seen elsewhere are the pedal's
  *notifications* (`{98, 119, …}`), not host requests. The host payload keys
  (`98` raw chain index, `29: true`, `26: 0`, `28` parameter, `119` f32) come
  from the reference implementation, which states they were hardware-validated.
- **Confidence:** C for the channel, handshake and cursor rules; S for the
  `set_param` payload keys (reference + notification echo, no host capture)
- **Next:** capture one knob sweep in POD Go Edit (USBPcap, write channel) and
  compare it byte for byte with
  `crates/podgo-protocol/src/write.rs::encode_set_param`

## 2026-11-13 — first hardware write: `set_param` on an amp Drive

- **Tool:** web UI (WebUSB, Chrome), POD Go Wireless `0x424b`, fw 2.50,
  POD Go Edit closed
- **Action:** read the active preset ("New Preset"), arm writes, set
  **US Double Nrm · Drive** from `2.5` to `9.0`, confirm; then read the value on
  the pedal and re-read the active preset
- **Result:** accepted after one attempt; the pedal shows `9.0` and the re-read
  preset carries `0.9`. Frame:
  `27 00 00 18 80 10 ed 03 00 05 00 04 5b 10 00 00 01 00 06 00 17 00 00 00
  83 66 cd 07 d1 64 1e 65 85 62 06 1d c3 1a 00 1c 00 77 ca 3f 66 66 66 00`
- **Interpretation:** op `30` at offset 30; `98: 06` is the raw chain index
  (amp in slot 5 → index 6); `29: c3` true; `26: 00`; `28: 00` (Drive);
  `119: ca 3f 66 66 66` is `0.9f`; cursor `0x105b` = `0x1009` + 17 from the
  object-76 response. The encoder matches byte for byte.
- **Also observed:** the first write handshake after a read session was
  ignored (same symptom as the read channel). The driver now replays the four
  handshake packets in place.
- **Confidence:** C for the write channel, handshake, cursor and `set_param`
  payload on fw 2.50
- **Next:** capture one knob sweep in POD Go Edit to compare the editor's own
  transaction ids and padding, then investigate the save path (op 71) and the
  object-14 seal before offering preset saving

## 2026-11-13 — capture: `save_preset` op 71

- **Tool:** Python (stdlib pcapng + MessagePack reader from
  `tools/validate_catalog.py`)
- **Input:** `reverse/exports/podgo-preset-save.pcapng`, SHA-256
  `50b02ded…d01946`
- **Action:** decode every write-channel (`0x1080 → 0x03ED`) request carrying a
  MessagePack body
- **Result:** exactly one op-71 frame:

  ```text
  2a 00 00 18 80 10 ed 03 00 3e 00 04 e8 1f 00 00
  01 00 06 00 1a 00 00 00
  83 66 cd 03 f8 64 47 65 83 6b 01 6c 24 6d ab 4e 65 77 20 50 72 65 73 65 74 00
  00 00
  ```

  Body `{102: 1016, 100: 71, 101: {107: 1, 108: 36, 109: "New Preset\0"}}`,
  seq `0x3e`, cursor `0x1fe8`; response `{102: 1016, 103: 0, 104: nil}` plus
  `62 06 1d` padding; event `{105: 6, 106: {107: 1, 108: 36, 109: ...}}`.
- **Also confirmed:** the same capture holds ten editor-sent op-30 frames.
  They match `encode_set_param` byte for byte, resolving U8 for the encoder
  shape. The write cursor advances by each response footprint
  (`8 + u16 body len` framed, `len - 16` raw, `0` for a bare 16-byte ack).
- **Interpretation:** op 71 writes **metadata only**. No object-14 access and
  no preset-body upload occur, so saving does not depend on the object-14
  seal. The implementation and golden vector are in
  `crates/podgo-protocol/src/write.rs`.
- **Confidence:** C for the frame, destination keys and status on fw 2.50
- **Next:** hardware-validate a save from this build on a dedicated User slot
  with the destination backup downloaded first

## 2026-11-13 — capture: backup/restore stream (ops 5 and 9)

- **Tool:** Python (stdlib pcapng + MessagePack reader)
- **Input:** `reverse/exports/podgo-backup-restore.pcapng`, SHA-256
  `3c1e213b…e98a3425`
- **Action:** reassemble every read-channel stream and decode the MessagePack
  messages
- **Result:** 158 streamed messages: 157 op-5 preset writes
  `{107, 108, 123: false, 124: false, 125: 0, 110: <body>}` (116 Factory,
  40 User slots, one message with `107: null`) and one op-9:
  `{112: 0, 113: 3649282169, 109: "TJ 70 G12H Green Fat-57 2\0", 114: 1,
  115: 3, 123: false, 124: false, 125: 0, 110: <7717-byte blob>}`. One op-86
  frame `{110: <215-byte opaque blob>}` appears separately.
- **Stream rule (resolved):** a message starts at a read frame with subheader
  `01 00 02 00`, total length as u32 at offset 20, MessagePack body at 24.
  Subsequent read-channel frames contribute `payload[16:]` until the declared
  total; 0–3 trailing padding bytes are ignored. A new command frame ends the
  previous stream. USBPcap records are duplicated (`info=0x0` carries data,
  `info=0x1` is an empty completion); only the former are used.
- **Interpretation:** restore uploads preset bodies one slot at a time and is
  destructive by nature. Op 9 looks like a restore terminator/message carrying
  a name and a 32-bit value; key `113` does **not** match CRC32 of the blob.
  Op 86 remains unexplained (session start or backup header are candidates).
- **Confidence:** C for the stream shape, message counts and op-5/op-9 bodies;
  U for op 86 and key 113
- **Next:** do not implement restore until a dedicated backup/verification
  design exists; capture the editor opening and closing a restore session to
  place op 86

## 2026-11-14 — implementation: full backup (`.pgbak`) and op-5 restore

- **Tool:** Python (stdlib pcapng + MessagePack reader) for the stream rules;
  Rust/WASM for the container, encoders and flows
- **Input:** `reverse/exports/podgo-backup-restore.pcapng`, SHA-256
  `3c1e213b…e98a3425`
- **Action:** pin down the exact per-frame rules of the 157 op-5 messages, then
  encode a replay stream and a self-checking backup container
- **Stream result (all `C` on this capture):**
  - 157 op-5 messages: 116 with `107: 0`, 40 with `107: 1` and one without key
    107 in the body; every body has key 110 as a MessagePack `str`
    (`da`/`db`), never `bin`;
  - the first message is transaction 1579, setlist 0 slot 0, declared body
    4171 B, sequence 146, cursor `0x52fd`; the first frame is 512 B with
    `u16 = 504`, subheader `01 00 02 00`, total at offset 20 and 488 data
    bytes at 24;
  - continuations carry raw body at offset 16 (up to 496 B), `u16 = 8 + data`,
    and zero padding to a 4-byte boundary;
  - the window status `{102: tx, 103: 1, 104: nil}` arrives after 1512–1528
    body bytes; the next frame advances the cursor by 17 (`8 + 9`), and the
    next message starts at that advanced cursor with no extra footprint;
  - the op-254 frame at cursor `0x1009` is exactly `SESSION_OPEN_2`, so the
    restore preamble is the five `READ_SEQUENCE` packets; the first op-5
    frame uses sequence 6 and cursor `0x101a`.
- **Implementation decisions:**
  - the encoder caps the first window at exactly 1536 body bytes and waits
    there, rather than reproducing the capture's 1512/1528 frame boundary;
  - the capture's 16-byte `cmd = 0x08` host acknowledgements after each window
    status are **not** sent; sequence numbers therefore run one behind the
    capture per window (open fidelity gap);
  - restore sends op-5 only; op-9/86/113 and the final op-254 are not replayed;
  - the `.pgbak` container stores raw bodies, setlist/slot/name, product and
    firmware, with a per-entry SHA-256 and a whole-file SHA-256 footer.
- **Verification:** `cargo test -p podgo-domain`, `cargo test -p podgo-protocol
  --features device-write`, `cargo test` in `apps/web/wasm`, `tsc --noEmit`
  and the Playwright backup/restore test over the fake WebUSB device. Restore
  remains **not hardware-validated**; no op-5 write from this build has been
  applied to a pedal.
- **Next:** hardware-validate one restore of a 2–3 preset backup on a
  dedicated User setlist after downloading and verifying the full backup;
  confirm whether the window acknowledgements are required and whether the
  op-9/op-86 traffic matters for a full replay.

## 2026-11-14 — analysis: POD Go Edit `.pgp` / `.pgb` files

- **Tool:** Python (stdlib `json`, `zlib`, `struct`) for the container; the
  browser adapter uses the platform `DecompressionStream`
- **Input:** two local POD Go Edit exports (one `.pgp` preset and one `.pgb`
  full backup). They are not committed and are not used as fixtures, because
  they contain personal preset names.
- **`.pgp` result (`C`):** UTF-8 JSON, schema `L6Preset` version 6. The useful
  body is `data.tone`: `dsp0` with `input`, `block0`…`block9`, `output`;
  `controller.dsp0`, `footswitch.dsp0`, `global`, `snapshot0`…`snapshot3`,
  `irUuidTable`. Parameters are keyed by semantic name and carry real units
  (for example `FcHigh: 2155.0`). An unused block keeps `{"@position": n}`.
  `@fs_index` is 1-based with `9` = expression toe; `@current_snapshot` is
  0-based; `device_version` is packed BCD (`0x02500000` = firmware `2.50`).
- **`.pgb` result (`C` on the observed file):** `AF6L` magic, `u32` version 1,
  `u64` directory offset at byte 8, 48-byte header, then consecutive zlib
  members. At the directory offset: `IDGP`, `u32` header length 24, a 24-byte
  header body, then 36-byte records
  `[u32 reserved][tag reversed][u64 offset][u64 stored][u32 codec][u64 original]`.
  Observed tags: `SLNM` (stored names), `GLOB` (globals JSON), `I000` (RIFF
  WAV IR), `UMDS` (`L6UMDArchive` model catalogue), `SL00` / `SL01`
  (`L6Setlist`, version 2, 128 entries each; empty slot `{}`).
- **Implementation:** read-only web adapter (`apps/web/src/podgoEdit.ts`) with
  a directory-first parser and a zlib-scan fallback. It maps the JSON tone to
  the existing `PresetStructure`; no Rust protocol code was changed because
  the JSON is not the pedal's `l6-helix` body.
- **Confidence:** `C` for the structures above, `H` for the exact meaning of
  the remaining header fields and the per-record `u32 reserved` field (zero in
  every observed record).
- **Limits:** no export, no JSON → `l6-helix` conversion, and imported presets
  cannot be written to the pedal. The un-reversed tags are consistent across
  all six records, so the adapter validates tags rather than relying on order.
- **Next:** if export is requested, decide the `serde` vs hand-written JSON
  question first; a writer must preserve unknown fields, and a converter to
  `l6-helix` needs its own evidence.

## 2026-11-16 — analysis: offline `.pgp` export round-trip

- **Tool:** Python (stdlib `json`) for the comparison; the browser adapter
  serializes with `JSON.stringify(doc, null, 1)`.
- **Input:** the same local POD Go Edit `.pgp` used above (not committed, not a
  fixture).
- **Result (`C`):** importing and immediately exporting the file yields **0
  semantic differences**. Every object key, array element and value survives;
  only whitespace differs (8859 B original vs 8353 B export). The vendor writer
  emits `"key" : value` with a space before the colon, which a JSON serializer
  does not reproduce.
- **`.pgp` envelope from a `.pgb` entry (`H`):** a setlist entry stores only
  `device`, `device_version`, `meta` and `tone`, so the adapter rebuilds the
  top-level `{schema: "L6Preset", version: 6, meta: {original, pbn, premium},
  data}` object. This shape matches the observed `.pgp` files, but no written
  file has been opened in POD Go Edit yet, so the envelope remains an inference
  rather than a confirmed writer contract.
- **Confidence:** `C` that the round-trip is lossless for a `.pgp`; `H` for the
  rebuilt envelope and for POD Go Edit accepting a file whose whitespace
  differs.
- **Limits:** `.pgb` export, `.hlx` and JSON → `l6-helix` conversion are not
  implemented. The export keeps values in POD Go Edit units; no re-quantization
  or clamping is applied beyond the catalog range checks in the inspector.
- **Next:** open an exported `.pgp` (original and edited) in the official POD
  Go Edit to confirm acceptance; if the vendor app rejects it, compare the
  rejected file byte-for-byte with a vendor-saved file.

## 2026-11-17 — correction: restore acks every frame, not a 1536-byte window

- **Tool:** Python (stdlib pcapng + USBPCAP header reader) over
  `reverse/exports/podgo-backup-restore.pcapng`.
- **Input:** the first op-5 message (transaction 1579, Factory slot 0, 4171-byte
  body), starting at packet 52352.
- **Result (`C`):** the pedal answers `{102: 1579, 103: 1, 104: nil}` after
  **488, 917, 1313, 1706, 2124, 2518, 2867, 3246, …** body bytes — that is,
  once per USB packet (512-byte transfer), not once per fixed byte window.
  The statuses arrive on the read-response pair `0x03EF → 0x1001` with
  subheader `00 00 02 00`, interleaved with `0x48` event frames.
- **Cursor (`C`):** the cursor steps `0x52fd → 0x530e` (+17) right after the
  first status and stays there for the frames that follow, then steps again
  after the next status. So the rule is *advance by 17 per granted status*.
- **Interpretation:** the previous encoder capped a single window at 1536 body
  bytes and waited for one status there. The pedal's per-packet statuses were
  consumed as bare acknowledgements, so the frame after the 1536-byte boundary
  was never granted and the flow aborted with *"the pedal did not acknowledge
  the restore stream window"*. The encoder now marks every frame as a window
  end and advances the cursor after each status.
- **Confidence:** `C` for the per-frame status, the response channel and the
  cursor step (all read directly from the capture). Restore itself is still
  **not hardware-validated**: the framing now matches the capture, but no op-5
  write from this build has been applied to a pedal.
- **Next:** apply a one-slot restore to a backed-up User slot and confirm the
  body survives a preset switch and a reboot.

## 2026-11-17 — correction: op 71 stores the current sound

- **Input:** `reverse/exports/podgo-preset-save.pcapng`, the single op-71
  request at packet 11296 and the status at 11335.
- **Result (`C`):** the save capture contains **one** command frame, op 71,
  and no preset-body upload anywhere. The pedal answers
  `{102: 1016, 103: 0, 104: nil}` and then pushes the save events
  `{121: 3, 106: {107, 108, 116}}` and `{121: 8, 106: {107, 108, 109}}`.
- **Interpretation:** op 71 commits the pedal's **own edit buffer** to the
  slot. Parameters applied with op 30 are therefore persisted by a following
  op 71; no body stream is needed. The earlier note that op 71 is
  "metadata-only" described the *frame contents*, not the effect: the command
  does store the current sound.
- **Confidence:** `C` for the frame contents and the status/event sequence;
  `H` for the claim that a parameter set with op 30 is included in the stored
  preset, which follows from the pedal committing its edit buffer but has not
  been checked by switching presets after a save from this build.
- **Next:** save a changed parameter from this build, switch presets and reboot
  to confirm the stored value survives.

## 2026-11-17 — implementation: offline `.pgb` export

- **Input:** the local full backup used above (not committed, not a fixture).
- **Result (`C` for the container):** the directory has six 36-byte records
  (`SLNM` stored, `GLOB`/`I000`/`UMDS`/`SL00`/`SL01` zlib), each with a zero
  `reserved` word and a 4-byte zero trailer. Members are consecutive from
  offset 48, and the header's `u64` at +8 points at `IDGP`.
- **Writer:** `serializePgb` copies the 48-byte header, the `IDGP` header body,
  the trailer and every untouched member's stored bytes verbatim. Only the
  setlist containing the edited slot is serialized with
  `JSON.stringify(doc, null, 1)` and recompressed with
  `CompressionStream('deflate')`; the record offsets and the header pointer are
  patched.
- **Round trip (`C` on the local file):** import → export without edits gave
  byte-identical `SLNM`, `GLOB`, `I000`, `UMDS` and `SL00`; the recompressed
  `SL01` decompressed to a document that deep-equals the original. The header
  differs only in the directory offset, as expected.
- **Confidence:** `C` that the rebuilt container matches the observed layout
  and preserves untouched members; **`H`** that POD Go Edit (or the pedal)
  accepts a re-written backup, because no exported file has been opened by the
  official tool yet.
- **Limits:** the writer needs the original `IDGP` directory. A backup read
  through the zlib-scan fallback cannot be rebuilt. The setlist entry keeps the
  observed body shape (`device`, `device_version`, `meta {build_sha, name}`,
  `tone`), so unknown fields inside `tone` survive but the richer `.pgp`
  metadata envelope is not invented.
- **Next:** open an exported `.pgb` in POD Go Edit, restore it to a pedal, and
  confirm the edited slot and the untouched IR still load.
