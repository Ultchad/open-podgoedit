# Fixtures

Legally obtained, redistributable sample data used by tests.

| File | Origin | Contents | Redistribution |
|---|---|---|---|
| `spec02_obj22_blob.bin` | `openpodgo` MIT test fixtures | `l6-helix` active preset blob | Present in the MIT reference project |
| `spec02_a.pgp` | `openpodgo` MIT test fixtures | Official-format `.pgp` export | Present in the MIT reference project |
| `spec02_obj14.bin` | `openpodgo` MIT test fixtures | Object-14 seal table | Present in the MIT reference project |
| `user_setlist.bin` | `openpodgo` MIT test fixtures | 128-entry user setlist stream | Present in the MIT reference project |
| `factory_setlist_fw250.bin` | WebUSB capture, POD Go Wireless, firmware 2.50 (this project) | Factory setlist stream, 128 entries, 3668 B; includes the 8-byte data header | Contains only Line 6 factory preset names; no personal data |
| `events_fw250.bin` | Derived from `reverse/exports/podgo-connect.pcapng` (official editor, fw 2.50) | 14 notification frames as `u16 LE length` + frame | Numeric MessagePack payloads only; no presets or personal data |
| `events_actions_fw250.bin` | Derived from `reverse/exports/podgo-events.pcapng` (official editor, fw 2.50, guided actions) | 18 frames, one per opcode and payload shape (1, 4, 8, 20, 21, 22×2, 30, 31, 33, 34, 39, 40, 41, 42, 46, 49×2) | Numeric MessagePack payloads only. Opcode 6 is excluded because its only frame carries a personal preset name |

## Rules

1. Fixtures must contain no personal data and must be redistributable.
2. Never add Line 6 binaries, firmware, fonts, images or manuals.
3. If a fixture contains user-created preset names, confirm permission before
   publishing it.
4. Prefer synthetic fixtures for new tests; use real captures only when their
   provenance is clear.

## Captures (not fixtures)

`reverse/exports/` holds working captures used for analysis; it is not part of
the published fixture set.

| Capture | Origin | Use |
|---|---|---|
| `podgo-catalog.pcapng` | USBPcap, POD Go Edit 2.50, 2026-11-12 | setlist reads + drive/bypass/assignment actions |
| `podgo-full-backup.pcapng` | USBPcap, POD Go Edit 2.50, 2026-11-12 | 134 preset reads; validates the model catalog |

Both contain only factory preset bodies and numeric event payloads. The
generated `apps/web/src/catalog/catalog.json` contains no preset content: it is
an id → name → range table derived from the MIT `openpodgo` data.

## Provenance note

These files were copied from `reverse/openpodgo/tests/fixtures/`, an MIT-licensed
community project. Protocol facts are used for interoperability; the preset
contents remain the work of their authors. The model/parameter catalog follows
the same rule: factual identifiers, names and ranges only, no vendor artwork or
code (`docs/protocol/model-catalog.md`).
