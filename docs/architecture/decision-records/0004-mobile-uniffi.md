# ADR-0004 — UniFFI for Android and iOS integration

- Status: accepted
- Date: 2026-11-10

## Context

Android and iOS require platform USB/permission APIs that Rust cannot reach
portably. The core must still be shared.

## Decision

Use UniFFI to expose a small, stable API from a `podgo-ffi` crate:

- `open_session`, `close_session`
- `read_presets`, `read_active_preset`
- `apply_local_edit` (offline)
- `import_pgp`, `export_pgp`
- transport callbacks supplied by the platform shell

Android implements the transport in Kotlin with `UsbManager` /
`UsbDeviceConnection.bulkTransfer`. iOS uses Swift; direct vendor USB is not
assumed, so the initial iOS transport is `None` (offline only), with CoreMIDI
added only if verified.

## Consequences

- Positive: one core, typed FFI, generated Swift/Kotlin bindings.
- Negative: build complexity, ABI stability concerns, callback threading.
- Mitigation: keep the FFI surface tiny and versioned; all transport callbacks
  are synchronous byte transfers.

## Alternatives

- JNI hand-written: more control, more boilerplate.
- C ABI: portable but manual and unsafe.
- Rewrite logic per platform: rejected.

## Evidence

Android USB Host and iOS ExternalAccessory/CoreMIDI are platform APIs; the
protocol is a byte stream, so a callback transport is sufficient.
