# ADR-0002 — Static web application with WebUSB and offline fallback

- Status: accepted
- Date: 2026-11-10

## Context

The web target must be statically hostable (GitHub Pages), require no backend,
and optionally talk to the device via WebUSB when the browser supports it.

## Decision

Build a static SPA with Vite. Compile the Rust core to WASM via `wasm-bindgen`.
Use WebUSB behind runtime feature detection. When WebUSB is unavailable, the
application runs in offline mode with full preset management and import/export.

## Consequences

- Positive: zero backend, simple hosting, offline-first.
- Negative: WebUSB is unavailable in Safari and Firefox; browser permission UX
  varies; WASM binary size must be managed.
- Mitigation: explicit capability banner, offline mode as a first-class state,
  size budget in CI, lazy-load the WASM module.

## Alternatives

- Server proxy for USB: violates the no-backend requirement and is a security
  risk.
- Electron-only desktop: does not satisfy the web goal.
- WebSerial/WebHID: the device is vendor bulk, not serial/HID.

## Evidence

The protocol is a bulk byte stream, which maps directly to WebUSB
`transferOut`/`transferIn`. The official client uses libusb, not HID.
