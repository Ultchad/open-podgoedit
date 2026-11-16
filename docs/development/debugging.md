# Debugging

## 1. Logging

Use `PODGO_LOG=debug` for protocol-level logs. Logs are structured and redact
serials and paths.

Levels:

| Level | Contents |
|---|---|
| `error` | failed operation, user-visible |
| `warn` | recoverable anomaly, unknown opcode |
| `info` | session transitions, object reads |
| `debug` | frame summaries (cmd, seq, cursor, length) |
| `trace` | hex dumps, only with explicit opt-in |

**Never** log full preset bodies or personal data by default.

## 2. Frame summaries

Use the same compact format as the reference:

```text
len=  16 cmd=0x08 seq=  6 cursor=0x00001138 src=0110->ef03 sub=
```

This makes captures comparable without dumping payloads.

## 3. Mock transport

Set `PODGO_MOCK=1` and point `PODGO_FIXTURES` at a directory containing:

```text
handshake_ack.bin
open_obj22.bin
stream_0.bin ... stream_n.bin
```

The mock replays responses and asserts the host's request sequence.

## 4. USB tracing

### Linux

```sh
sudo modprobe usbmon
sudo tshark -i usbmon1 -Y 'usb.idVendor == 0x0e41'
```

### Windows

Use USBPcap + Wireshark. Filter by `usb.idVendor == 0x0e41`.

### macOS

`system_profiler SPUSBDataType` for descriptors; CoreMIDI monitor for MIDI.
Kernel-level USB capture requires additional tooling; prefer the device-side
behaviour and the mock.

## 5. Common problems

| Symptom | Likely cause | Action |
|---|---|---|
| Handshake timeout | wrong endpoint/interface | dump descriptors |
| First read has stale data | missing drain | drain 50 ms |
| `status != 0` | unsupported operation/firmware | read error key `111` |
| Preset parse fails | truncated stream | check cursor/window logic |
| Re-encode differs | unknown field normalized | compare byte diff |
| Device rejected after write | integrity seal mismatch | restore backup, investigate |

## 6. Byte-diff workflow

```sh
cmp -l original.bin reencoded.bin | head
```

A non-empty diff on an unmodified preset is a bug in unknown preservation.

## 7. Capturing evidence

When recording a session, include:

- date, OS, app version,
- device model, firmware, serial (redacted),
- exact commands,
- frame summaries,
- interpretation and confidence,
- next validation step.

Add the record to `docs/reverse-engineering/analysis-log.md`.

## 8. Safe abort

If a transfer hangs: cancel the read, close the handle, mark the session failed,
and require a new handshake. Never issue a second write to "unstick" the device.
