# Architecture requirements

Status: accepted for Phase 2.
Source: user goals + Phase 1 evidence.

## 1. Functional requirements

### Device
- FR-D1 Discover POD Go devices by VID/PID and vendor interface.
- FR-D2 Identify model, serial, firmware version and capabilities.
- FR-D3 Read presets, setlists, IR lists, active preset and active state.
- FR-D4 Detect device-side changes and surface them to the UI.
- FR-D5 Write parameters, models, snapshots and preset metadata (later phase).
- FR-D6 Recover safely from disconnects and partial transfers.

### Presets and organization
- FR-P1 Create, rename, duplicate, copy, paste, move and delete presets.
- FR-P2 Organize presets into setlists.
- FR-P3 Import/export a single `.pgp` preset.
- FR-P4 Import/export a `.pgb` backup / collection.
- FR-P5 Compare two presets and show meaningful differences.
- FR-P6 Undo/redo local edits.
- FR-P7 Preserve unknown fields byte-for-byte.

### Application
- FR-A1 Work fully offline; no backend or cloud dependency.
- FR-A2 Static web deployment (GitHub Pages compatible).
- FR-A3 Desktop packages for Windows, macOS, Linux.
- FR-A4 Android app using USB Host.
- FR-A5 iOS/iPadOS app with offline management and any verified transport.
- FR-A6 Accessible, keyboard-navigable UI with explicit connection states.

## 2. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Core reuse | ≥ 90 % of domain/protocol logic shared across platforms |
| NFR-2 | Parser safety | No panic on arbitrary input; fuzz-clean |
| NFR-3 | Latency | UI responds < 100 ms; device ops bounded by protocol timeout |
| NFR-4 | Binary size | Core WASM < 2 MB gzipped for the read-only build |
| NFR-5 | Startup | Web interactive < 2 s on mid-range hardware |
| NFR-6 | Memory | Preset operations < 256 MB native, < 128 MB WASM |
| NFR-7 | Offline | 100 % of non-device features work offline |
| NFR-8 | Privacy | No network calls by default; no telemetry |
| NFR-9 | Portability | Domain/protocol crates compile for wasm32, x86_64, aarch64 |
| NFR-10 | Maintainability | Public API documented; CI enforced formatting/lints |

## 3. Constraints

- Rust is the primary language for domain, protocol, session, storage and
  import/export.
- Domain and protocol must not depend on UI, browser, desktop, Android or iOS
  APIs.
- The transport layer is an abstract byte-stream contract.
- Unknown data is preserved; no lossy round-trips.
- Only transports verified on the target platform may be claimed.
- No proprietary assets or binaries in the repository.

## 4. Quality attributes and tactics

| Attribute | Tactic |
|---|---|
| Safety | Bounds-checked parsers, typed errors, fuzz targets, no `unsafe` in core |
| Correctness | Golden vectors, property tests, byte-identical round-trips |
| Portability | Trait-based transport, `no_std`-friendly codec where practical |
| Performance | Zero-copy slices where possible, avoid per-frame allocation |
| Testability | Mock transport, deterministic sequences, injected clock |
| Security | Size limits, atomic writes, redaction, dependency audit |
| Usability | Explicit states: disconnected, connecting, ready, syncing, error |
| Maintainability | Small crates, ADRs, rustdoc, evidence-tagged comments |

## 5. Out of scope (first release)

- Firmware updates.
- Authentication or licensing bypass.
- Cloud sync, accounts, marketplace.
- Audio processing or IR rendering.
- Writing to a device before the read-only milestone is accepted.

## 6. Acceptance definition

The project is successful when the definition of success in the project brief
is met: reusable Rust core, safe preset handling, unknown preservation, safe
synchronization, static web build, native desktop transports, documented
Android support, honest iOS limits, reproducible builds, evidence-based
protocol docs and a tested, contributable codebase.
