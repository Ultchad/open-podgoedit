# ADR-0007 — Read-only first, writes behind an explicit gate

- Status: accepted
- Date: 2026-11-10

## Context

Writing to a device can corrupt user presets. Object-14 integrity is unresolved
and the write path has not been independently verified.

## Decision

The first public milestone is read-only:

- discovery, handshake, preset/setlist/object reads,
- offline editing and import/export,
- no command that mutates device state.

Write support is compiled behind a `device-write` feature and additionally
requires an explicit runtime confirmation and a verified backup. It cannot be
enabled by default.

## Consequences

- Positive: safe onboarding; protocol validated before mutation.
- Negative: slower feature delivery.
- Mitigation: implement and test write encoders offline against golden vectors,
  without sending them.

## Amendment 2026-11-13 — first gated write

`set_param` (operation 30, one continuous effect parameter) now ships behind
the `device-write` feature **and** three runtime gates: a per-session arming
checkbox, a requirement that the active preset was read from the pedal in the
same session, and a per-change confirmation. The byte-exact copy read from the
pedal stays in memory as the backup for **Download .bin**; the change is never
saved, so recalling another preset or powering the pedal off discards it.

The "verified backup" requirement is met in the limited sense that a byte-exact
copy of the preset exists in memory before any write; it is not yet a
hardware-verified restore path (no save command exists). Saving presets, model
swaps and whole-chain writes remain unimplemented while object 14 is
unresolved. See [docs/protocol/writes.md](../../protocol/writes.md).

## Amendment 2026-11-15 — one confirmation per write

The runtime gates are simplified to **one confirmation per write**. The session
arming checkbox and the "active preset read from the pedal this session" rule
stay; the extra preconditions added for restore and library writes do not:

- restore no longer requires a fresh session backup, a typed `RESTORE` word or
  an acknowledgement checkbox. It requires a Rust-verified `.pgbak`, shows the
  destination diff next to the button, and asks one `window.confirm` before
  streaming;
- **Write rename to pedal** and **Write paste to pedal** no longer require a
  full backup. Each is one button plus one `window.confirm`.

The verified-backup intent of the original decision is preserved differently:
a full backup is one click away in the same dialog and is recommended, but it
is a safety net rather than a gate. The session arm switch remains the only
standing switch, and the `device-write` Cargo feature still cannot be enabled
by default. See [docs/protocol/writes.md](../../protocol/writes.md) §3.

## Alternatives

- Ship writes immediately: unacceptable risk.
- Never support writes: fails the product goal.

## Evidence

Object 14 is explicitly unconfirmed in the Python project; a wrong seal could
cause rejected or corrupt saves.
