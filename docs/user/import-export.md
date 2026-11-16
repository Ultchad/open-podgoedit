# Import and export

> **Implementation status:** planned (Phase 3). Only the binary `l6-helix`
> container can be read today, through `podgo-probe` and the Rust domain crate.
> The `.pgp`, `.hlx` and `.pgb` workflows described below are not implemented
> yet; see the [roadmap](../roadmap.md).

## 1. Supported formats

| Format | Extension | Direction | Notes |
|---|---|---|---|
| POD Go preset | `.pgp` | import/export | JSON, schema `L6Preset` |
| POD Go backup | `.pgb` | import/export | `AF6L` + zlib streams |
| Helix preset | `.hlx` | import | JSON authoring format |
| Raw device blob | `.bin` | import (advanced) | `l6-helix` MessagePack |

## 2. Importing a preset

1. Choose **Import**.
2. Select a `.pgp` or `.hlx` file.
3. The app validates the schema, version and size.
4. Review the summary (name, model count, warnings).
5. Choose a destination slot or keep it local.

Warnings are shown for unknown models, out-of-range parameters and unknown
fields. Unknown fields are preserved even when not displayed.

## 3. Exporting a preset

1. Select a preset.
2. Choose **Export**.
3. Pick `.pgp` (portable) or `.bin` (advanced).
4. The app writes atomically and reports the path.

## 4. Backups

- **Full backup (`.pgb`):** all setlists, globals and IRs.
- **Collection export:** selected presets only.
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
