# Security policy

## Supported versions

The project is pre-1.0. Security fixes land on `main` only.

## Reporting a vulnerability

Open a private security advisory on the hosting repository, or contact the
maintainers through the address listed there. **Do not** open a public issue.

Please include:

- affected crate/binary and version or commit,
- reproduction steps,
- impact (crash, data loss, arbitrary write, etc.),
- whether a physical device is required.

We aim to acknowledge within 7 days.

## Threat model (summary)

The application treats these as **untrusted**:

- every byte received from the device,
- every imported `.pgp`, `.pgb`, `.hlx` or other file,
- filenames and paths chosen during import/export,
- browser/WebUSB permission responses.

Guarantees we intend to uphold:

- parsers are bounds-checked and never panic on malformed input,
- imports are size-limited and reject path traversal,
- native file writes are atomic and back up existing data,
- destructive device writes require explicit confirmation and a backup,
- logs redact device serial numbers and user paths where feasible,
- no analytics, telemetry or network requests by default,
- no secret keys are embedded.

See [docs/architecture/security-model.md](docs/architecture/security-model.md)
for the full model, including known residual risks.

## Dependency policy

- `cargo-audit` runs in CI for known advisories.
- `cargo-deny` enforces license allow-lists and bans duplicate/unknown sources.
- `npm audit --omit=dev` runs in CI for the browser bundle.
- New dependencies need a justification in the pull request.

### npm advisory CVE-2026-112366 (picomatch)

As of 2026-11-18, `npm audit` in `apps/web` reports five high-severity entries
from one advisory: picomatch's ReDoS through single-branch repeated extglobs
(`<= 4.0.7`, no patched release). It reaches the project through Vite's
development/build toolchain (`vite → tinyglobby/fdir → picomatch`).

- picomatch is **not** in the browser bundle and never processes input at
  runtime; the app ships no server-side glob matching.
- The exposure is limited to local build tooling with attacker-controlled glob
  patterns, which this repository does not use.
- `npm run audit:runtime` is clean and gates CI; the dev-only advisory is
  tracked until an upstream release exists. Do not force a Vite downgrade to
  silence it.
