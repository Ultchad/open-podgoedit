# openpodgo analysis

Phase: 1 — analysis.
Reference: `reverse/openpodgo` (Python, MIT).
Role: **behavioural and protocol reference**, not a source to port.

## 1. Architecture

The Python project is layered:

```
UI (PySide6)  ──►  editor.py / device.py  ──►  session.py  ──►  usb_transport.py
                         │                        │
                         ├── l6helix.py           ├── packets.py
                         ├── preset.py            └── notifications.py
                         ├── catalog.py
                         ├── l6res.py
                         └── pgb.py
```

- `usb_transport` owns the OS/libsurf layer and nothing else.
- `session` owns framing lifecycle: handshake, sequence, retry, channels.
- `device` owns the object model and write operations.
- `editor` owns the preset body and file formats.
- UI is deliberately outside the core, which is the right separation to keep.

**Assessment:** the layering is sound and maps cleanly to Rust crates. The main
weaknesses are exception-based control flow, heuristic parsing, and implicit
state.

## 2. Transport contract

From `usb_transport.py`:

- Discover by `idVendor == 0x0E41`, then require a vendor-specific interface
  (class `0xFF`) exposing a bulk IN/OUT endpoint pair.
- Prefer `EP_OUT = 0x01`, `EP_IN = 0x81`; otherwise derive from descriptors.
- `set_configuration(1)`, `claim_interface`, `clear_halt` both endpoints.
- Drain stale IN data with a 50 ms timeout before the first write.
- Read buffer 512 bytes; operation timeout 2000 ms.
- Strict request→response: exactly one read after each write.

**Formal contract for Rust:**

```text
discover() -> Vec<DeviceId>
open(DeviceId) -> Handle
claim(Handle, interface=0) -> Result
write(Handle, &[u8]) -> Result<usize>   // must be followed by read
read(Handle, timeout) -> Result<Vec<u8>>
close(Handle)
```

The transport trait must not know about handshakes, MessagePack or presets.

## 3. Framing model

From `packets.py` and `tests/test_packets.py`:

```text
offset  size  field
0       1     body_len (bytes after the fixed 16-byte area, see note)
1       2     0x00 0x00
3       1     magic: 0x28 on first handshake packet, else 0x18
4       2     source (LE)
6       2     destination (LE)
8       1     0x00
9       1     sequence
10      1     0x00
11      1     command
12      4     cursor / stream offset (LE)
16      ...   optional subheader (4 bytes) + MessagePack body
```

Notes:

- The exact meaning of `body_len` is not fully proven; tests assert the byte
  for known templates.
- The 16-byte prefix is stable across read and write channels.
- The body is MessagePack; the subheader appears on open/stream responses.

**Evidence:** `test_build_chunk_request_layout` asserts
`08 00 00 18 01 10 EF 03 00 08 00 08 38 11 00 00`.

## 4. Handshake

Read channel (`0x1001→0x03EF`), 5 writes, each followed by one read:

| # | cmd | len | magic | Role |
|---|---|---|---|---|
| 1 | `0x02` | 20 | `0x28` | HANDSHAKE |
| 2 | `0x04` | 28 | `0x18` | SESSION_OPEN_1 |
| 3 | `0x08` | 16 | `0x18` | SESSION_CHUNK_1 |
| 4 | `0x04` | 36 | `0x18` | SESSION_OPEN_2 |
| 5 | `0x08` | 16 | `0x18` | SESSION_CHUNK_2 |

Write channel (`0x1080→0x03ED`) has a 4-packet handshake (capture-derived):

| # | cmd | len | Role |
|---|---|---|---|
| 1 | `0x02` | 20 | HANDSHAKE (src/dst swapped) |
| 2 | `0x04` | 28 | SESSION_OPEN_1 |
| 3 | `0x08` | 16 | SESSION_CHUNK_1 |
| 4 | `0x04` | 36 | SESSION_OPEN_2 with `{102:1000, 100:76, 101:{}}` |

Application sequence starts at `0x06` on both channels.

**Confidence:** strongly supported (Python live-validated claim + capture notes),
not independently reproduced here (no hardware, no captures in repo).

## 5. Object model

| Object | Meaning | Confidence |
|---|---|---|
| 0 | Setlists | Strongly supported |
| 1 | Preset list (128 entries) | Strongly supported |
| 13 | IR list | Strongly supported |
| 14 | Per-slot u32 checksum/seal | Strongly supported (semantics), algorithm unknown |
| 22 | Active preset `l6-helix` blob | Confirmed by fixture |
| 23 | Active state | Strongly supported |
| 24 | Flags / UI state | Strongly supported |

Object 14: `_OBJ14_CRC_CONFIRMED = False`; `zlib.crc32` over the object-22
blob (raw, body-only, or rebuilt) matches none of the 120 non-empty slots.
It must be treated as opaque until a controlled experiment resolves it.

## 6. Preset representation

`l6-helix` container (confirmed from `spec02_obj22_blob.bin`):

```text
a9 "l6-helix\0"           magic (MessagePack fixstr of 9)
da 0030                   str16 length 0x30 = 48
<48-byte offset table>    unknown exact semantics; observed monotonic offsets
83                        MessagePack map, 3 entries
  key 0  -> dsp0 chain
  key 1  -> dsp1 (empty on POD Go)
  key 2  -> metadata / snapshots
```

Actually observed top-level keys in the fixture include the DSP chain, metadata
and snapshots; the parser must not assume exactly three keys.

Block shape (from `l6helix.py` / `editor.py`):

- key 25: model id (index into `PodGo.sym`).
- positional parameter values followed by `@trails`, `@mic`.
- bypass/enabled state separate from numeric params.
- snapshot list with per-snapshot tempo/valid and per-block enables.

**Unknown preservation invariant:** mutate the decoded MessagePack map, not a
lossy typed projection; re-encode with original key order and value types.

## 7. `.pgp` format

Confirmed from `spec02_a.pgp`:

```json
{
  "data": {
    "device": 2162695,
    "device_version": 33619968,
    "meta": {"application":"POD Go Edit","appversion":33554432,
             "build_sha":"v2.00-5-g665e64e","modifieddate":1781218446,
             "name":"BassPreset"},
    "tone": {
      "dsp0": {"block0": {"@enabled":true,"@model":"HD2_VolPanVolStereo",
                          "@position":0,"@type":0,"Pedal":1.0,...}},
      "controller": {"dsp0": {...}},
      "footswitch": {...},
      "snapshot": {...}
    }
  }
}
```

- Schema marker `L6Preset`, version 6.
- `device` 2162695 and `appversion` 33554432 are compatibility values, not
  protocol constants.
- Parameter names are human-readable; the device blob is positional. The
  mapping is documented in `docs/specs/02-lab-notes.md`.

## 8. `.pgb` backup

Magic `AF6L`, binary header, then consecutive zlib streams:

- JSON globals (no schema),
- `L6UMDArchive`,
- two `L6Setlist` documents (Factory + User, 128 entries each),
- WAV IR payloads.

The `L6Setlist` entries reuse the `.pgp` body, making a backup the best source
for a complete model catalog.

## 9. Notifications

The host polls `0x1002→0x03F0`; notifications arrive on the reverse channel
`0x03F0→0x1002`, body `{105: op, 106: data}`:

| Op | Event | Notes |
|---|---|---|
| 8 | preset loaded | |
| 22 | tempo | |
| 30 | set_param | |
| 39 | bypass (legacy) | |
| 42/46 | snapshot | |
| 49 | bypass_state (absolute) | wah toe uses this, not 39 |

Framing offset is not constant (16 or 24); the Python parser tries candidates
and accepts the first dict with key 105. Rust should model this explicitly as
"framed" vs "raw window" rather than guessing silently.

## 10. Timing, retry and recovery

- 2 s per operation, 50 ms drain.
- Handshake retried up to 5 times with linear backoff from 300 ms.
- No two writes without a read.
- Disconnect: close handle, clear session, require re-handshake.

## 11. Contradictions and unsafe assumptions

1. `docs/protocol.md` says the POD Go PID is "to be confirmed", while the
   README and udev rule assert `0x4247`. Binary analysis confirms `0x4247`.
2. Object-14 checksum is described as a "seal" but the algorithm is explicitly
   unconfirmed; any edit-detection based on it is unsafe.
3. Event framing is guessed by trying offsets; a wrong offset could misparse a
   future event. Must be treated as version-sensitive.
4. `.pgp` compatibility constants (`device`, `appversion`) could change between
   editor versions; they must be configurable, not hardcoded truth.
5. No capture files are present, so capture-derived claims cannot be re-verified
   in this repository.

## 12. What becomes a formal test vector

- Frame lengths and header bytes from `tests/test_packets.py`.
- Handshake packet order and magic/sequence.
- `spec02_obj22_blob.bin` → typed preset → byte-identical re-encode.
- `spec02_a.pgp` → domain → `.pgp` semantic round-trip.
- Notification bodies for ops 8/22/30/39/42/46/49.
- `user_setlist.bin` → 128 slot/index pairs.

## 13. What must not be reused

- Qt/pyusb code, exception-based control flow, heuristic offset scanning as a
  permanent design.
- Any proprietary resource or captured user data without explicit permission.
