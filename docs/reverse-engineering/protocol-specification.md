# POD Go protocol specification

Version: draft 0.1 (Phase 1).
Scope: transport-independent model of the Line 6 POD Go vendor protocol as
observed from the Python reference and the official 2.50 binaries.

> **Confidence labels** — `C` confirmed, `S` strongly supported, `H` hypothesis,
> `U` unknown, `L` platform limitation. Every message table carries a label and
> an evidence source.

> **Unknown bytes are never zeroed.** Parsers retain the raw frame; encoders
> re-emit retained bytes verbatim unless a documented field is explicitly
> changed.

## 1. Identifiers

| Item | Value | Confidence | Evidence |
|---|---|---|---|
| Vendor ID | `0x0E41` | C | Windows `0x5be6ea`, macOS `0x10000e2bf`, `usb_transport.py` |
| POD Go product ID | `0x4247` | C | Windows `0x5be6dd`, macOS `0x10000e2d6`, `99-podgo.rules` |
| POD Go Wireless product ID | `0x424B` | S | Windows `0x5be6ef`, macOS `0x10000e2cc` |
| Update/bootloader identity | `0x1FC9:0x000C` | S | Both binaries; role inferred from NXP VID |
| USB class | Vendor-specific `0xFF` | S | `usb_transport.py`; official strings |

## 2. USB topology

| Item | Value | Confidence | Evidence |
|---|---|---|---|
| Configuration | 1 | S | `usb_transport.py` |
| Vendor interface | 0 (assumed, discovered dynamically) | S | Python; official uses descriptor walk |
| Bulk OUT endpoint | `0x01` | S | Python live-validated claim |
| Bulk IN endpoint | `0x81` | S | Python live-validated claim |
| Transfer type | Bulk | C | libusb/WinUSB imports; `kUsbBulkEndpointMode` |
| Read buffer | 512 bytes | S | `usb_transport.py` |
| Operation timeout | 2000 ms | S | `usb_transport.py` |
| Drain timeout | 50 ms | S | `usb_transport.py` |
| MIDI interface | Class-compliant (CoreMIDI/WINMM) | S | macOS CoreMIDI link; WINMM imports |

**Discovery algorithm (transport independent):**

1. Enumerate devices with `idVendor == 0x0E41`.
2. Accept `idProduct` in `{0x4247, 0x424B}`.
3. Walk descriptors for an interface with `bInterfaceClass == 0xFF` and both a
   bulk IN and a bulk OUT endpoint.
4. Prefer interface 0, but record the actual interface/endpoint numbers.
5. Open, set configuration 1, claim the interface, clear halt on both endpoints.
6. Drain any stale IN data with a 50 ms timeout.

**Permission requirements:** OS-specific. Linux needs a udev rule granting
access to `0e41:4247`; Windows needs WinUSB binding (the official installer
provides it); macOS needs no entitlement outside the App Sandbox; WebUSB needs a
user gesture. See `docs/user/device-connection.md`.

## 3. Logical channels

| Channel | Direction | Source | Destination | Purpose | Confidence |
|---|---|---|---|---|---|
| Read | host → device | `0x1001` | `0x03EF` | Handshake, object reads, preset streams | S |
| Write | host → device | `0x1080` | `0x03ED` | Parameter/model/preset writes | S |
| Event poll | host → device | `0x1002` | `0x03F0` | Poll for pending events (`cmd=0x10`) | S |
| Event notification | device → host | `0x03F0` | `0x1002` | Unsolicited device notifications (`cmd=0x04`) | S |

The event channel is **bidirectional**: the host polls `0x1002 → 0x03F0` and the
device answers on the reverse addresses. Evidence: `packets.py`
(`EVENT_SRC`/`EVENT_DST`) and `notifications.py` (`NOTIF_SRC`/`NOTIF_DST`).

All multi-byte fields are **little-endian**.

## 4. Frame layout

Every message begins with a 16-byte area:

```text
offset  size  field        notes
0       1     body_len     length of the payload following the fixed area
1       2     reserved     0x00 0x00
3       1     magic        0x28 first handshake packet, else 0x18
4       2     source       LE
6       2     dest         LE
8       1     reserved     0x00
9       1     seq          application sequence, starts at 0x06
10      1     reserved     0x00
11      1     command      see command table
12      4     cursor       LE; stream offset or capability value
16      ...   subheader?   optional 4 bytes, message dependent
...     ...   body         MessagePack
```

**Confidence:** S (layout), C (golden bytes for known templates).

**Invariants:**

- A write must be followed by exactly one read before the next write.
- `seq` increments per request; handshake responses are discarded.
- The cursor at bytes 12–15 is zero for non-streaming commands.
- Unknown trailing bytes are preserved verbatim.

## 5. Command identifiers

| Command | Name | Direction | Trigger | Confidence |
|---|---|---|---|---|
| `0x01` | OPEN | host→device | Open an object/stream | S |
| `0x02` | HANDSHAKE | host→device | Session start | S |
| `0x04` | SESSION_OPEN | host→device | Handshake step | S |
| `0x08` | SESSION_CHUNK | host→device | Handshake / chunk request | S |
| `0x10` | POLL | host→device | Event poll | S |
| `0x12` | CHUNK_REQUEST? | host→device | Stream continuation | H |

> The Python project does not assign names to all commands; values are taken
> from the byte templates. `0x12` is inferred and must be verified.

## 6. Message tables

### 6.1 HANDSHAKE (read and write channels)

| Field | Value |
|---|---|
| Name | `HANDSHAKE` |
| Direction | host → device |
| Trigger | Session start / recovery |
| Layout | 20 bytes, fixed template |
| Magic | `0x28` |
| Expected response | 20-byte acknowledgement, discarded |
| Failure | Timeout → retry up to 5× with backoff |
| Confidence | S |
| Evidence | `packets.py`, `test_packets.py` |

Example (first read-channel packet, from `packets.HANDSHAKE`):

```text
0c 00 00 28 01 10 ef 03 00 06 00 02 ...
```

> Full template bytes are intentionally not reproduced here beyond the header;
> the golden test vector lives in the codec tests and is derived from the
> documented layout, not copied from proprietary code.

### 6.2 SESSION_OPEN_1

| Field | Value |
|---|---|
| Name | `SESSION_OPEN_1` |
| Direction | host → device |
| Trigger | Handshake step 2 |
| Layout | 28 bytes |
| Magic | `0x18` |
| Expected response | 28-byte acknowledgement |
| Failure | Timeout → session reset |
| Confidence | S |
| Evidence | `packets.py`, `session.py` |

### 6.3 SESSION_CHUNK_1

| Field | Value |
|---|---|
| Name | `SESSION_CHUNK_1` |
| Direction | host → device |
| Trigger | Handshake step 3 |
| Layout | 16 bytes |
| Magic | `0x18` |
| Cursor | `0` |
| Expected response | 16-byte acknowledgement |
| Failure | Timeout → session reset |
| Confidence | S |
| Evidence | `test_packets.py` |

### 6.4 SESSION_OPEN_2

| Field | Value |
|---|---|
| Name | `SESSION_OPEN_2` |
| Direction | host → device |
| Trigger | Handshake step 4 |
| Layout | 36 bytes |
| Magic | `0x18` |
| Expected response | 36-byte acknowledgement |
| Failure | Timeout → session reset |
| Confidence | S |
| Evidence | `packets.py` |

### 6.5 SESSION_CHUNK_2

| Field | Value |
|---|---|
| Name | `SESSION_CHUNK_2` |
| Direction | host → device |
| Trigger | Handshake step 5 |
| Layout | 16 bytes |
| Magic | `0x18` |
| Expected response | 16-byte acknowledgement |
| Failure | Timeout → session reset |
| Confidence | S |
| Evidence | `session.py` |

### 6.6 OPEN_OBJECT / OPEN_STREAM

| Field | Value |
|---|---|
| Name | `OPEN` |
| Direction | host → device |
| Trigger | Read/write an object or open a preset stream |
| Layout | 36 bytes (`OPEN_PRESETS`) or 40 bytes (`OPEN_STREAM`) |
| Body | MessagePack `{102: transaction, 100: operation, 101: {...}}` |
| Expected response | Map with `103` status and `104` result |
| Failure | `status != 0`, or `111` error code |
| Confidence | S |
| Evidence | `packets.py`, `preset.py`, `l6helix.py`, fixtures |

Known body keys:

| Key | Meaning | Confidence |
|---|---|---|
| `100` | operation / object id | S |
| `101` | request parameters | S |
| `102` | transaction id | S |
| `103` | status (`0` = OK) | S |
| `104` | result payload | S |
| `111` | error code | S |

`OPEN_STREAM` byte 34 selects the setlist (0 = Factory, 1 = User). Base offset
is `0x1000`; each 512-byte chunk exposes a fresh `0x100`-byte window.

### 6.7 CHUNK_REQUEST

| Field | Value |
|---|---|
| Name | `CHUNK_REQUEST` |
| Direction | host → device |
| Trigger | Continue a stream at `cursor` |
| Layout | 16 bytes |
| Cursor | stream offset, LE |
| Expected response | up to 512 bytes of stream data |
| Failure | repeated offset or empty window → abort |
| Confidence | S |
| Evidence | `test_build_chunk_request_layout` |

Golden bytes for `cmd=0x08`, `cursor=0x1138`:

```text
08 00 00 18 01 10 ef 03 00 08 00 08 38 11 00 00
```

### 6.8 Event channel open

| Field | Value |
|---|---|
| Name | `EVENT_HANDSHAKE` / `EVENT_OPEN` / `EVENT_CHUNK` |
| Direction | host → device |
| Trigger | Before the first poll |
| Layout | 20, 28 and 16 bytes, three request/response exchanges |
| Channel | source `0x1002`, destination `0x03F0` |
| First sequence | `0x04` after the open |
| Rest cursor | `0x1009` (`EVENT_CHUNK` cursor field) |
| Failure | Timeout → reopen the channel; the reference retries up to 5× with exponential backoff |
| Confidence | S |
| Evidence | `packets.py` (`EVENT_SEQUENCE`), `session.py` (`EventSession.handshake`) |

### 6.9 POLL (events)

| Field | Value |
|---|---|
| Name | `POLL` |
| Direction | host → device on event channel |
| Trigger | Periodic poll (device has no interrupt endpoint) |
| Layout | 16 bytes, `cmd=0x10` |
| Cursor | current event cursor, initially `0x1009` |
| Expected response | `cmd=0x10` keepalive (nothing pending) or `cmd=0x04` data frame |
| Read timeout | 200 ms |
| Failure | timeout ends the current burst; three consecutive failures → notify UI |
| Confidence | S |
| Evidence | `notifications.py`, `session.py` (`EventSession.poll`) |

**Burst drain:** for every `cmd=0x04` frame from `0x03F0`, the host advances the
cursor by `8 + declared body length`, sends a `cmd=0x08` acknowledgement, and
reads again. This repeats until a keepalive, a non-event frame or a timeout.
A single knob turn can therefore queue several events. Confidence: S.

### 6.10 Event notification

| Field | Value |
|---|---|
| Name | `NOTIFICATION` |
| Direction | device → host |
| Trigger | User action on hardware |
| Layout | frame + MessagePack `{105: opcode, 106: data}` |
| Body offset | `24` (framed: `00 00 04 00` + u32 length, then 0–3 padding bytes); offset 16 is legacy fallback only |
| Acknowledgement | `cmd=0x08` on the event channel with the advanced cursor |
| Cursor | host rest `0x1009`, advance `8 + body length`; device echo `0x0209` is not the host cursor |
| Confidence | C for fw 2.50 (14 captured events) |
| Evidence | `podgo-connect.pcapng` analysis, `events_fw250.bin`, `notifications.py` |

Opcodes:

| Op | Event | Data | Confidence |
|---|---|---|---|
| `1` | request status | `{102, 103, 104}` | C (1 capture) |
| `4` | preset active | `{107, 108}` | C (capture) |
| `6` | preset name | `{107, 108, 109}` | C (capture) |
| `8` | preset loaded | `{107, 108}` | C (capture) |
| `20` | response mirror | `{102, 103, 104}` | C (capture) |
| `21` | chain changed | `null` | C (capture) |
| `22` | scalar field | `{118, 119}`: 16 tempo, 28 slot | C (capture) |
| `30` | set_param | `{98, 119, …}` | C (capture) |
| `31` | footswitch assign | `{98, 70, 79}` | C (capture) |
| `33` | footswitch unassign | `{98, 70}` | C (capture) |
| `34` | controller assign | `{74, 71, 98, 72, 73}` | C (capture) |
| `39` | bypass (legacy) | `{98, 26}` | C (capture) |
| `40` | model changed | `{91}` | C (capture) |
| `41` | footswitch state | `{70, 63, 66}` | C (capture) |
| `42` | snapshot | `{92}` | C (capture) |
| `46` | snapshot state | `{92}` | C (capture) |
| `49` | bypass_state (absolute) | `{98, 59}` | C (capture) |

Full table with per-burst evidence: `docs/protocol/notifications.md` §4.

### 6.11 Write operations

| Op | Name | Body | Status semantics | Confidence |
|---|---|---|---|---|
| `5` | restore preset (streamed) | `{107, 108, 123: false, 124: false, 125: 0, 110: <preset blob>}` | window `103 == 1`, then continue; final `103 == 0` not observed | C capture, implemented for replay (not hardware-validated) |
| `9` | restore message | `{112: 0, 113: <u32>, 109: <name\0>, 114: 1, 115: 3, 123: false, 124: false, 125: 0, 110: <blob>}` | not observed | C capture, not implemented |
| `20` | change preset | `{101:{107:1,101:slot}}` | `103 == 0` | S |
| `21` | full chain blob | preset body | `103 in {0,1}` accepted | S |
| `30` | set param | `{98: raw chain index, 29: true, 26: 0, 28: param index, 119: f32 value}` | `103 == 0` | C (hardware-validated, fw 2.50) |
| `40` | set model | block/model id | `103 == 0` | S |
| `71` | save preset | `{107: setlist, 108: slot, 109: "<name>\0"}` | `103 == 0` | C (editor capture) |
| `86` | unknown | `{110: <215-byte opaque blob>}` | not observed | U |
| `88` | snapshot | `{92: index}` | `103 == 0` | S |

**Implemented:** op `30` (`set_param`), op `71` (`save_preset`, metadata
only) and op `5` (streamed preset restore, reading op-254 as its preamble).
All are behind the `device-write` feature plus the runtime gates described in
[../protocol/writes.md](../protocol/writes.md). The restore ops
`9`/`86`/`113` and the final op-254, op `20`, op `21`, op `40` and op `88`
remain disabled. `save_preset` is the exact frame the official editor sent in
`reverse/exports/podgo-preset-save.pcapng`; it does not touch object 14.
Restore replays only the op-5 messages from
`reverse/exports/podgo-backup-restore.pcapng` and is **not** yet
hardware-validated.

### 6.12 Object map

| Object | Content | Confidence |
|---|---|---|
| `0` | setlists | S |
| `1` | preset list (128) | S |
| `13` | IR list | S |
| `14` | per-slot u32 seal | S (semantics), U (algorithm) |
| `22` | active preset `l6-helix` blob | C (fixture) |
| `23` | active state | S |
| `24` | flags/UI state | S |

## 7. `l6-helix` container

```text
a9 "l6-helix\0"      MessagePack fixstr(9)
da 0030              str16, 48-byte offset table
<48 bytes>           offset table (monotonic; exact semantics partial)
<msgpack map>        preset body
```

Offset table observed values (from `spec02_obj22_blob.bin`), little-endian u32:

```text
0x0000003d 0x0000005f 0x000002e5 0x000002e7
0x00000413 0x00000467 0x00000621 0x0000064b
0x0000003e 0x00000651 0x00000eef 0x00000eef
```

**Confidence:** C for the magic and table presence; H for each table entry's
meaning. Preserve the table verbatim when re-encoding an unmodified preset.

## 8. String encoding

- Device strings are NUL-terminated; some arrive as MessagePack `bin` rather
  than `str`.
- `.pgp` strings are UTF-8 JSON strings.
- Rust must normalize to `String` for display while retaining the original bytes
  for re-encoding.

## 9. Timing, retry, recovery

| Parameter | Value | Source |
|---|---|---|
| Operation timeout | 2000 ms | Python |
| Event poll timeout | 200 ms | `session.py` (`EventSession.POLL_TIMEOUT_MS`) |
| Event open first sequence | `0x04` | `session.py` |
| Event rest cursor | `0x1009` | `packets.py` (`EVENT_REST_CURSOR`) |
| Drain timeout | 50 ms | Python |
| Handshake attempts | 5 | Python |
| Handshake backoff | 300 ms × attempt | Python |
| Event open backoff | 300 ms × 2^attempt | `session.py` |
| Poll interval | unspecified (UI driven) | Python |

**Safe disconnect:** stop polling, finish or abort the in-flight request, close
the handle, transition to `Disconnected`, require a full handshake on reconnect.
A partial write must never be retried blindly; re-read state first.

## 10. Checksums and integrity

- Object 14 holds a u32 per slot. Its algorithm is **unknown** (`U`).
- `zlib.crc32` over the object-22 blob is ruled out.
- `MurmurHash3` is present in the macOS binary but not proven to be the seal.
- The safe strategy is to treat object 14 as opaque and verify writes by
  re-reading the object, not by recomputing a seal.

## 11. Firmware-specific behaviour

| Behaviour | Status |
|---|---|
| Firmware 2.01 event op 49 | S (capture notes) |
| Firmware 2.50 binaries | C (analysed) |
| Object layout drift across firmware | U |
| Update/bootloader protocol `0x1FC9:0x000C` | U (not analysed; out of scope) |

## 12. Transport independence

The specification is defined over **byte streams**, not USB. A transport must
provide only:

```text
discover, open, claim, write(&[u8]), read(timeout) -> Vec<u8>, close
```

WebUSB, libusb, Android USB Host and a mock all satisfy this contract. Frame
codec, session state machine and domain logic never import platform APIs.
