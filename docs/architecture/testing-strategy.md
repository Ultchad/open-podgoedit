# Testing strategy

## 1. Principles

- Tests are evidence: each confirmed protocol fact gets a regression test.
- No test depends on a physical device by default.
- Hardware tests are opt-in, backed up and documented.
- Malformed input is a first-class test category.

## 2. Test pyramid

```text
        HIL (manual, gated)
      E2E (Playwright, no hardware)
    Integration (mock transport, storage)
  Property + fuzz (parsers, codecs)
Unit + golden vectors (every module)
```

## 3. Unit and golden tests

| Area | Tests |
|---|---|
| Frame codec | Exact header bytes, lengths, seq, cursor, magic |
| Handshake | 5-packet order, one read per write, retry/backoff |
| MessagePack | Integers widths, str/bin, map order, nesting limit |
| Preset container | Magic, offset table preservation, typed view |
| `.pgp` | Parse fixture, semantic round-trip, unknown fields |
| `.pgb` | Header, zlib streams, size limits |
| `.pgbak` | Container round trip, per-entry and whole-file SHA-256, duplicate/tamper/truncation rejection |
| Writes | `set_param` hardware-validated golden vector; op-71 editor capture; op-5 stream framing, padding, window cap and cursor advance |
| Restore | Preamble sequence, first-frame body split, status-1 window, silent-preamble retry |
| Notifications | Every captured opcode; offset-24 framing with padding |
| Domain | Validation, parameter ranges, model ids |

Golden vectors come from the documented layout and legally obtained fixtures
(`spec02_obj22_blob.bin`, `spec02_a.pgp`, `user_setlist.bin`,
`factory_setlist_fw250.bin`, `events_fw250.bin`, `events_actions_fw250.bin`).

## 4. Property-based tests

Implemented in `crates/podgo-domain/tests/robustness.rs` with a fixed-seed
generator (no external dependency):

- `encode(decode(x)) == x` for generated MessagePack values, including
  non-canonical integer widths, str/bin, maps and extensions.
- Exhaustive truncation and single-bit mutation of the preset fixture: every
  case either parses or returns a typed error, never panics.
- Random corruption and garbage buffers for both the MessagePack decoder and
  the `l6-helix` container parser.
- Trailing bytes after the container body are preserved verbatim.

Planned properties once the relevant code exists:

- Frame length fields always match emitted bytes.
- Setlist slot/index invariants hold after arbitrary reorder operations.

## 5. Fuzzing

Targets:

- `msgpack::decode`
- `protocol::decode_frame`
- `l6helix::parse`
- `pgp::parse`
- `pgb::parse`

Run with `cargo fuzz` in CI nightly; keep a corpus of seeds. Success criterion:
no panic, no OOM, no infinite loop within the time budget.

## 6. Mock transport

`podgo-test-support` provides a scripted transport:

- queue of expected writes and canned reads,
- injectable timeouts, short reads, disconnects,
- deterministic sequence validation.

Session tests cover: happy path, dropped response, out-of-order response,
timeout, retry exhaustion, disconnect mid-stream, reconnect.

## 7. UI tests

- React Testing Library for components and accessibility roles.
- Playwright for offline flows: import, edit, undo/redo, export, dirty state.
- WebUSB is mocked; no browser can be assumed to have a device.

## 8. Import/export compatibility

- Round-trip `.pgp` → domain → `.pgp` and compare semantically.
- Compare against official exports where legally available.
- Reject oversized, truncated and malformed files with actionable errors.

## 9. Platform packaging smoke tests

| Platform | Check |
|---|---|
| Web | Build, serve statically, load offline, CSP |
| Windows | Installer/bundle launches, discovers mock device |
| macOS | Bundle launches, notarization check |
| Linux | AppImage/deb launches, udev docs present |
| Android | APK installs, permission flow with mock |
| iOS | Build only; offline flows |

## 10. Hardware-in-the-loop plan

Preconditions for every HIL session:

1. Export a full `.pgb` backup.
2. Record model and firmware.
3. Use a dedicated test preset/slot.
4. Get explicit approval for any write.
5. Have a restore procedure ready.

Read-only HIL (first):

- Enumerate device, read identity.
- Read 128 presets, compare names to the device screen.
- Read active preset, parse it, re-encode and compare bytes locally.
- Poll events while changing a knob; record opcodes.

Write HIL (later, gated):

- Change one parameter, re-read, verify. **Done 2026-11-13, fw 2.50.**
- Save one dedicated preset, restore backup. **Save pending, restore pending:**
  start with a 2–3 preset `.pgbak` on dedicated User slots, never a full list.

## 11. CI matrix

| Job | Targets |
|---|---|
| `fmt` | all |
| `clippy` | workspace, `-D warnings` |
| `test` | Linux x86_64 |
| `wasm` | `wasm32-unknown-unknown` build |
| `fuzz` | nightly, time-boxed |
| `audit` | `cargo-audit` |
| `deny` | `cargo-deny` |
| `docs` | `cargo doc --no-deps` |

## 12. Regression policy

Every confirmed protocol issue or bug gets a minimal failing test before the
fix. Tests are never deleted to make CI pass.

## 13. Status reporting

Each release reports, per platform, one of ITH / ITM / BU / PL / UNS, with the
evidence link. Claims without evidence are removed.
