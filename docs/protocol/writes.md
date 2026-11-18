# Writing to the pedal

This page documents the writes this build performs:

- **`set_param` (operation 30)** — one continuous effect parameter on the
  preset the pedal currently has active. Hardware-validated on a POD Go
  Wireless (fw 2.50) since 2026-11-13, see §2.0.
- **`save_preset` (operation 71)** — store the active preset (its current
  sound, including parameters set with op 30) under a User slot and name. The
  command carries only the destination and the name: the pedal commits its own
  edit buffer, so no body upload is needed. Implemented and unit-tested
  against the editor frame captured on 2026-11-13, see §2.5.
- **`set_model` (operation 40)** — load a catalog model into one chain slot;
  the pedal creates the block with its own defaults. Implemented from the MIT
  reference's annotated capture, **not hardware-validated**, see §2.9.
- **Full backup and restore (`.pgbak` + operation 5)** — read both setlists
  and every non-empty slot into a self-checking container, then stream the raw
  bodies back. The restore frame layout comes from
  `reverse/exports/podgo-backup-restore.pcapng`, but no restore from this build
  has been applied to a pedal yet, see §2.6 and §2.7.

All three paths leave the read-only milestone and are gated so that they can
never run by accident.

Confidence labels follow the project convention (`C` = capture or
hardware-validated reference, `H` = hypothesis, `S` = strongly supported but
not independently reproduced).

## 1. What is implemented, and what is not

| Operation | Status | Notes |
|---|---|---|
| `set_param` (30), continuous effect parameter | Implemented, gated | Edits the active preset in RAM |
| `set_param` on input/output/looper | Not implemented | Same op, but the raw chain index and parameter order are not verified for these stages |
| `set_model` / model swap (40) | Implemented, gated | Adds or replaces the model in one slot; layout from the reference capture, **not hardware-validated** |
| `save_preset` (71) | Implemented, gated | Stores the active preset (current sound) under a User slot; captured from the editor |
| Whole-chain write (op 21) | **Not implemented** | High corruption risk, object-14 seal unresolved |
| Preset copy/move between slots | Not implemented | Needs the chain blob write |
| Preset restore (op 5, streamed) | Implemented, gated | Op 5 only; **not hardware-validated** |
| Restore op 9 / 86 / 113 and the final op 254 | **Not implemented** | Semantics unresolved; not needed for a replay of the captured op-5 stream |

`set_param` changes the preset in RAM only. Recalling another preset,
switching snapshots that restore the parameter, or powering the pedal off
discards the change unless it is followed by `save_preset`. The Save button
does exactly that: it applies every draft with op 30, then sends op 71 for the
active preset's own User slot, so one confirmation both edits and stores the
preset. A full restore replaces preset bodies on the pedal and also survives a
reboot.

## 2. Write channel

| Field | Value | Confidence |
|---|---|---|
| Source / destination | `0x1080 → 0x03ED` | C |
| Response pair | `0x03ED → 0x1080` | C |
| Vendor interface | 0, bulk OUT `0x01`, bulk IN `0x81` | C |
| Body offset | 24 (framed: `00/01 00 06 00` + u16 length at 20–21) | C |
| Command subheader | `01 00 06 00` | C (reference) |
| Header byte 0 | `16 + body length` | C |
| Header byte 3 | `0x18` | C |
| Header byte 11 | `0x04` | C |

### 2.0 Hardware validation (2026-11-13)

First successful write on a **POD Go Wireless** (`0x424b`), firmware 2.50,
POD Go Edit closed, preset "New Preset", amp **US Double Nrm**:

```text
[15:55:35.920] Writing US Double Nrm · Drive = 9.0 (block 6, param 0, raw 0.9000)…
[15:55:36.375] Write accepted after 1 attempt(s); frame
  27 00 00 18 80 10 ed 03 00 05 00 04 5b 10 00 00
  01 00 06 00 17 00 00 00
  83 66 cd 07 d1 64 1e 65 85 62 06 1d c3 1a 00 1c 00 77 ca 3f 66 66 66 00
```

- The pedal applied the change (read back on the unit and with **Read active
  preset**: `0.9`).
- The frame matches `encode_set_param(block, param, value, transaction, 5,
  cursor)` byte for byte: op `1e` (30) at offset 30, `98: 06`, `29: c3`,
  `26: 00`, `28: 00`, `119: ca 3f 66 66 66` (`0.9f`), cursor `0x105b`
  (`0x1009` + 17 from object 76).
- The log also showed the **first write handshake being ignored** after a read
  session (same symptom as the read channel). The driver now replays the four
  handshake packets in place before restarting the whole flow.

Confidence after this run: **C** for the channel, handshake, cursor and the
`set_param` payload keys on fw 2.50; still `S` for other firmware versions and
for the input/output/looper stages.

### 2.1 Handshake

Four packets, each followed by one response:

| # | Packet | Response | Role |
|---|---|---|---|
| 1 | `0c 00 00 28 80 10 ed 03 …` | bare ack | handshake |
| 2 | `11 00 00 18 … 06 00 00 00` | bare ack | session open |
| 3 | `08 00 00 18 … 09 10 00 00` | bare ack | chunk grant, cursor `0x1009` |
| 4 | `19 00 00 18 … {102:1000, 100:76, 101:{}}` | framed object-76 status | open object 76 |

The stream cursor after the handshake is `0x1009` plus the advance of object
76's response (`8 + u16 body length` for a framed body, `0` for a bare ack,
`len - 16` for a raw window). The first application sequence number is `0x05`.

The pedal ignores the first write handshake right after a read session
(observed on hardware, 2026-11-13), so the page replays the four packets in
place up to five times with exponential backoff (300 ms, 600 ms, 1.2 s, 2.4 s)
before restarting the whole flow.

### 2.2 `set_param` body

```text
{102: <transaction>, 100: 30, 101: {98: <block>, 29: true, 26: 0,
                                     28: <param>, 119: <f32 value>}}
```

| Key | Meaning | Confidence |
|---|---|---|
| `102` | transaction id, echoed in the status body | C |
| `100` | operation `30` | C |
| `101.98` | **raw** chain index: input is `0`, so a processing slot `n` is usually `n + 1` | C (reference, hardware-validated) |
| `101.29` | `true` (constant) | C |
| `101.26` | `0` — must stay `0` | C (reference: the index here yields status `255`) |
| `101.28` | parameter index (catalog position) | C (reference, hardware-validated) |
| `101.119` | value as MessagePack `f32` (`ca`, big-endian) | C (reference) |

Key order matters: `102`, `100`, `101`; inside `101`: `98`, `29`, `26`, `28`,
`119`.

### 2.3 Golden vector

Block 6, parameter 3, value `0.5`, transaction 1000, sequence 5, cursor
`0x203f`:

```text
27 00 00 18 80 10 ed 03 00 05 00 04 3f 20 00 00
01 00 06 00 17 00 00 00
83 66 cd 03 e8 64 1e 65 85 62 06 1d c3 1a 00 1c 03 77 ca 3f 00 00 00
00
```

This vector was originally derived from the reference builder. It is now
confirmed: the hardware frame in §2.0 and ten editor-sent op-30 frames in
`podgo-preset-save.pcapng` all match the encoder's shape. The assertion lives
in `crates/podgo-protocol/src/write.rs`
(`set_param_frame_matches_the_golden_vector`).

### 2.4 Status

The device answers the command with one or more bare acknowledgements (16
bytes) and then a framed echo:

```text
{102: <transaction>, 103: <status>, 104: nil}
```

`103 == 0` means the pedal applied the change; `255` (with an optional `111`
error code) means it rejected it, typically because the cursor was out of step
or the parameter index was sent in key `26`.

### 2.5 `save_preset` (operation 71)

#### 2.5.1 Capture evidence

`reverse/exports/podgo-preset-save.pcapng` (SHA-256 `50b02ded…d01946`,
POD Go Edit, fw 2.50) contains exactly one op-71 request:

```text
2a 00 00 18 80 10 ed 03 00 3e 00 04 e8 1f 00 00
01 00 06 00 1a 00 00 00
83 66 cd 03 f8 64 47 65 83 6b 01 6c 24 6d ab 4e 65 77 20 50 72 65 73 65 74 00
00 00
```

Decoded body:

```text
{102: 1016, 100: 71, 101: {107: 1, 108: 36, 109: "New Preset\0"}}
```

- transaction `1016`; sequence `0x3e`; cursor `0x1fe8` (the save arrived after
  a long editor session, not right after the handshake);
- destination setlist `1` (User), slot `36`;
- name `New Preset` with the trailing NUL the pedal stores;
- header byte 0 `0x2a` = 16 + 26-byte body; two padding bytes after the body.

The command carries **no preset body**: no object-14 read and no upload
appear anywhere in the save capture. The pedal stores its own edit buffer, so
parameters already applied with op 30 are written to flash by this one
command, and saving stays independent of the object-14 seal that still blocks
whole-chain writes.

The response is the usual framed status `{102: 1016, 103: 0, 104: nil}` with
`62 06 1d` padding, and the event channel reports
`{105: 6, 106: {107: 1, 108: 36, 109: "New Preset\0"}}`.

#### 2.5.2 Body and encoder

```text
{102: <transaction>, 100: 71, 101: {107: <setlist>, 108: <slot>,
                                     109: "<name>\0"}}
```

Key order matters: `102`, `100`, `101`; inside `101`: `107`, `108`, `109`.
Names are 1..=16 printable ASCII bytes; `encode_save_preset` appends the NUL
and rejects anything else. The frame builder is shared with `set_param`, so
the header, subheader, cursor and padding rules are identical.

Golden vector (the captured frame, asserted by
`save_preset_frame_matches_the_captured_editor_frame`):

```text
2a 00 00 18 80 10 ed 03 00 3e 00 04 e8 1f 00 00
01 00 06 00 1a 00 00 00
83 66 cd 03 f8 64 47 65 83 6b 01 6c 24 6d ab 4e 65 77 20 50 72 65 73 65 74 00
00 00
```

#### 2.5.3 Runtime safety

The UI restricts the destination to the **User** setlist. Before op 71 is
sent, the page:

1. reads the destination slot over the read channel (operation 4 with
   `{107: 1, 108: slot, 101: 2}`), keeping the byte-exact body in memory;
2. computes its SHA-256 digest and downloads it as
   `podgo-user-<slot>-backup.bin`;
3. displays the digest and requires the user to tick an acknowledgement. A
   free slot (read answers `key 104 is not a blob: nil`) is recorded as an
   empty destination: there is no body to preserve, but the acknowledgement
   is still required.

After the pedal answers status `0`, the page re-reads the User setlist and
checks that the destination slot now reads the requested name. A mismatch is
reported in the diagnostics log without pretending the write failed.

### 2.6 Backup (`.pgbak`)

The backup is produced entirely on the host. The page reads the setlists with
`ReadFlow`, then reads the selected slots that have a name with
`PresetFlow::for_slot` (operation 4, `{107: setlist, 108: slot, 101: 2}`) and
feeds the raw key-104 `l6-helix` body, unchanged, to `BackupBuilder`. No preset
is decoded or re-encoded, so a body restored later is byte-identical to the one
read.

A full backup covers both setlists; a partial backup can cover one setlist or
an arbitrary set of slots. Both produce the same versioned container, so the
restore flow streams either one unchanged.

The container is versioned and self-checking
(`crates/podgo-domain/src/backup.rs`):

```text
0..8    magic "PODGOBK\0"
8..10   format version (u16 LE, currently 1)
10..12  flags (u16 LE, must be 0)
12..16  entry count (u32 LE)
16..18  product length (u16 LE)
18..20  firmware length (u16 LE)
20..24  total file length (u32 LE)
24..64  reserved zeros
...     product bytes, firmware bytes
...     entries, sorted by (setlist, slot)
last 32 SHA-256 of every preceding byte
```

```text
entry: setlist u8 | slot u8 | name length u8 | flags u8
       blob length u32 LE | name bytes | blob bytes | SHA-256(blob) (32 bytes)
```

`verify_backup` in the Rust core rejects a wrong magic or version, a
truncated entry, an out-of-range setlist/slot, a duplicate slot, a per-entry
digest mismatch or a whole-file digest mismatch. The page calls it again on the
bytes it just encoded, and on any file the user selects for a restore.

Backup fails closed: a truncated setlist, a truncated preset or any error other
than "empty slot" aborts the file. Slots whose setlist name is empty, or whose
read answers `key 104 is not a blob: nil`, are reported as skipped instead.
The file is downloaded as `podgo-full-backup-<timestamp>.pgbak` or
`podgo-selected-backup-<timestamp>.pgbak`; its SHA-256 is shown in the restore
dialog as the last safety copy. Taking one is recommended but never a
precondition for a write.

`subset_backup` in the WASM crate (over the Rust domain `Backup`) re-encodes a
selection of entries from a verified file with the same product/firmware
header. The restore dialog uses it when the user unchecks entries, so only the
checked bodies are streamed; the whole-file digest is recomputed for the
subset.

### 2.7 Restore (operation 5, streamed)

#### 2.7.1 Capture evidence

`reverse/exports/podgo-backup-restore.pcapng` contains **157** op-5 messages
(117 Factory and 40 User). Every message is sent on the **read** channel
(`0x1001 → 0x03EF`), `cmd = 0x04`. The first message starts at transaction
1579, setlist 0 / slot 0, with a 4171-byte body, sequence 146 and cursor
`0x52fd`:

```text
f8 01 00 18 01 10 ef 03 00 92 00 04 fd 52 00 00
01 00 02 00 4b 10 00 00 83 66 cd 06 d3 64 05 65 86 …
```

Framing recovered from the 157 messages:

| Item | Value | Confidence |
|---|---|---|
| Subheader of the first frame | `01 00 02 00` | C |
| Declared body length | `u32` LE at offset 20 | C |
| First-frame data | offset 24, at most 488 bytes | C |
| Continuation data | offset 16, at most 496 bytes | C |
| Header `u16` (bytes 0..2) | `16 + data` (first), `8 + data` (continuation) | C |
| Padding | zeros to a 4-byte frame boundary | C |
| Body transaction | `cd` (u16) when below 65536 | C |
| Key `110` marker | MessagePack `str` (`da`/`db`), never `bin` | C |
| Stream status | `{102: tx, 103: 1, 104: nil}` after **every** frame | C |
| Cursor after a status | previous + 17 (`8 + 9`) | C |
| Next message cursor | the cursor reached after the last status | C |

The pedal acknowledges **each USB packet**, not a fixed byte window. In the
capture the statuses follow 488, 917, 1313, 1706, 2124, … body bytes, i.e. once
per 512-byte transfer. The encoder therefore marks every frame as a window end,
waits for status 1 after each one, and advances the cursor by 17 each time
(`0x52fd → 0x530e → …`). An earlier build waited for a single 1536-byte window;
the pedal's per-packet statuses were then consumed as bare acks and the next
frame was never granted, which is what produced *"the pedal did not
acknowledge the restore stream window"*.

The first op-5 frame after the preamble uses sequence 6 and cursor `0x101a`;
the five preamble packets are `READ_SEQUENCE` (the op-254 packet at `0x1009`
is `SESSION_OPEN_2`).

The capture also contains a 16-byte `cmd = 0x08` host acknowledgement after each
status. This build does **not** send those acknowledgements and advances the
sequence by the frame count alone. This is a known fidelity gap, not a
validated requirement.

#### 2.7.2 Body and encoder

```text
{102: <transaction>, 100: 5,
 101: {107: <setlist>, 108: <slot>, 123: false, 124: false, 125: 0,
       110: "<raw l6-helix body>"}}
```

Key order matters: `102`, `100`, `101`; inside `101`: `107`, `108`, `123`,
`124`, `125`, `110`. The raw body is stored as a MessagePack `str`; the device
does not accept a `bin` marker in key `110`. `encode_restore_preset` rejects a
setlist above 1, a slot above 127, an empty body and a body above the 64 KiB
stream limit. `encode_restore_stream` performs the framing, padding, per-frame
status wait and cursor advance described above.

The restore sends **operation 5 only**. The operation-9 message, the
operation-86 blob, the 570 operation-113 requests and the final operation-254
message in the same capture are not replayed; their semantics remain
unresolved.

#### 2.7.3 Runtime safety

Restore is destructive and has **one** gate on top of the session arm switch:

1. the `device-write` feature must be compiled in and the user must have armed
   writes for the session;
2. the selected entries are encoded as a subset `.pgbak` in Rust
   (`subset_backup`), then verified; its digest and a per-setlist destination
   diff (slots replaced, slots filled, slots left untouched) are shown next to
   the write button;
3. the user clicks **Restore N preset(s)**, where `N` is the number of checked
   entries, then accepts the single `window.confirm` that names that count and
   the subset digest.

A backup is offered in the same dialog as a safety copy, but it is **not**
required and never blocks. The backup can be full or partial; a partial backup
is not a substitute for a full one. There is no typed word and no
acknowledgement checkbox.

After the last message, the page re-reads both setlists and compares every
backup entry's slot name with what the pedal reports. Mismatches are logged as
warnings; they do not claim the restore failed. A successful restore clears the
last session backup shown in the dialog, because the pedal no longer matches
its pre-restore state. A failed restore is reported with the message from the
failed window or preamble; because earlier messages may already have been
applied, the pedal may hold a partially restored set.

**No restore from this build has been applied to hardware.** Validate it first
on a pedal whose full backup has been downloaded and checked, following
`docs/development/manual-testing-todo.md`.

### 2.8 Library actions: copy, paste, move, rename

The toolbar's **Actions…** dialog separates the in-page model from the pedal:

- **Copy** keeps the loaded raw `l6-helix` body and its setlist/slot/name in an
  in-memory clipboard. Nothing is sent.
- **Paste** and **Move** update the in-memory setlist model, and a pending
  marker records the edit. **Rename** updates the model name the same way.
  Pending edits exist only in the page: a later setlist read, reload or written
  operation replaces them.
- **Write paste to pedal** builds a **one-entry `.pgbak`** with `BackupBuilder`
  (product/firmware from the loaded preset) and replays it with `RestoreFlow`,
  i.e. the same operation-5 stream as a full restore. Only the User setlist is
  accepted. It needs armed writes and one `window.confirm` naming the
  destination and its current name; a full backup is optional.
- **Write rename to pedal** uses operation 71, which stores the **active
  preset's** metadata. It is therefore offered only when the editor shows the
  active preset and the slot is in the User setlist. One `window.confirm` is
  the only gate. Renaming a different slot is local-only.

Limits, stated in the dialog:

- There is **no evidenced delete/clear operation**. A move copies the body to
  the destination and leaves the source on the pedal; only the local model
  clears it.
- Operation 5 may store the body without updating the setlist name (the name
  appears to travel in operation 9, which this build does not send). After a
  write the page re-reads the User setlist and logs a warning if the name did
  not change.
- Neither write path is hardware-validated; both are `ITM`.

### 2.9 `set_model` (operation 40)

#### 2.9.1 Evidence

This repository has **no capture of an op-40 request**. The layout comes from
the MIT-licensed `openpodgo` reference, which annotates it from
`change-pedal-from-app.pcapng` packet 35 and reports that the pedal loads the
model with its defaults and then reports them on the event channel:

```text
{102: <transaction>, 100: 40, 101: {98: <raw block>,
                                    100: {23: <no_snapshot_bypass>,
                                          25: <wire_id>, 26: -1}}}
```

- `98` is the **raw** chain index in `DSP_CHAIN`, exactly like `set_param`
  (input = 0), so processing slot `i` is `i + 1`.
- `100` inside `101` is the model node, the same shape as the `l6-helix`
  block model (`25` = on-wire id, `23` = `@no_snapshot_bypass`, `26` = `-1`).
- The reference's capture used block 5 and wire id 433
  (`HD2_DistDeezOneVintageMono`).

Status: **`ITM`** — the encoder and its tests are offline only; no frame from
this build has been sent to a pedal yet.

#### 2.9.2 Interaction with op 30 and op 71

Parameters are not part of op 40: the pedal creates the block with its own
defaults. The page therefore:

1. updates the in-memory chain (catalog defaults, existing bypass flags) as a
   draft and drops the old model's parameter drafts and controller/snapshot
   overrides for that slot;
2. on Save, sends one op 40 per changed slot, then the queued op-30 parameter
   drafts, then op 71 for the active User slot.

An **empty slot** is the least proven case: op 40 is expected to create the
block, but nothing here has seen it on hardware. If the pedal rejects it, Save
reports the status and the draft stays queued. Structural writes that reorder
the chain (op 21) are still not implemented.

## 3. Runtime gates (ADR-0007)

A write is sent only when **all** of these hold:

1. the `device-write` Cargo feature is enabled (the WASM crate enables it; the
   core crates do not);
2. the page is connected over WebUSB;
3. the user ticked **Enable device writes** for this session;
4. the editor shows the preset read from the pedal's **active** preset this
   session — a file, a fixture or a librarian slot read disarms writes;
5. the user made one explicit confirmation for the action: the per-change
   `window.confirm` (`set_param`, `save_preset`, rename, paste) or the
   **Restore N preset(s)** button plus its single `window.confirm`.

`save_preset` adds two more gates: the destination is limited to the **User**
setlist, and the slot must have been read in the same dialog with its SHA-256
digest displayed and downloaded. That per-slot backup is part of the save
command's own contract (op 71 defines the destination), not a session-wide
precondition.

`restore` replaces gate 4 with its own: the file is verified in Rust and the
destination diff is shown before the button enables. It does not read the
active preset and is not limited to the User setlist. It does **not** require a
fresh session backup, a typed word or an acknowledgement checkbox.

The byte-exact copy of the preset read from the pedal stays in memory, so
**Download .bin** still produces the pre-write backup. The structure shown in
the editor is updated optimistically after the pedal accepts the change; the
backup is not rewritten. A successful parameter write, save or restore clears
the last full backup shown in the dialog, because it no longer describes the
pedal.

## 4. Evidence and open questions

- The `set_param` payload keys and the cursor rules come from the reference
  implementation (`reverse/openpodgo`, MIT), which states that they were
  verified on hardware. The 2026-11-13 run confirmed them on fw 2.50
  (amp Drive `0.9` applied and read back). No capture of an editor-sent
  `set_param` frame exists yet, so the comparison with POD Go Edit is still
  open.
- The op-30 *notification* (`{98, 119, …}` on the event channel) is captured
  (fw 2.50), which confirms that the pedal reports the same keys after a
  change.
- `set_model` (op 40) has no capture in this repository. Its layout is the
  reference's annotated frame only (`ITM`), and it is the youngest write path
  here: neither a filled slot nor an empty one has been confirmed on
  hardware.
- `save_preset` is stronger: its frame is taken from an editor capture, and
  the destination, name and status/event sequence match byte for byte. It is
  not yet hardware-validated from this build.
- Restore uses the op-5 framing recovered from
  `reverse/exports/podgo-backup-restore.pcapng` (157 messages). The frame
  layout, key order, padding, window status and cursor advance are `C` on that
  capture. Applying a restore from this build is **not** hardware-validated:
  the pedal may reject a window, and a mid-stream failure leaves earlier
  presets written. Validate on a backed-up pedal before relying on it.
- Op 86 (`{110: <215-byte blob>}`), op 9 (key `113`), op 113 and the final
  op 254 remain unexplained. They are not sent by the restore, so their
  absence is the main fidelity risk for a full device-to-device replay.
- The capture's 16-byte `cmd = 0x08` host acknowledgements after window
  statuses are not reproduced; the sequence numbers of later messages differ
  by one per window as a result. The device accepted the capture's stream, but
  whether it requires the acknowledgements is unknown.
- Input/output stages, the looper, model swaps, bypass and whole-chain writes
  are not covered; do not extend the write path to them without new evidence.
- A failed write is logged with the full frame so a capture can be compared
  byte for byte.

## 5. Tests

| Layer | Test |
|---|---|
| Frame builders | `cargo test -p podgo-protocol --features device-write` (`set_param`, captured op-71, op-254 and op-5 golden/stream vectors, name validation, op-40 structure) |
| Container | `cargo test -p podgo-domain` (`backup::tests`: round trip, digests, duplicates, tamper, out-of-range entries) |
| Flow state machine | `apps/web/wasm` `write::tests` (handshake, bare acks, status, rejection, save body, model body) and `backup::tests` (builder round trip, tamper rejection, preamble, window status, cursor advance, timeout) |
| Browser | `apps/web/tests/usb.spec.ts` → "writes one continuous effect parameter after arming", "batch-saves parameter drafts with Ctrl+S after arming", "saves the active preset after backing up the destination slot", the phone-viewport "drafts a model change and saves it with op 40" / "adds an effect to an empty slot and sends op 40 there", and "backs up every slot and restores the streamed file" (fake WebUSB device records the op-30/op-40/op-71 frames, serves both setlists, acknowledges every restore frame and records the completed op-5 messages) |
| Hardware | Manual checklist in `docs/development/manual-testing-todo.md` (all writes; restore is still unvalidated) |
