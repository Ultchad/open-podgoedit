# Security model

## 1. Assets

- User presets, setlists and backups (integrity and availability).
- The physical device (bricking, corrupted presets).
- Device serial numbers and file paths (privacy).
- Build and release integrity.

## 2. Trust boundaries

| Boundary | Trust |
|---|---|
| Device → host bytes | Untrusted |
| Imported files | Untrusted |
| Filenames/paths | Untrusted |
| Browser/WebUSB permission | Untrusted input, trusted decision by user |
| Local storage | Trusted for integrity, not for confidentiality |
| Build dependencies | Reviewed |

## 3. Threats and mitigations

| Threat | Mitigation |
|---|---|
| Malformed frame causes panic/OOM | Bounds checks, max sizes, fuzz tests, no `unwrap` on input |
| Malicious `.pgp`/`.pgb` path traversal | Sanitize names, canonicalize, reject `..`, no absolute paths |
| Zip/zlib bomb in `.pgb` | Decompression limits, stream caps |
| Corrupt preset overwrites device | Read-only default, backup, confirmation, re-read verify |
| Partial write treated as success | Explicit ack + re-read; never blind retry |
| Corrupt or tampered `.pgbak` written to the pedal | Versioned container, per-entry and whole-file SHA-256, Rust re-verification, destination diff, typed confirmation, fresh-backup gate |
| Secret leakage in logs | Redaction of serials/paths; no payload logging by default |
| Supply-chain compromise | `cargo-audit`, `cargo-deny`, pinned lockfile, review |
| Web XSS via preset names | React escaping, no `dangerouslySetInnerHTML`, CSP |
| WebUSB device spoofing | Match VID/PID + interface shape; warn on mismatch |
| Telemetry/privacy | No network by default; opt-in only if ever added |

## 4. Parser rules

1. Every length is validated against the remaining buffer.
2. No recursion without a depth limit (MessagePack nesting).
3. Maximum frame, preset and backup sizes are enforced before allocation.
4. Integer conversions are checked.
5. Parsers return `Result`; panic is a bug.
6. Unknown data is preserved, not interpreted.

## 5. Filesystem rules

- Atomic write: write temp file in the same directory, fsync, rename.
- Back up the previous file before replacement.
- Refuse to write outside the chosen export directory.
- Normalize Unicode and strip control characters from display names.

## 6. Device write rules

1. Read the destination (destination slot for a save; the whole pedal for a
   restore) and offer a backup; a full backup is recommended but is not a
   precondition.
2. Show a diff and require explicit confirmation. Restore and the library
   writes use exactly one confirmation: one write button and one
   `window.confirm`. There is no typed word and no second acknowledgement.
3. Limit writes to the selected preset/slot; restore is limited to the entries
   present in the verified `.pgbak`.
4. Re-read and verify after write.
5. Refuse a restore file whose per-entry or whole-file SHA-256 does not match,
   and compute the digest again in Rust before use.
6. Never write during a firmware update or low-power state.
7. Treat an interrupted restore as a partial state: report it, never blind-retry
   it, and point the user at the pre-write backup.

## 7. Cryptography

The project does not implement cryptography. It does not bypass
authentication. If a future integrity field requires a hash, only public,
non-secret algorithms are used, and the implementation is documented.

## 8. Dependency and license policy

- `cargo-audit` on every CI run.
- `cargo-deny` with an allow-list: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0,
  LGPL-2.1 (dynamic linking only, with attribution).
- No GPL-only dependencies in the core.
- `libusb` is dynamically linked and attributed.

## 9. Residual risks

- Object-14 integrity remains unknown; verification relies on re-reads.
- WebUSB cannot verify device firmware authenticity.
- iOS offline mode cannot protect against a user importing a malicious file;
  parsers must be robust.
- No hardware-backed secure storage is assumed.
