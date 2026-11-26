# Import and export

> **Implementation status:** the web app imports `.pgp` presets and `.pgb`
> backups, exports `.pgp`/`.pgb` offline, and backs up or restores the pedal as
> `.pgbak`. `.hlx` import and JSON → `l6-helix` conversion are planned; see the
> [roadmap](../roadmap.md).

## 1. Supported formats

| Format | Extension | Direction | Notes |
|---|---|---|---|
| POD Go preset | `.pgp` | import/export | JSON, schema `L6Preset` |
| POD Go backup | `.pgb` | import/export | `AF6L` + zlib streams |
| Editor backup | `.pgbak` | export/restore | Raw `l6-helix` bodies + SHA-256 |
| Helix preset | `.hlx` | planned | JSON authoring format |
| Raw device blob | `.bin` | import (advanced) | `l6-helix` MessagePack |

## 2. Importing a preset

1. Choose **Import/Export**.
2. Select a `.pgp` preset or a `.pgb` backup.
3. The app validates the schema, version and size.
4. Review the summary (name, model count, warnings).
5. Choose a destination User slot or keep it local.

A `.pgb` backup also lets you choose which parts to bring in: Factory presets,
User presets, impulse responses and globals. Unticking a setlist hides it from
the slot browser; **Import N preset(s)** adds every non-empty preset of the
checked setlists to the offline library. User presets keep their slot when it
is free; Factory presets and occupied slots go to the first empty User slots,
and nothing already in the library is overwritten. IRs have no editor here and
are only kept for re-export.

Warnings are shown for unknown models, out-of-range parameters and unknown
fields. Unknown fields are preserved even when not displayed.

## 3. Exporting a preset

1. Select a preset.
2. Choose **Export .pgp** (portable), **Export .pgb** (rebuild the backup it
   came from), or **Download preset** for the raw blob.
3. The browser downloads the file; nothing is uploaded.

## 4. Backups

- **Full backup (`.pgbak`):** both setlists, every non-empty slot, raw bodies.
- **Partial backup (`.pgbak`):** one setlist or a chosen set of slots.
- **Backup file import/export (`.pgb`):** the vendor container. On export you
  choose which parts to keep — Factory setlist, User setlist, impulse responses
  and globals — and every member you keep is copied byte for byte. The `SLNM`
  name table and unknown members are always kept so the file stays readable.
- **Restore:** checked entries from a `.pgbak` are streamed with operation 5;
  unchecked entries and slots absent from the file are left untouched.
- Backups are never uploaded anywhere.

## 5. Validation rules

- Maximum file size (configurable, default 64 MB).
- Maximum preset count.
- Schema marker and version checked.
- Parameter ranges checked against the model catalog.
- Path traversal rejected; filenames sanitized.
- Truncated or malformed files are rejected with a precise error.

## 6. Round-trip guarantees

- Importing and re-exporting an unmodified preset preserves all known and
  unknown fields.
- String/binary distinctions and map order are preserved for device blobs.
- `.pgp` export is semantically equivalent; byte equality is not guaranteed
  because JSON formatting may differ.

## 7. Compatibility notes

- `.pgp` `device` and `appversion` values are compatibility fields, not
  protocol truth.
- `.pgb` stream order is identified by content; do not assume fixed indices.
- Firmware-specific fields are preserved verbatim.

## 8. Privacy

Preset names and metadata may contain personal information. Review files before
sharing them in issues or pull requests.
