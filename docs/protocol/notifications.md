# Notifications

## 1. Channel

Events arrive on the event channel from `0x03F0 → 0x1002`. The device has no
interrupt endpoint, so the host first polls on the reverse addresses
(`0x1002 → 0x03F0`) with `cmd=0x10`.

### Opening and polling

Before the first poll the host opens the channel with three request/response
exchanges (`EVENT_HANDSHAKE`, `EVENT_OPEN`, `EVENT_CHUNK`). The event sequence
then starts at `0x04` and the cursor rests at `0x1009`.

A poll sends `cmd=0x10` at the current cursor with a 200 ms read timeout. If the
response is a `cmd=0x04` data frame from `0x03F0`, the host:

1. decodes the notification,
2. advances the cursor by `8 + declared body length`,
3. sends a `cmd=0x08` acknowledgement with the new cursor,
4. reads again.

Capture detail: the host's cursor field and the device's echo are different
domains. Polls start at `0x1009` and carry the host cursor; every device reply
echoes `0x0209` regardless of the host value, so that echo must be ignored.
The advance is confirmed: after two events of 13 and 17 body bytes the host
acknowledged with `0x1009 + (8+13) + (8+17) = 0x1037`, and the next poll reused
`0x1037`. One acknowledgement may also cover a burst of frames; interleaving
one ack per frame (as the Rust session does) is equivalent and was validated by
the reference implementation.

This repeats until a keepalive, a non-event frame or a timeout, so a burst of
events from one knob turn is drained without loss. The Rust implementation
(`Session::open_event_channel`, `Session::poll_events`) follows this model and
returns every event in the burst.

## 2. Body

```text
{105: opcode, 106: data}
```

## 3. Framing

Every notification in the two fw 2.50 captures (`podgo-connect.pcapng`, 14
events; `podgo-events.pcapng`, 277 decoded events from 278 event-channel data
frames) uses the same framed shape:

```text
offset 0   16-byte vendor header   (src 0x03F0, dst 0x1002, cmd 0x04)
offset 16  00 00 04 00             subheader type: event data
offset 20  u32 LE body length      exact MessagePack length
offset 24  MessagePack body        {105: opcode, 106: data}
after body zero padding            to a 4-byte boundary (0-3 bytes)
```

The header length field at bytes 0-1 is `16 + body length`; it does not count
the 8-byte subheader. The device's own cursor echo sits at bytes 12-15 and is
not to be copied into the host cursor (see below).

The "raw window at offset 16" shape does **not** appear in this capture, and no
other event body offset was needed. The Rust decoder still tries the framed
shape first and falls back to the raw body for robustness, but the fallback is
legacy recovery, not an expected variant.

Confidence: confirmed for fw 2.50 (14 events, two preset-change bursts).

## 4. Opcodes

Derived from `podgo-events.pcapng` (POD Go Edit 2.50, fw 2.50): the eleven
guided actions were performed in order, giving 15 bursts, 278 event-channel
data frames and 277 decodable notifications. `tools/podgo-capture.py map`
reproduces the per-burst histograms below. Opcodes 0–49 are covered; nothing
above 49 was observed.

| Op | Name | Payload (key 106) | Evidence |
|---|---|---|---|
| `1` | request status | `{102: id, 103: 0, 104: null}` | one frame (id 1005); distinct from `20` in shape only |
| `4` | preset active | `{107: setlist, 108: slot}` | after every preset change, no save involved |
| `6` | preset name | `{107, 108, 109: name}` | one frame, after a preset change in the editor |
| `8` | preset loaded | `{107: setlist, 108: slot}` | first event of every preset change |
| `20` | response mirror | `{102: id, 103: 0, 104: null}` | after editor requests; ids 1009, 1024, 1025 |
| `21` | chain changed | `null` | end of an editor edit burst |
| `22` | scalar field | `{118: field, 119: value}` | field 16 = tempo BPM, 28 = slot, 124 = 1/2 state |
| `30` | set parameter | `{98: block, 119: value, 26, 28, 29}` | knob turns; one frame per step |
| `31` | footswitch assign | `{98: block, 70: footswitch, 79}` | editor bypass assign |
| `33` | footswitch unassign | `{98: block, 70: footswitch}` | editor unassign |
| `34` | controller assign | `{74: controller, 71: param, 98, 72, 73}` | editor controller assign |
| `39` | bypass (legacy) | `{98: block, 26: 0}` | once per preset change |
| `40` | model changed | `{91: model id}` | footswitch transition |
| `41` | footswitch state | `{70: footswitch, 63: bool, 66: value}` | same burst as `40` |
| `42` | snapshot | `{92: index}` | snapshot change |
| `46` | snapshot state | `{92: index}` | follows `42` |
| `49` | absolute bypass | `{98: block, 59: enabled}` | footswitch; also `null` during snapshots |

Envelope: ops `4`, `8`, `22`, `30`, `39` and `49` wrap their data as
`{82, 68, 121, 106: {...}}`; the others carry the map directly.

Note on opcode `22`: it is a scalar-field event, not a setlist event. Field
`16` is tempo and field `28` is the active slot; both were observed in the
preset-change bursts. Setlist *content* is not delivered as a notification on
any capture; it is read as operation `1` on the read channel (see
[presets.md](presets.md) §8). No opcode `29` appears in the four captures
examined (`podgo-connect`, `podgo-events`, `podgo-catalog`,
`podgo-full-backup`), so none is claimed here.

Bursts observed, in capture order:

| # | Action | Opcodes |
|---|---|---|
| 1 | editor connect | (one undecodable status frame) |
| 2 | preset change on the pedal | `8`, `22`×3, `39`, `4` |
| 3 | preset change in the editor | `20`, `8`, `22`×3, `39`, `4` |
| 4–5 | knob on the pedal | `30`×13 |
| 6 | footswitch bypass | `49`×4 |
| 7 | expression pedal + toe switch | `30`×191, `40`×2, `41`×2, `49`×2, `22`×2 |
| 8 | snapshot change | `42`×3, `46`×3, `49`×3 (null) |
| 9 | tap tempo | `22`×6 (field 16) |
| 10–11 | editor bypass assign (same burst twice) | `34`×3, `20`, `22`, `39`, `31`×3, `21` |
| 12 | editor unassign | `33`×2, `31`×2 |
| 13 | pedal bypass | `39` |
| 14 | editor controller change | `34` |
| 15 | preset change | `6`, `8`, `1`, `22`×2, `39`, `4` |

Confidence: C for the opcode↔action mapping on fw 2.50; the semantics of `1`,
`20`, `40`, `41` and the field ids inside `34` remain H.

## 5. Sync semantics

- `set_param`, `bypass_state`, `snapshot`, `tempo` update the active preset view.
- `preset_loaded` invalidates the cached active preset and triggers a re-read.
- Unknown opcodes are surfaced as `Unknown { op, data }` and never dropped.

## 6. Conflict handling

If a local edit targets the same block/param as an incoming event, the UI must
prompt the user. Incoming events never silently overwrite local edits.

## 7. Failure behaviour

- Malformed event: log, increment a counter, continue polling.
- Three consecutive poll timeouts: mark the link degraded and notify the UI.
- Disconnect: stop polling and transition to `Disconnected`.
