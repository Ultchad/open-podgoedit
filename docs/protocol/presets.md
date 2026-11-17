# Preset structures

> **Implementation status:** the binary `l6-helix` container is parsed by
> `podgo-domain`. The streamed setlist format is scanned and parsed by
> `podgo-domain::preset_list`; `podgo-session::Session::read_preset_stream`
> implements the orchestration against the mock transport. Hardware validation
> is pending. The web page ships a `.pgp`/`.pgb` adapter
> (`apps/web/src/podgoEdit.ts`) that reads both formats, edits a preset's name
> and continuous parameters **offline**, and exports a `.pgp` or a rebuilt
> `.pgb`. `.hlx` and JSON → `l6-helix` conversion are still Phase 3 (see the
> [roadmap](../roadmap.md)).

## 1. `l6-helix` device container

Observed from `spec02_obj22_blob.bin`:

```text
a9 6c 36 2d 68 65 6c 69 78 00    fixstr(9) "l6-helix\0"
da 00 30                          str16, 48 bytes
<48 bytes>                        offset table
<msgpack map>                     preset body
```

Rules:

- Preserve the magic, the table and key order when re-encoding.
- Do not assume a fixed number of top-level keys.
- Treat the offset table as opaque unless a specific field is understood.
- Store the original bytes alongside the typed view.

## 2. Typed view

```rust
pub struct Preset {
    pub meta: PresetMeta,
    pub chain: Vec<Block>,
    pub snapshots: Vec<Snapshot>,
    pub unknown: PresetUnknown, // raw map entries
}
```

`PresetUnknown` retains every key/value not mapped to a typed field, with its
original MessagePack type and position.

## 3. Block

- `model_id: u32` — key 25, index into the symbol table.
- `enabled: bool` — bypass state, separate from numeric params.
- `params: Vec<ParameterValue>` — positional values plus `@trails`, `@mic`.
- `unknown` — preserved.

## 4. Parameter

```rust
pub struct ParameterDef {
    pub name: String,
    pub min: f32,
    pub max: f32,
    pub value_type: ValueType, // Continuous | Discrete | Bool
    pub display_type: String,
}
```

Values keep the raw device representation and an optional display value/unit.

## 5. `.pgp` preset file

Confirmed shape (schema `L6Preset`, version 6):

```json
{
  "data": {
    "device": 2162696,
    "device_version": 38797312,
    "meta": {
      "application": "POD Go Edit",
      "appversion": 38797312,
      "build_sha": "v2.01-…",
      "modifieddate": 1794667337,
      "name": "…"
    },
    "tone": {
      "controller": {"dsp0": {"block1": {"Pedal": {"@controller": 1, "@min": 0.0, "@max": 1.0}}}},
      "dsp0": {
        "input": {"@input": 3, "@model": "P34_AppDSPFlowInput", "decay": 0.5,
                  "noiseGate": false, "threshold": -48.0},
        "block0": {"@enabled": true, "@model": "HD2_VolPanVolStereo",
                   "@no_snapshot_bypass": false, "@position": 0, "@type": 0,
                   "Pedal": 1.0, "VolumeTaper": false},
        "block2": {"@position": 2},
        "block9": {"@position": 9},
        "output": {"@model": "P34_AppDSPFlowOutput", "@output": 1,
                   "gain": 0.0, "pan": 0.5}
      },
      "dsp1": {},
      "footswitch": {"dsp0": {"block1": {"@fs_enabled": false, "@fs_index": 9,
                                         "@fs_label": "…", "@fs_primary": true}}},
      "global": {"@current_snapshot": 0, "@model": "@global_params",
                 "@pedalstate": 2, "@tempo": 120.0},
      "irUuidTable": {"000": "", "…": ""},
      "snapshot0": {"@name": "SNAPSHOT 1", "@valid": true, "@tempo": 120.0,
                    "@ledcolor": 0,
                    "blocks": {"dsp0": {"block0": true}},
                    "controllers": {"dsp0": {"block0": {"Drive":
                                     {"@fs_enabled": false, "@value": 0.5}}}}},
      "snapshot1": {}, "snapshot2": {}, "snapshot3": {}
    }
  },
  "meta": {"original": 0, "pbn": 0, "premium": 0},
  "schema": "L6Preset",
  "version": 6
}
```

- Parameter names are semantic; the device uses positions. Values are in the
  units the model catalog declares (for example `FcHigh: 2155.0` is Hz), so the
  page can render them through the same catalog as a device read.
- `dsp0.block0`…`block9` are the ten processing slots. An unused slot keeps
  `{"@position": n}` rather than disappearing.
- `@fs_index` is 1-based: `1`…`8` are `FS1`…`FS8`, `9` is the expression toe
  switch. The switch target is the containing block (slot `n + 1`).
- `@current_snapshot` is 0-based; `snapshot0`…`snapshot3` carry the names and
  validity flags. The POD Go Owner's Manual limits a custom snapshot label to
  10 characters (the Rename Snapshot screen); `@name` is plain text in the
  JSON export and NUL-terminated in the binary blob.
- A snapshot may also store `blocks.dsp0.blockN` (bypass, per snapshot),
  `controllers.dsp0.blockN.<Param>` (`@fs_enabled`, `@value`) and
  `@ledcolor`. The parameter `@value` is written as `0`/`1` for boolean
  parameters, like the rest of the JSON export.
- `@ledcolor` is a palette index, not RGB: `0` Auto, `1` White, `2` Red,
  `3` Dark Orange, `4` Light Orange, `5` Yellow, `6` Green, `7` Turquoise,
  `8` Blue, `9` Violet, `10` Pink, `11` Off.
- The Snapshots controller number (`@controller`) is `10` in Line 6 `.hlx`
  files. POD Go uses the same controller table, but a POD Go hardware capture
  is still missing, so `10` is **ITM** here; controllers `1`/`2` are EXP 1/2
  and are evidenced by the `.pgp` fixtures.
- `device_version` is packed BCD: `0x02500000` reads as firmware `2.50`.

## 6. `.pgb` backup

The container is **`AF6L`**: a 48-byte header, a payload of consecutive zlib
members, then an `IDGP` directory at the end.

```text
00  "AF6L"
04  u32   format version (1)
08  u64   directory offset
16  …     header fields (reserved / timestamps)
48  payload starts (setlist name table, then zlib members)

directory (at the offset from header +8)
+0  "IDGP"
+4  u32   header length (24)
+8  24-byte header body
+32 record 0 … record n, 36 bytes each:
      u32  reserved (0 in observed files; name length if non-zero)
      char tag[4], stored reversed ("MNLS" = "SLNM")
      u64  payload offset
      u64  stored size
      u32  codec: 0 = stored, 1 = zlib
      u64  original size
```

Observed tags and members:

| Tag | Content |
|---|---|
| `SLNM` | stored setlist names, NUL-separated (`Factory\0User\0`) |
| `GLOB` | JSON globals (no schema; `DSP`, `EQ`, `System`, `Tuner`) |
| `I000` | RIFF/WAVE impulse response (raw binary) |
| `UMDS` | `L6UMDArchive`: model/parameter catalogue, no preset data |
| `SL00` | `L6Setlist` Factory |
| `SL01` | `L6Setlist` User |

Each `L6Setlist` is version 2 and carries `data.meta.name` plus
`data.presets`: exactly 128 entries. A non-empty entry is the same body as
`.pgp`'s `data` (`device`, `device_version`, `meta`, `tone`); an empty slot is
`{}`.

Rules:

- Enforce decompression limits: a member declares its original size, and a
  backup can be large.
- Identify members by tag first and by content (`schema`) second; do not rely
  on stream order.
- Never execute or render imported content. The web adapter builds a typed,
  read-only view and keeps the file in memory only.
- The JSON format is **not** the pedal's `l6-helix` body. This build can read,
  edit and export it offline, but it cannot write it to the pedal; that needs an
  evidenced JSON → `l6-helix` encoder.

### Exporting a backup

`serializePgb` rebuilds the container from the parsed backup. The header, the
`IDGP` directory body, the trailer and every untouched member keep their exact
bytes (impulse responses and `UMDS` included); only the setlist whose slot was
edited is re-serialized with `JSON.stringify(doc, null, 1)` and recompressed
with `CompressionStream('deflate')`. Directory offsets and the header directory
pointer are then patched.

The layout is `ITM`: it reproduces the observed `AF6L` file (48-byte header,
consecutive members, 36-byte records, 4-byte trailer). POD Go Edit has not been
asked to open a re-written backup. A local round trip (import → export without
edits) produced a decompressed setlist that deep-equals the original, and
`SLNM`, `GLOB`, `I000`, `UMDS` and the unedited `SL00` were byte-identical.

## 7. Offline edit and `.pgp` export

`apps/web/src/podgoEdit.ts` keeps the parsed `L6Preset` document, so an edit
touches exactly one field and the export keeps every other key, including
fields this build does not understand.

- **Editable:** the preset name (`data.meta.name`) and the continuous
  parameters of a block (`data.tone.dsp0.block<0-9>[<catalog name>]`). Values are
  written in the units the catalog declares, so a 0..1 knob stores its raw
  fraction.
- **Export:** `Export .pgp` serializes the document with `JSON.stringify(doc,
  null, 1)`. The real export was compared with the original file: **0 semantic
  differences**, only whitespace differs (the vendor writer pads `"key" :`, JSON
  writers do not).
- **Preset from a `.pgb`:** a setlist entry only holds the `data` body, so the
  envelope is rebuilt with the shape observed in official exports
  (`schema: "L6Preset"`, `version: 6`, top-level
  `meta: {original, pbn, premium}`). That envelope is `ITM` (inferred from the
  observed file), not a confirmed writer contract; the body itself is copied
  verbatim.
- **Backup (`.pgb`) export:** the imported container is rebuilt with the
  working preset in the slot it came from. A setlist entry keeps the observed
  body shape (`device`, `device_version`, `meta {build_sha, name}`, `tone`),
  so fields this build does not understand inside `tone` survive with the
  draft's parameter changes.
- **Not offered:** `.hlx`, model swaps, and any write to the pedal from an
  imported preset.

## 8. Streamed setlist

Confidence: strongly supported for the User setlist (validated against a real
capture and replayed on hardware, firmware 2.50); the Factory variant is
confirmed for the header case below, and the transport flow is exercised in
`apps/web` against a fake device.

```text
open presets (0x06)  -> may be a plain 16-byte ack or carry data
open stream (0x07, byte 34 = setlist)
                     -> data starts 8 bytes into the body (24-byte frame offset)
chunk requests from 0x1000, step 0x100, seq from 0x08
                     -> 512-byte packets; first 0x100 bytes are fresh
```

Reassembly rules:

- Keep the data carried by the open response as the head of the buffer.
- Place each chunk payload at `head_len + (offset - 0x1000)`; the next chunk
  overwrites the repeated half instead of appending duplicates.
- Stop on an empty payload, or once 128 entries are visible.
- Cap the stream at 64 chunks / 64 KiB.
- Streaming requires a fresh session; a second stream on a used session
  desynchronises the device, so reconnect first.

Observed Factory variant (firmware 2.50, POD Go Wireless): the open response is
a plain 16-byte ack, so the 8-byte data-message header (`00 00 02 00` plus a
32-bit payload length) arrives at the start of the first chunk payload. The
User stream in the same session starts directly on the MessagePack wrapper
because the open response already carried the header. Keep the bytes as-is:
the scanner skips non-MessagePack prefixes, and stripping them would shift
every subsequent chunk by eight bytes.

Each entry is `81 cd HI LO 84 cd 00 6d <name\0> ...`: an outer map keyed by a
uint16 preset id, containing the name under key `109` (also encoded as
uint16). The **stream position** is the slot (program-change number); the
encoded id is a stable preset id that can differ after reordering. Names are
NUL-terminated and may be `str` or `bin`.

## 9. Object reads (22 and 23) in captures

Operation 4 opens a preset body; operation 1 opens a setlist. An open request
uses the read channel (`0x1001 → 0x03EF`, `cmd=0x04`) and its MessagePack body
starts at byte 24:

```text
{102: transaction, 100: 4, 101: {107: setlist, 108: slot, 101: 2}}
```

The response is a map `{102, 103: status, 104: result}`. For a preset,
`104` is the `l6-helix` container stored as a MessagePack **`str16`**
(marker `da`), not a `bin` marker; decoding it as text corrupts the payload.
Empty User slots answer with `104: null` and only 9 body bytes.

Two response framings appear in the captures:

| Framing | First data frame | Continuation frames |
|---|---|---|
| Official editor (USBPcap) | u32 body length at offset 20, body at 24 | raw stream bytes from offset 16 |
| Own WebUSB reads | data at 16, optional `01 00` + u32 length prefix | data at 16; a 16-byte empty response ends the object |

The first data frame after an open decides the shape. Official-editor data
frames are 272 bytes on the wire (16-byte header + up to 256 stream bytes), so
the declared body length is the authority for when the object ends.
`tools/validate_catalog.py` implements both shapes and reassembles 125 complete
Factory/User presets from `reverse/exports/podgo-full-backup.pcapng`.

The final chunk may be sent at full size, leaving zero padding after the
MessagePack map. Decode only the first value of the reassembled object; key 104
has its own length, so the blob itself does not contain that padding.

The same open accepts a target slot: `{107: setlist, 108: slot, 101: 2}` returns
that slot's body instead of the active one. The official editor uses this 134
times during a backup (108 Factory and 26 User slots, eight of them empty), and
the web app exposes it as a read-only librarian click. A slot read does not
need object 23, so the preset name comes from the setlist entry.

Object 23 is an *active-state* query, not a precondition for reading the body.
If the pedal stays silent for it, the web app falls back to the object-22 open
(`{107: 0, 101: 2}`) alone. That request is byte-identical to the object-22 step
of the two-object flow, so no slot has to be guessed; the setlist/slot and name
remain unknown until the page supplies them.

Each object starts with a fresh five-packet handshake. The pedal often ignores
the first handshake that follows an object, so a client should replay the five
packets in place rather than restart the read: object 23's state is already in
hand and a full restart would lose it.

The IN endpoint also carries event notifications (`0x03F0 → 0x1002`). The
transport matches responses on the mirrored source/destination pair and never
substitutes an event frame for a missing response. A burst of events may delay
a read by filling the queue, but it cannot satisfy it.

## 10. Round-trip invariants

1. `decode(encode(preset)) == preset` semantically.
2. Unmodified preset re-encodes byte-identically.
3. Unknown map entries keep order and type.
4. String vs binary distinction is preserved.
5. Integer width is preserved where it affects bytes.

## 11. Fixtures

| Fixture | Purpose |
|---|---|
| `spec02_obj22_blob.bin` | Raw container |
| `spec02_a.pgp` | `.pgp` reference |
| `spec02_obj14.bin` | Opaque seal table |
| `user_setlist.bin` | 128-entry reference stream |
| `factory_setlist_fw250.bin` | Factory stream captured on fw 2.50; starts with the 8-byte data header |
| `events_fw250.bin` | Length-prefixed notification frames from the fw 2.50 capture |
| `events_actions_fw250.bin` | One frame per opcode from the guided action capture |

The import test builds synthetic `.pgp`/`.pgb` bytes at runtime with invented
preset names (`apps/web/tests/import.spec.ts`), so no personal backup is
committed. The structures above were verified against local POD Go Edit
exports; those files stay outside the repository.

Fixtures are copied into the new `fixtures/` directory only if their
redistribution is confirmed.
