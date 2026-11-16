# ADR-0003 — Tauri desktop shell with a native libusb transport

- Status: accepted
- Date: 2026-11-10

## Context

Desktop builds must access USB directly on Windows, macOS and Linux while
reusing as much UI and logic as possible.

## Decision

Use Tauri 2 with the shared web UI. Implement `podgo-transport-native` with
`rusb` (libusb). Expose discovery/open/read/write/close to the UI through Tauri
commands.

## Consequences

- Positive: small binaries, one UI, Rust-native USB, good OS integration.
- Negative: WebView engine differences; code signing/notarization work; Linux
  udev rules; Windows WinUSB binding.
- Mitigation: CI smoke tests per OS; documented driver setup; do not replace
  device drivers automatically.

## Alternatives

- Electron: larger, Node attack surface, weaker Rust integration.
- Fully native UI per OS: 3× cost.
- `nusb`: promising but less mature for this use case.

## Evidence

The official Windows client uses WinUSB/libusb (`WinUsb`,
`L6LibUsbControlEndpointItf`) and macOS bundles `libusb-1.0.0.dylib`. libusb is
therefore the proven path.
