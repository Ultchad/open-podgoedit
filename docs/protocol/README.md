# Protocol documentation

This directory is the implementation-oriented companion to
[`docs/reverse-engineering/protocol-specification.md`](../reverse-engineering/protocol-specification.md).
The specification records evidence and confidence; these pages describe the
contract the Rust crates implement.

| Page | Contents |
|---|---|
| [framing.md](framing.md) | Frame layout, commands, sequence, chunking |
| [messages.md](messages.md) | Message catalogue and response correlation |
| [presets.md](presets.md) | `l6-helix`, `.pgp`, `.pgb` structures and the read-only web adapter |
| [model-catalog.md](model-catalog.md) | model/parameter catalog: provenance, generation, formatting, validation |
| [notifications.md](notifications.md) | Event opcodes and framing |
| [writes.md](writes.md) | Gated `set_param`, `save_preset`, full backup and op-5 restore, gates, golden vectors |

## Confidence convention

`C` confirmed, `S` strongly supported, `H` hypothesis, `U` unknown,
`L` platform limitation.

## Non-negotiable rules

1. Little-endian everywhere.
2. One write, then exactly one read.
3. Unknown bytes are preserved, never zeroed.
4. Parsers never panic; they return typed errors.
5. No other write command is enabled: only `set_param` and metadata-only
   `save_preset` ship, behind the `device-write` feature and the runtime gates
   in [writes.md](writes.md).
