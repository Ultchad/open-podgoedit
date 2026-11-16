# Development setup

## 1. Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Rust | stable ≥ 1.80 | core crates |
| `rustfmt`, `clippy` | matching toolchain | formatting/lints |
| Node.js | ≥ 20 | web UI |
| `wasm-pack` | latest | WASM build (optional until Phase E) |
| `cargo-fuzz` | nightly | fuzzing (optional) |
| `cargo-audit`, `cargo-deny` | latest | security/license checks |
| `pkg-config` + `libusb-1.0-dev` | system | native transport (Phase F) |
| Android SDK/NDK | current | Android (Phase G) |
| Xcode | 15+ | iOS (Phase G, macOS host only) |

## 2. Clone and build

```sh
git clone <your-fork-url> open-podgoedit
cd open-podgoedit
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The core crates have **no external dependencies**, so they build offline.

## 2b. Offline probe

```sh
cargo run -p podgo-cli -- fixtures/spec02_obj22_blob.bin
cargo run -p podgo-cli -- --setlist fixtures/user_setlist.bin
```

The probe parses a raw `l6-helix` blob, prints the preset summary and verifies
that a local re-encode is byte-identical. `--setlist` instead parses a captured
streamed setlist and prints entries in slot order. It never opens a USB device.
A non-zero exit means malformed input or a round-trip mismatch; do not write
such a blob back to a device.

For the full manual validation checklist (local, Docker, WASM, browser and
hardware capture), see [manual-testing-todo](manual-testing-todo.md).

## 2c. Local web test

The read-only core also runs in the browser through WebAssembly:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130
cd apps/web
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Chrome/Edge can read a setlist over WebUSB in
read-only mode; the other browsers stay offline. See
[apps/web/README.md](../../apps/web/README.md). The binding crate is outside the
root workspace, so the core offline build is unchanged.

## 3. Workspace layout

```text
crates/   Rust core
apps/     platform shells
docs/     all documentation
fixtures/ legally redistributable test data
tests/    integration tests
tools/    helper scripts
```

## 4. Adding a protocol fact

1. Add it to `docs/reverse-engineering/protocol-specification.md` with a
   confidence label and evidence.
2. Add a golden vector in the relevant crate.
3. Implement the smallest change.
4. Add a regression test.

## 5. Web development (Phase E)

```sh
cd apps/web
npm install
npm run dev
```

WebUSB requires `https://` or `http://localhost`.

## 6. Native transport (Phase F)

Linux:

```sh
sudo cp 99-podgo.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

The rule grants access to `0e41:4247` without root. Windows uses the WinUSB
driver installed by the official editor; do not replace it blindly. macOS
requires no entitlement outside the sandbox.

## 7. Environment variables

| Variable | Purpose |
|---|---|
| `PODGO_LOG` | log filter (`info`, `debug`, `trace`) |
| `PODGO_MOCK` | use the mock transport |
| `PODGO_FIXTURES` | fixture directory override |

## 8. Troubleshooting the build

- `cargo` cannot find `libusb`: install `libusb-1.0-dev` (native crate only).
- WASM build fails: install `wasm32-unknown-unknown` and `wasm-pack`.
- Clippy failures: fix, do not `#[allow]` without a comment.

## 9. Definition of done per change

- Documentation and evidence updated.
- Tests added and passing.
- `fmt` and `clippy` clean.
- `CHANGELOG.md` updated.
- No proprietary material added.
