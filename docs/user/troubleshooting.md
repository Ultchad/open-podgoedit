# Troubleshooting

## The app does not see my device

1. Confirm the cable carries data.
2. Close the official POD Go Edit and any MIDI utility.
3. Linux: install `99-podgo.rules` and replug.
4. Windows: check Device Manager for a driver warning.
5. macOS: check `system_profiler SPUSBDataType`.
6. Web: use Chromium over HTTPS/localhost.

## The browser says WebUSB is unavailable

WebUSB is Chromium-only. Use the desktop app or continue in offline mode. This
is a documented platform limitation, not a bug.

## Handshake fails

- Another application may own the interface.
- The device may be in update mode (`1fc9:000c`); reconnect normally.
- Try a different USB port; avoid unpowered hubs.

## Presets load but names look wrong

The setlist stream may be misaligned. Disconnect, reconnect and reload. If it
persists, record the firmware version and open an issue with a redacted frame
summary.

## Re-exported preset differs from the original

This is a bug in unknown-field preservation. Do not write it to the device.
Attach both files and the byte diff to an issue.

## Write is rejected by the device

Writing is disabled in the read-only milestone. If you are on a development
build, restore your backup and report the firmware version and operation.

## iOS cannot connect

Expected. Direct vendor USB is not supported through public APIs. Use offline
management or export/import via the desktop app.

## Android permission prompt does not appear

Enable USB OTG, use a known-good adapter, and replug. Some OEMs require
"USB debugging" or a per-app permission.

## Logs and privacy

Logs redact serial numbers and paths by default. Review any file before sharing;
preset names may be personal.

## Reporting a bug

Include:

- platform and version,
- connection state,
- device model and firmware,
- steps to reproduce,
- redacted frame summary,
- whether a backup exists.

Do not attach proprietary binaries, firmware or unreviewed personal presets.
