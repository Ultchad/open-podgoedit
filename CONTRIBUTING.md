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
