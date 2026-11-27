# Platform support matrix

Status vocabulary (mandatory):

- **ITH** — implemented and tested on hardware
- **ITM** — implemented and tested with mocks only
- **BU** — builds successfully but remains untested
- **PL** — planned
- **UNS** — unsupported due to a documented platform limitation

> No claim in this matrix is stronger than the evidence behind it. Read paths
> and `set_param` are `ITH` on Web Chromium (POD Go Wireless, fw 2.50). Preset
> store/rename, delete, body copy, snapshots, save and full backup/restore are
> `ITM` (implemented and covered by fake-device tests). Desktop transports are
> `BU`; the Android bridge is `ITM`. Effect move (op 21) is implemented but
> disabled until a hardware test. iOS native remains `UNS`.

## 1. Capability matrix

| Capability | Web (Chromium) | Web (Safari/Firefox) | Windows | macOS | Linux | Android | iOS/iPadOS |
|---|---|---|---|---|---|---|---|
| Offline preset management | ITM | BU | BU | BU | BU | ITM | UNS |
| Import/export `.pgp` | ITM | BU | BU | BU | BU | ITM | UNS |
| Import/export `.pgb` | ITM | BU | BU | BU | BU | ITM | UNS |
| Device discovery | ITH (WebUSB) | UNS | BU (libusb) | BU (libusb) | BU (libusb) | ITM (USB Host) | UNS |
| Vendor bulk protocol | ITH (WebUSB) | UNS | BU | BU | BU | ITM | UNS |
| MIDI control | UNS | UNS | PL (WINMM) | PL (CoreMIDI) | PL (ALSA) | PL | UNS |
| Read presets | ITH (WebUSB, Factory + User) | UNS | BU | BU | BU | ITM | UNS |
| Live sync (event channel `0x1002`) | ITM (WebUSB) | UNS | UNS | UNS | UNS | UNS | UNS |
| Write one effect parameter (`set_param`, op 30) | ITH (WebUSB) | UNS | BU | BU | BU | ITM | UNS |
| Model change (`model`, op 40) | ITM (WebUSB) | UNS | BU | BU | BU | ITM | UNS |
| Save preset metadata (`save_preset`, op 71) | ITM (WebUSB) | UNS | BU | BU | BU | ITM | UNS |
| Delete / body copy (ops 28/78, op 5) | ITM (WebUSB) | UNS | BU | BU | BU | ITM | UNS |
| Snapshots (ops 88/89/98/37) | ITM (WebUSB) | UNS | BU | BU | BU | ITM | UNS |
| Move effect (op 21) | ITM, disabled in UI | UNS | ITM, disabled in UI | ITM, disabled in UI | ITM, disabled in UI | ITM, disabled in UI | UNS |
| Full backup / restore (`.pgbak`, op 5) | ITM (WebUSB) | UNS | BU | BU | BU | ITM | UNS |
| Firmware update | UNS | UNS | UNS | UNS | UNS | UNS | UNS |

`iOS/iPadOS` in this table means a native app. The iOS browser can still load
the offline web bundle (tier **Untested** in the roadmap); it cannot reach the
pedal.

## 2. Transport detail

| Platform | Transport | Status | Notes |
|---|---|---|---|
| Web Chromium | WebUSB | ITH | Setlist and active-preset reads plus `set_param` on a POD Go Wireless (fw 2.50, PID `0x424b`); requires HTTPS/loopback and a user gesture. Live model, save, delete, snapshot and backup/restore paths are `ITM` |
| Web Safari/Firefox | none | UNS | No WebUSB; offline browse/edit/import/export only, and not exercised by the Chromium-only suite |
| Windows | libusb/WinUSB | BU | Tauri shell compiles with the same live write paths; the pedal must be bound to WinUSB. Not run on hardware yet |
| macOS | libusb | BU | Tauri shell compiles; App Sandbox would need a USB entitlement. Not run on hardware yet |
| Linux | libusb | BU | Tauri shell compiles; udev rule for `0e41:4247`. Not run on hardware yet |
| Android | USB Host | ITM | Native bridge covered by browser tests with a fake transport; not run on a phone with a pedal yet |
| iOS | none verified | UNS | No public vendor-USB path; see the roadmap's "Not planned" tier |
| iOS MIDI | CoreMIDI | UNS | No MIDI path is implemented or planned; CoreMIDI would only help if the pedal exposed class-compliant MIDI |

## 3. Evidence for the hard limits

| Limit | Evidence |
|---|---|
| No WebUSB in Safari/Firefox | Browser platform documentation; WebUSB is Chromium-only |
| No WebUSB in Chrome for Android | WebUSB is not exposed on Android, which is why the app ships a WebView shell with a USB Host bridge |
| No direct vendor USB on iOS | Apple restricts USB device access; libusb requires jailbreak/private APIs; ExternalAccessory needs MFi |
| Windows driver | Official installer ships WinUSB/libusb-style access |
| Linux permissions | Project ships `99-podgo.rules` |
| No effect move yet | Encoder matches both captured uploads byte for byte, but the menu stays disabled until a hardware test on a backed-up User slot |

## 4. Upgrade criteria

A row moves from `PL` or `BU` to `ITM` when mock tests pass in CI, and to `ITH` only
after a recorded hardware session with:

1. device model and firmware version,
2. the exact commands run,
3. a backup taken before any write,
4. observed results.

## 5. Hardware evidence log

### 2026-11-11 — WebUSB read, POD Go Wireless

| Field | Value |
|---|---|
| Device | POD Go Wireless |
| Firmware | 2.50 (build `6e984472`) |
| PID observed | `0x424b` (vendor `0x0e41`) |
| Interface | vendor `0xFF`, interface 0, bulk OUT `0x01` / IN `0x81` |
| App | `apps/web` on `http://127.0.0.1:5173` |
| Server OS | Linux (Vite on `127.0.0.1`) |
| Client OS | Windows |
| Browser | Brave 1.99.56 (Chromium) |
| Operations | **Read User** and **Read Factory** (no write), several times |
| Result | Both reads returned 128 entries with real preset names |

Evidence files (local, `reverse/` is git-ignored):

| Setlist | Size | Entries | SHA-256 |
|---|---|---|---|
| Factory | 3668 B | 128 | `1caa7b705647d9b8b275389e19d9bbaeb2082396423461bc3a387a90886acb96` |
| User | 3416 B | 128 | `b8fe30b00405f903f2625f3ec2e26a446efca5e1ca2051719d80c57ebba20e74` |

Both exports replay through `podgo-probe --setlist` with
`128 entries`, every slot from 0 to 127, and plausible names (`US Deluxe Nrm`
and `Hit-Me_Clean` at slot 0). The User stream carries non-sequential preset
ids (128–255), which confirms the slot/id split in `preset_list`.

One structural difference shows up between the two captures. The Factory
export starts with eight extra bytes
(`00 00 02 00 4c 0e 00 00`) before the MessagePack wrapper, while the User
export starts directly on it. The trailing `u32` is `0x0e4c` = 3660, exactly
the remaining file size, so it reads as a data-message header (payload length)
that the `OPEN_STREAM` ack did not carry for Factory and that therefore landed
at the front of the first chunk. `preset_list` already tolerates it: all 128
factory entries scan correctly. Wiring both reads, including the header case,
is what this session validates.

Scope of the claim: device discovery, the vendor bulk protocol, setlist and
active-preset reads and one `set_param` write are `ITH` for Web Chromium (Brave
1.99.56, Chromium engine). Live sync, preset store/rename, delete, body copy,
snapshots, save and full backup/restore are `ITM`: covered by the Rust/WASM
tests and a fake WebUSB device, not yet confirmed on hardware. Every native
transport remains `BU` (desktop) or `ITM` (Android) until a real-device session
is recorded.

## 6. Known platform risks

- **Web:** browser permission UX; WASM size; WebUSB transfer chunking.
- **Windows:** WinUSB binding conflicts; antivirus false positives.
- **macOS:** notarization; sandbox entitlements; Apple Silicon via Rosetta for
  the reference binary (our app will be native).
- **Linux:** udev/permissions; libusb version differences.
- **Android:** OEM USB Host quirks; app backgrounding kills transfers.
- **iOS:** no vendor transport; MIDI support unverified.
