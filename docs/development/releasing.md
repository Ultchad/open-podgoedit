# Releasing

## 1. Versioning

Semantic versioning from 1.0. Pre-1.0: minor versions may break APIs; patch
versions are fixes. Tag format: `vMAJOR.MINOR.PATCH`.

## 2. Release checklist

1. `CHANGELOG.md` updated and reviewed.
2. `cargo fmt --all -- --check` clean.
3. `cargo clippy --workspace --all-targets -- -D warnings` clean.
4. `cargo test --workspace` green.
5. `cargo audit` and `cargo deny check` green.
6. Docs build (`cargo doc --no-deps`).
7. Web build produced and smoke-tested.
8. Platform bundles built and smoke-tested.
9. No proprietary assets in the artifact.
10. Tag and sign.

## 3. Web release

```sh
cd apps/web
npm ci
npm run build
```

Deploy `dist/` to static hosting. For GitHub Pages set the Vite `base` to the
repository subpath. Verify:

- assets load from the subpath,
- offline mode works with the network disabled,
- no backend calls in the network panel,
- CSP blocks inline scripts except the WASM loader.

## 4. Desktop release

Tauri builds per OS. Sign Windows binaries; notarize macOS; provide an AppImage
and/or `.deb` for Linux. Publish checksums.

## 5. Android release

Build a signed AAB. Declare USB host feature and permission. Test the
permission flow on a clean install.

## 6. iOS release

Offline build only until a transport is verified. TestFlight for internal
testing. Do not claim device support in the listing until hardware-verified.

## 7. Reproducibility

- Commit `Cargo.lock`.
- Pin the Rust toolchain in `rust-toolchain.toml`.
- Pin npm dependencies with `package-lock.json`.
- Record build environment in release notes.

## 8. Security

- Never publish debug symbols containing user paths.
- Redact logs before attaching to issues.
- Rotate signing keys if compromised; document the incident.

## 9. Rollback

Keep the previous release artifacts. A bad release is superseded, not deleted,
so users can downgrade. For device-affecting bugs, publish a clear advisory and
restore instructions.
