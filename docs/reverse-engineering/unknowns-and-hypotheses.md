# Unknowns, hypotheses and risks

This document is the honest boundary of current knowledge. It separates what is
proven from what is assumed, and records how each open question can be resolved.

## 1. Confirmed facts

| ID | Fact | Evidence |
|---|---|---|
| F1 | Vendor ID `0x0E41` | Both binaries, Python, udev rule |
| F2 | POD Go PID `0x4247`, second PID `0x424B` | Both binaries |
| F3 | Transport is bulk on a vendor-specific interface | libusb/WinUSB imports, Python |
| F4 | Payload is MessagePack | `MsgPackL6Variant`, fixtures, Python |
| F5 | Presets use the `l6-helix` container | Binary magic, fixture, Python |
| F6 | Windows and macOS share the same resource formats | Extracted resources |
| F7 | macOS links CoreMIDI; Windows uses WINMM | Imports |
| F8 | `.pgp` uses schema `L6Preset`; `.pgb` uses magic `AF6L` | Fixtures, Python |
| F9 | Object 22 returns the active preset blob | Fixture + Python |
| F10 | The official macOS client supports offline mode | `Info.plist` |
| F11 | Event notifications are framed: subheader `00 00 04 00`, u32 body length, MessagePack at offset 24, zero padding to 4 bytes | 14 notifications from a fw 2.50 USBPcap capture |
| F12 | `0x424B` (POD Go Wireless) serves the same read protocol as `0x4247` | Hardware WebUSB read of Factory and User, fw 2.50 |
| F13 | Vendor interface 0 exposes bulk OUT `0x01` / IN `0x81` | WebUSB descriptor enumeration on hardware |
| F14 | Opcodes 1, 4, 6, 8, 20, 21, 22, 30, 31, 33, 34, 39, 40, 41, 42, 46 and 49 map to the eleven guided actions | `podgo-events.pcapng`, 277 notifications, 15 bursts |
| F15 | Editor-sent op-30 frames match `encode_set_param` byte for byte | 10 frames in `podgo-preset-save.pcapng` |
| F16 | Op 71 writes preset metadata only (`{107, 108, 109}`); no object-14 access, no body upload | `podgo-preset-save.pcapng` |
| F17 | Restore streams 157 op-5 preset writes and one op-9 message over the read channel | `podgo-backup-restore.pcapng`, reassembled with the stream rule below |

## 2. Strongly supported conclusions

| ID | Conclusion | Why not "confirmed" |
|---|---|---|
| S1 | Read channel `0x1001→0x03EF`, write `0x1080→0x03ED`, event poll `0x1002→0x03F0` with notifications on the reverse `0x03F0→0x1002` | From Python/capture notes; not re-captured here |
| S2 | 5-packet read handshake, 4-packet write handshake | Python live-validation claim |
| S3 | The 8-byte event subheader type distinguishes data (`0x02`) from events (`0x04`) | Seen in captures; not exhaustively mapped |
| S4 | Magic `0x28` only on first handshake packet | Python templates + tests |
| S5 | Application sequence starts at `0x06` | Python |
| S6 | Object 14 is a per-slot integrity seal | Semantics inferred; algorithm unknown |
| S7 | `PodGo.sym` index equals on-wire model id | 16/16 validation claim in Python |
| S8 | `0x424B` is a POD Go Wireless variant | Naming in strings, ID proximity |
| S9 | `0x1FC9:0x000C` is an update/bootloader mode | NXP VID; not exercised |
| S10 | `set_param` (op 30) body `{98: raw chain index, 29: true, 26: 0, 28: param index, 119: f32 value}` on the write channel, cursor from object 76 | Payload keys from the reference and the op-30 notification echo; applied on hardware 2026-11-13 (fw 2.50, amp Drive `0.9`). Ten editor-sent frames now match the encoder (F15) |
| S11 | `save_preset` (op 71) body `{107: setlist, 108: slot, 109: "<name>\\0"}`, status `103 == 0` | Exact editor frame captured (F16); not yet sent by this build |
| S12 | Restore replays streamed op-5 preset writes; a message starts at `01 00 02 00`, total length at offset 20, body at 24, and a 1536-byte window answers status 1 | 157 messages reassembled (F17); the encoder and container are implemented, but no restore has been applied to hardware | Restore is **not** hardware-validated; op-9/86/113 and the final op-254 are not sent |

## 3. Hypotheses (not safe to rely on)

| ID | Hypothesis | Risk | How to test |
|---|---|---|---|
| H1 | `MurmurHash3` computes the object-14 seal | Wrong edit detection, corrupt writes | Change one param, compare object 14 before/after; try candidate inputs |
| H2 | Offset table entries are section offsets from magic end | Re-encode corruption | Mutate one offset and observe device acceptance |
| H4 | The device exposes a class-compliant USB MIDI interface usable on iOS | Broken iOS promise | `system_profiler`, CoreMIDI enumeration, iOS test |
| H6 | Firmware 2.50 and 2.01 share the object layout | Silent corruption on older firmware | Compare object dumps across firmware |
| H7 | The 48-byte offset table is stable across presets | Re-encode rejection | Diff tables across fixtures |
| H8 | `.pgp` `device_version`/`appversion` are ignored on import | Import rejection | Vary values on hardware |

## 4. Unknowns

| ID | Unknown | Impact | Resolution |
|---|---|---|---|
| U1 | Object-14 checksum algorithm and region | Cannot validate writes offline | Controlled experiment |
| U2 | Exact meaning of `body_len` | Possible truncation of large bodies | Capture max-size preset |
| U3 | Remaining subheader fields beyond the type marker and body length | Misalignment on new commands | Command-by-command capture |
| U4 | Keepalive requirement | Idle disconnect | Long idle test |
| U5 | Maximum preset/backup size | Memory limits | Stress import |
| U6 | Behavior on interrupted write | Bricking risk | Never test destructively without backup |
| U7 | Multi-device behavior | Wrong-device writes | Enumerate two devices |
| U8 | Hardware acceptance of op 71 sent by this build (the capture is from the official editor) | A rejected or misplaced save could overwrite the wrong slot | Save to a dedicated User slot with a downloaded destination backup; re-read the setlist |
| U9 | Firmware update protocol | Out of scope | Do not implement |
| U10 | Authentication/interlock semantics | Device rejection | Observe only; never bypass |
| U11 | iOS vendor USB availability | Platform promise | Apple documentation + hardware |
| U12 | Op 86 role (`{110: <215-byte blob>}` during restore) | Restore session framing is unknown | Capture open/close of a restore and correlate op 86 |
| U13 | Meaning of key `113` in the op-9 restore message | Restore terminator checksum/token unknown | Compare across backups; test candidate hashes |
| U14 | Hardware acceptance of the op-5 stream produced by this build (window at exactly 1536, no host acks, sequence floor) | A rejected window aborts mid-restore; earlier slots stay written | Controlled restore of a 2–3 preset backup on a backed-up pedal; compare the event log and re-read names |
| U15 | Whether the 16-byte `cmd = 0x08` host acknowledgements after a window status are required | Device may stall or drop frames after the first window | Replay the capture with and without the acknowledgements (hardware, backed-up pedal) |

## 5. Contradictions found

1. `docs/protocol.md` marks the PID as unconfirmed while the README/udev assert
   `0x4247`. Binary analysis resolves this in favour of `0x4247`.
2. The Python code calls object 14 a checksum but sets
   `_OBJ14_CRC_CONFIRMED = False`; documentation must not present it as solved.
3. `.hlx` is JSON in the resources while the device container is MessagePack;
   the two must not be conflated.

## 6. Unsafe assumptions to forbid in code

- **Do not** zero unknown bytes.
- **Do not** recompute object 14 and assume correctness.
- **Do not** assume a fixed number of top-level preset keys.
- **Do not** assume the event body offset.
- **Do not** retry a partial write without re-reading state.
- **Do not** treat op 71 as a body upload: it only writes metadata.
- **Do not** send a restore without a verified full backup, the destination
  diff, the typed confirmation and the armed-write gate.
- **Do not** treat op 5 as hardware-validated: no restore from this build has
  been applied to a pedal.
- **Do not** treat `.pgp` compatibility constants as protocol truth.
- **Do not** claim iOS USB support before it is demonstrated.

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Corrupting a user preset | Medium | High | Read-only PoC; backup; confirmation; re-read verify |
| A restore is interrupted after some presets are written | Medium | High | Fresh full backup required; diff shown; typed confirmation; document that a partial state is possible |
| Restore stream rejected or mis-framed on hardware | Medium | High | Op-5 only, capture-derived framing; validate on a backed-up pedal before a real setlist |
| Misparsing a new firmware | Medium | Medium | Versioned parser; preserve unknown; fail closed |
| WebUSB browser incompatibility | High | Medium | Feature detection; offline fallback |
| iOS transport unavailable | High | Medium | Offline-first; documented limitation |
| libusb driver issues on Windows | Medium | Medium | Document WinUSB; do not replace drivers blindly |
| Dependency/license drift | Low | Medium | `cargo-deny`, `cargo-audit` |
| Proprietary asset leak | Low | High | `.gitignore`, review, no resources committed |

## 8. Evidence gaps

- No `captures/` directory in the workspace.
- No hardware available during Phase 1.
- No firmware images (and none will be redistributed).
- No iOS SDK/hardware on the analysis host.
- Ghidra decompilation timed out; conclusions rely on imports/strings/snippets.
