# Capture catalogue

Every protocol claim in this repository points at a file here. Files live in
`reverse/exports/` (gitignored: they may contain personal preset names) and
the derived fixtures in `fixtures/`.

| File | Taken | Content | Used by |
|---|---|---|---|
| `podgo-connect.pcapng` | | enumeration, read handshake, objects 4/8/20/22/39 | read path |
| `podgo-catalog.pcapng` | | model catalog reads | catalog |
| `podgo-events.pcapng` | | 11 guided pedal actions, opcodes 0–49 | notifications.md |
| `podgo-full-backup.pcapng` | | full device backup | backup |
| `podgo-backup-restore.pcapng` | | 157 op-5 restore messages | writes.md §2.6 |
| `podgo-preset-save.pcapng` | 2026-11-13 | op-71 save frame | writes.md §2.5 |
| `podgo-bypass-and-remove-effect.pcapng` | | op 20/28/41/78 | writes.md §2.5a |
| `podgo-move-preset.pcapng` | | preset move between slots | librarian |
| `podgo-move-effect.pcapng` | | two op-21 chain uploads after drags | writes.md §2.5d |
| `podgo-snapshots.pcapng` | 2026-11-24 | snapshot 2→1, parameter→snapshots, rename, LED colour, save | writes.md §2.5c |

## `podgo-snapshots.pcapng` (2026-11-24)

POD Go Edit 2.50 with a POD Go on fw 2.50, captured on Windows 11 with
USBPcap (`Dumpcap`), bus 2, device 4, endpoints `0x01` (out) and `0x81` (in).
The session follows this order:

| Transaction | Direction | Command | Status |
|---|---|---|---|
| 1006 | H→D | op 88 `{92: 0}` (snapshot 1) | 0, then `105:42`, `105:22`, `105:46` |
| 1008 | H→D | op 37 `{98: 3, 29: true, 26: 0, 28: 0, 74: 11, 71: 0}` | 0, then `105:34` ×2 |
| 1010–1012 | H→D | op 30 on block 3, `Drive` 0.20 → 0.30 → 0.34 | 0 |
| 1013 | H→D | op 89 `{92: 0, 109: "test1\0"}` | 0, `105:43` |
| 1014 | H→D | op 98 `{92: 0, 66: 3}` | 0, `105:48` |
| 1015 | H→D | op 88 `{92: 1}` (snapshot 2) | 0, `105:42`, `105:49` (null), `105:46` |
| 1017 | H→D | op 71 `{107: 1, 108: 36, 109: "Preset Test3\0"}` | 0, `105:5`, `105:6` |
| 1018 | H→D | op 78 `{98: 6}` | 0 |
| 1019–1020 | H→D | op 37 then op 36 on block 6, `Drive` | 0 |
| 1021 | H→D | op 71 save again | 0 |

Re-read it with the helper scripts described in
`docs/development/manual-testing-todo.md` §3.4: USBPcap writes a pcapng file,
and this project has no `tshark` dependency (the Rust reader and the small
Python decoder both work offline).
