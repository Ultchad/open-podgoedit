# ADR-0001 — Rust workspace with a transport-independent core

- Status: accepted
- Date: 2026-11-10
- Deciders: architecture working group (Phase 1)

## Context

The application must run on web (WASM), desktop (Windows/macOS/Linux), Android
and iOS, and must parse untrusted binary data. The protocol is a byte-oriented
USB bulk stream plus MessagePack and a binary preset container.

## Decision

Use a single Rust workspace. `podgo-domain`, `podgo-protocol`,
`podgo-session`, `podgo-storage` and `podgo-import-export` contain all business
logic. `podgo-transport` defines a byte-stream trait. Platform crates implement
that trait. No domain or protocol crate may import a UI, browser, USB or OS API.

## Consequences

- Positive: one implementation of the protocol; strong typing; WASM and FFI
  reuse; no GC; memory safety for parsers.
- Negative: Rust learning curve; cross-compilation setup; async/blocking
  boundary must be designed carefully.
- Mitigation: keep transports thin and synchronous at the byte level; use an
  adapter for async runtimes.

## Alternatives

- TypeScript core shared via Node/React Native: loses native USB ergonomics and
  binary safety, and mobile USB still needs native code.
- C++ core with per-platform UIs: unsafe parsing, slower iteration.
- Per-platform implementations: unacceptable duplication and divergence.

## Evidence

Phase 1 analysis shows Windows/macOS share the same `l6devicelib` and resource
formats, which supports a shared core.
