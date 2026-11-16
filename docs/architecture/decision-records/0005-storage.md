# ADR-0005 — Storage via a repository trait

- Status: accepted
- Date: 2026-11-10

## Context

Presets must persist locally on web, desktop and mobile without a backend.

## Decision

Define a `PresetRepository` trait in `podgo-storage` with operations for
listing, loading, saving, deleting and importing/exporting presets and
setlists. Provide:

- an IndexedDB implementation for WASM,
- a SQLite implementation for native/mobile,
- an in-memory implementation for tests.

All writes are atomic; existing data is backed up before overwrite.

## Consequences

- Positive: testable, portable, explicit.
- Negative: two real implementations to maintain; schema migrations needed.
- Mitigation: shared schema version and migration tests.

## Alternatives

- `localStorage`: too small and synchronous.
- File-per-preset only: poor querying and ordering.
- Cloud database: violates offline/no-backend.

## Evidence

Presets are small (a few KB) but collections reach hundreds of entries; a
queryable store is justified.
