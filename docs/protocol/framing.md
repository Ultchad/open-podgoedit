# Framing

## 1. Header

```text
0   1  body_len
1   2  0x00 0x00
3   1  magic        0x28 first handshake, else 0x18
4   2  source       LE
6   2  dest         LE
8   1  0x00
9   1  seq
10  1  0x00
11  1  command
12  4  cursor       LE
16  ..  subheader?   optional
..  ..  body         MessagePack
```

`body_len` counts the bytes after the fixed 16-byte area. Its exact boundary
with the optional subheader is **not fully proven** (`U`); the codec therefore
stores `body_len` and the raw remainder independently and validates them
against the slice length.

## 2. Channels

| Name | Direction | Source | Dest |
|---|---|---|---|
| Read | host → device | `0x1001` | `0x03EF` |
| Write | host → device | `0x1080` | `0x03ED` |
| Event poll | host → device | `0x1002` | `0x03F0` |
| Event notification | device → host | `0x03F0` | `0x1002` |

## 3. Command values

| Value | Meaning | Confidence |
|---|---|---|
| `0x01` | OPEN | S |
| `0x02` | HANDSHAKE | S |
| `0x04` | SESSION_OPEN | S |
| `0x08` | SESSION_CHUNK / CHUNK_REQUEST | S |
| `0x10` | POLL | S |

## 4. Handshake sequence (read channel)

```text
1. cmd 0x02  len 20  magic 0x28
2. cmd 0x04  len 28  magic 0x18
3. cmd 0x08  len 16  magic 0x18
4. cmd 0x04  len 36  magic 0x18
5. cmd 0x08  len 16  magic 0x18
```

Every packet is followed by one read whose response is discarded. The first
application sequence is `0x06`.

The event channel has its own three-packet open (`EVENT_HANDSHAKE`,
`EVENT_OPEN`, `EVENT_CHUNK`) on `0x1002→0x03F0`; after it, the event sequence is
`0x04` and the rest cursor is `0x1009`. See
[notifications.md](notifications.md).

## 5. Chunk request golden vector

`cmd=0x08`, `cursor=0x1138`:

```text
08 00 00 18 01 10 EF 03 00 08 00 08 38 11 00 00
```

This vector is asserted by `podgo-protocol` tests.

## 6. Stream reads

- Base offset `0x1000`.
- Each 512-byte chunk yields a fresh `0x100`-byte window; the trailing half
  repeats part of the stream.
- Chunk requests step the offset by `0x100` and the sequence by one, starting
  at `0x08`.
- Payloads are written at their absolute position so the next window
  overwrites the repetition. Truncating each payload to the fresh window loses
  entries that straddle a boundary.
- The stream ends on an empty payload, or early once 128 entries are visible.
- Enforce the 64-chunk / 64 KiB cap. `Session::read_preset_stream` also
  refuses a session that already carried traffic or streamed once.

## 7. Chunking and reassembly

1. Read a frame.
2. If the frame is a stream window, append the declared window.
3. Stop when the expected object length is reached or the device signals the
   end.
4. Enforce a maximum assembled size before allocating.
5. On mismatch, return `ProtocolError::Truncated` / `LengthMismatch`; never
   guess.
