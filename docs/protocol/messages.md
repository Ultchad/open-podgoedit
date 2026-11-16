# Messages

All messages are described transport-independently. `Dir` is `H→D` (host to
device) or `D→H`.

## 1. Message catalogue

| Name | Dir | Trigger | Layout | Response | Failure | Confidence |
|---|---|---|---|---|---|---|
| HANDSHAKE | H→D | Session start | 20 B, magic `0x28` | 20 B ack | timeout → retry ≤5 | S |
| SESSION_OPEN_1 | H→D | Handshake 2 | 28 B | 28 B ack | reset session | S |
| SESSION_CHUNK_1 | H→D | Handshake 3 | 16 B | 16 B ack | reset session | S |
| SESSION_OPEN_2 | H→D | Handshake 4 | 36 B | 36 B ack | reset session | S |
| SESSION_CHUNK_2 | H→D | Handshake 5 | 16 B | 16 B ack | reset session | S |
| EVENT_OPEN | H→D | Event channel open | 20/28/16 B (3 packets) | 3 acks | reopen channel | S |
| OPEN | H→D | Object/stream read | 36/40 B + msgpack | `{103,104}` | status ≠ 0 | S |
| CHUNK_REQUEST | H→D | Stream continuation | 16 B | ≤512 B | repeated cursor | S |
| POLL | H→D | Event poll | 16 B, cmd `0x10` | data / keepalive | timeout ends burst | S |
| NOTIFICATION | D→H | Hardware action | frame + `{105,106}` | ack `cmd=0x08` | parse error → log & skip | S |
| CHANGE_PRESET | H→D | User selects preset | op 20 | status `103` | status ≠ 0 | S |
| SET_PARAM | H→D | Parameter edit | op 30 | status `103` | status ≠ 0 | S |
| SET_MODEL | H→D | Model swap | op 40 | status `103` | status ≠ 0 | S |
| SAVE_PRESET | H→D | Save | op 71 | status `103` | status ≠ 0 | S |
| SNAPSHOT | H→D | Snapshot select | op 88 | status `103` | status ≠ 0 | S |
| CHAIN_BLOB | H→D | Full chain write | op 21 | status `103` ∈ {0,1} | status ∉ {0,1} | S |

## 2. Body keys

| Key | Meaning |
|---|---|
| `100` | operation / object id |
| `101` | request parameters |
| `102` | transaction id |
| `103` | status (`0` OK) |
| `104` | result payload |
| `105` | notification opcode |
| `106` | notification data |
| `111` | error code |

## 3. Request/response correlation

1. Assign `seq` (wrapping `u8`, starting at `0x06` after handshake).
2. Include a transaction id in body key `102` where the message supports it.
3. Read exactly one frame.
4. Accept only if `seq`, transaction id and expected command shape match.
5. On mismatch, discard and continue reading until timeout; never treat a
   mismatched frame as success.

## 4. Status handling

| Operation | Accepted status |
|---|---|
| set param / model / save / preset / snapshot | `103 == 0` |
| full chain blob (op 21) | `103 ∈ {0, 1}` |
| error | `103 != 0` → read `111` if present |

## 5. Event messages

See [notifications.md](notifications.md).

## 6. Write milestone (gated)

`set_param` (operation 30) is implemented behind the `device-write` Cargo
feature and shipped in the web UI behind explicit runtime gates: the user arms
writes, the active preset must have been read from the pedal in the same
session, and every change is confirmed. See [writes.md](writes.md).

The following messages remain **encoded and unit-tested but never sent**:

CHANGE_PRESET, SET_MODEL, SAVE_PRESET, SNAPSHOT, CHAIN_BLOB.

They are compiled behind `#[cfg(feature = "device-write")]` and are disabled by
default.
