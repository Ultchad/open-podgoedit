# Device connection

> **Status:** the Web (Chromium) read-only path is hardware-tested on a POD Go
> Wireless (firmware 2.50). Native desktop and mobile transports are still
> planned. See
> [platform-support-matrix](../architecture/platform-support-matrix.md).

## 1. Before you connect

- Install the latest official POD Go firmware (the editor does not update
  firmware).
- Close the official POD Go Edit while using this application; two clients
  cannot own the vendor interface at once.
- Use a data-capable USB cable, not a charge-only cable.

## 2. Web (Chromium)

1. Open the app over HTTPS, `http://localhost` or `http://127.0.0.1`.
2. Click **Connect**.
3. Select the device in the browser prompt (`POD Go`, VID `0e41`; PID `4247`,
   or `424b` for the Wireless model).
4. Grant permission.
5. Click **Read User** or **Read Factory** to stream a setlist. Every USB
   operation is read-only.

WebUSB is not available in Safari or Firefox. Those browsers run in offline
mode; use the desktop app for device access.

## 3. Windows

- The official editor installs the WinUSB driver. If the device is recognised
  by the official editor, this app can use the same binding.
- Do not replace the driver with a generic one.
- If the device is not found, open Device Manager and check for a warning icon.

## 4. macOS

- No driver installation is required.
- If the app is sandboxed, USB access requires the
  `com.apple.security.device.usb` entitlement; the distributed build is not
  sandboxed.
- If the device is busy, quit the official editor and any MIDI utility that
  claims the interface.

## 5. Linux

Install the udev rule:

```sh
sudo cp 99-podgo.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Verify:

```sh
lsusb | grep -i '0e41'
```

You should see `0e41:4247`. Then reconnect the device.

## 6. Android

1. Use a USB OTG adapter.
2. Connect the device.
3. Grant the USB permission prompt.
4. If the prompt does not appear, enable OTG in system settings and retry.

## 7. iOS / iPadOS

Direct vendor USB access is **not currently supported** through public APIs.
The app works offline and can manage/import/export presets. MIDI control may be
possible if the device exposes a class-compliant MIDI interface; this is
unverified and will only be claimed after hardware testing.

## 8. Connection states

| State | Meaning |
|---|---|
| Disconnected | no device |
| Discovering | enumerating |
| Opening | handle open, claiming interface |
| Handshaking | session init |
| Ready | reads allowed |
| Syncing | applying changes |
| Failed | recoverable error; reconnect required |

## 9. Safe disconnect

Use **Disconnect** in the app before unplugging. If the cable is pulled during
an operation, the app marks the session failed and requires a fresh connection.
