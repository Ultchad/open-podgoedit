# ADR-0006 — Byte-preserving MessagePack model

- Status: accepted
- Date: 2026-11-10

## Context

Device presets contain fields that are not fully understood. A typed,
lossy decode/re-encode would silently destroy data.

## Decision

Implement a small MessagePack codec in `podgo-domain` that:

- parses into a `Value` tree that retains integer width, string vs binary,
  map entry order and unknown keys,
- re-encodes byte-identically when unmodified,
- layers typed views (`Preset`, `Block`, `Parameter`) over the tree without
  discarding the original,
- exposes an escape hatch (`Unknown`) for future keys.

Generic `serde`-based serialization is used only for `.pgp`/`.pgb` JSON, where
semantics are better understood.

## Consequences

- Positive: no data loss; safe partial understanding; auditable round-trips.
- Negative: more code to maintain; typed views must stay in sync.
- Mitigation: round-trip tests over every fixture; fuzzing; golden vectors.

## Alternatives

- `rmp-serde` directly: loses map order/unknown types and can normalize values.
- Store raw bytes and never decode: blocks editing.
- Best-effort typed only: risks corruption.

## Evidence

`editor.py` explicitly mutates the raw MessagePack body to avoid losing keys,
which validates this requirement.
