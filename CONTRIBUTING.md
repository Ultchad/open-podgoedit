# Contributing

Thanks for helping build an open, unofficial POD Go editor.

## Ground rules

1. **Interoperability only.** Do not contribute code or data that circumvents
   licensing, authentication, copy protection or access controls.
2. **No proprietary material.** Do not commit Line 6 binaries, firmware,
   fonts, images, manuals, or decompiled code. Describe behaviour instead.
3. **Clean-room discipline.** Document observed behaviour and message
   structure first; implement original code from that specification.
4. **Evidence over guesses.** Every protocol claim must be classified as
   confirmed, strongly supported, hypothesis, unknown or platform limitation.
   Cite the file/symbol, binary observation or fixture that supports it.
5. **No destructive tests on hardware** without a verified backup, explicit
   user approval, a restoration procedure and a dedicated test preset.
6. **Never panic on untrusted input.** Parsers must return errors, not abort.

## Workflow

1. Open an issue describing the behaviour and evidence.
2. Add or update the relevant document under `docs/`.
3. Add a test that fails first (golden vector, round-trip, fuzz seed).
4. Implement the smallest change that passes.
5. Run `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`
   and `cargo test --workspace`.
6. Update `CHANGELOG.md`.
7. Open a pull request; link the evidence and the phase checklist.

## Branches — never push directly to `main`

- Work on a `feature/…` branch and open a pull request.
- **Only push to `dev`, never directly to `main`.** Every change reaches the
  repository through `dev` (or a short-lived feature branch merged into it);
  `main` is updated only by merging the reviewed `dev → main` pull request.
- Test and review on `dev` first. Merge `dev` to `main` only after CI is green
  and the changes have been reviewed.
- Keep the local `main` in sync with `origin/main`; do not force-push shared
  branches.

### How this is (and isn't) enforced

The **recommended** enforcement is a branch protection rule on `main` in the
repository settings: **Settings → Branches → Add rule** for `main`, then require
`Require pull request reviews` (at least 1) and `Require status checks to pass`
(the `CI` workflow). That prevents any direct push to `main` at the GitHub
level.

A repository workflow cannot hard block a push to `main` — branch protection is
the only real control. The CI workflow will, however, **fail loudly** if a push
bypasses it: `ci.yml` runs on `dev`/`main` and any direct `main` push that
somehow does not get a branch rule will only pass if it is tested. The
`pages.yml` deploy also runs on every `main` push, so an unreviewed `main`
change would publish to GitHub Pages.

> No force-push to `dev` or `main`.

## Commit style

Use conventional-ish commits: `feat(protocol): decode chunk header`,
`fix(domain): preserve unknown msgpack keys`, `docs: add ADR-0003`.

## Code style

- `rustfmt` defaults; `clippy` warnings are errors in CI.
- Every public item has rustdoc with errors, invariants and protocol evidence.
- Modules stay cohesive; prefer several small files over one large file.
- Comments explain *why*, evidence and invariants — not what the line does.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.

## License

By contributing you agree that your contribution is licensed under the MIT
License (see [LICENSE](LICENSE)).
