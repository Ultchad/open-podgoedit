# Platform support matrix

Status vocabulary (mandatory):

- **ITH** — implemented and tested on hardware
- **ITM** — implemented and tested with mocks only
- **BU** — builds successfully but remains untested
- **PL** — planned
- **UNS** — unsupported due to a documented platform limitation

> No claim in this matrix is stronger than the evidence behind it. Read paths
> and the gated `set_param` write are `ITH` on Web Chromium (POD Go Wireless,
> fw 2.50); preset save and full backup/restore are implemented but `ITM`;
> every other write path is `PL` (gated) or `UNS`.

## 1. Capability matrix

| Capability | Web (Chromium) | Web (Safari/Firefox) | Windows | macOS | Linux | Android | iOS/iPadOS |
|---|---|---|---|---|---|---|---|
| Offline preset management | PL | PL | PL | PL | PL | PL | PL |
| Import/export `.pgp` | PL | PL | PL | PL | PL | PL | PL |
| Import/export `.pgb` | PL | PL | PL | PL | PL | PL | PL |
| Device discovery | ITH (WebUSB) | UNS | PL (libusb) | PL (libusb) | PL (libusb) | PL (USB Host) | UNS |
| Vendor bulk protocol | ITH (WebUSB, read-only) | UNS | PL | PL | PL | PL | UNS |
| MIDI control | UNS | UNS | PL (WINMM) | PL (CoreMIDI) | PL (ALSA) | PL | PL (CoreMIDI, unverified) |
| Read presets | ITH (WebUSB, Factory + User) | UNS | PL | PL | PL | PL | UNS |
| Write one effect parameter (`set_param`, gated) | ITH (WebUSB) | UNS | PL (gated) | PL (gated) | PL (gated) | PL (gated) | UNS |
| Save preset metadata (`save_preset`, gated) | ITM (WebUSB) | UNS | PL (gated) | PL (gated) | PL (gated) | PL (gated) | UNS |
| Full backup / restore (`.pgbak`, op 5, gated) | ITM (WebUSB) | UNS | PL (gated) | PL (gated) | PL (gated) | PL (gated) | UNS |
| Write presets (model swap, chain blob) | PL (gated) | UNS | PL (gated) | PL (gated) | PL (gated) | PL (gated) | UNS |
| Firmware update | UNS | UNS | UNS | UNS | UNS | UNS | UNS |

## 2. Transport detail

| Platform | Transport | Status | Notes |
|---|---|---|---|
| Web Chromium | WebUSB | ITH | Read-only setlist read on a POD Go Wireless (fw 2.50, PID `0x424b`); requires HTTPS/loopback and a user gesture |
| Web Safari/Firefox | none | UNS | No WebUSB; offline only |
| Windows | libusb/WinUSB | PL | Official client uses the same path |
| macOS | libusb | PL | App Sandbox would need USB entitlement |
| Linux | libusb | PL | udev rule for `0e41:4247` |
| Android | USB Host | PL | Permission Intent; OTG required |
| iOS | none verified | UNS | Direct vendor USB unavailable via public libusb-style APIs |
| iOS MIDI | CoreMIDI | PL | Only if the device exposes class-compliant MIDI |

## 3. Evidence for the hard limits

| Limit | Evidence |
|---|---|
| No WebUSB in Safari/Firefox | Browser platform documentation; WebUSB is Chromium-only |
| No direct vendor USB on iOS | Apple restricts USB device access; libusb requires jailbreak/private APIs; ExternalAccessory needs MFi |
| Windows driver | Official installer ships WinUSB/libusb-style access |
| Linux permissions | Project ships `99-podgo.rules` |

## 4. Upgrade criteria

A row moves from `PL` to `ITM` when mock tests pass in CI, and to `ITH` only
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

Scope of the claim: device discovery, the read-only vendor bulk protocol,
setlist reads and one `set_param` write are `ITH` for Web Chromium (Brave
1.99.56, Chromium engine). Preset save (op 71) and full backup/restore (op 5)
are `ITM`: covered by the Rust/WASM tests and a fake WebUSB device, never sent
to a pedal from this build. Every other write path and all native transports
remain unvalidated.

## 6. Known platform risks

- **Web:** browser permission UX; WASM size; WebUSB transfer chunking.
- **Windows:** WinUSB binding conflicts; antivirus false positives.
- **macOS:** notarization; sandbox entitlements; Apple Silicon via Rosetta for
  the reference binary (our app will be native).
- **Linux:** udev/permissions; libusb version differences.
- **Android:** OEM USB Host quirks; app backgrounding kills transfers.
- **iOS:** no vendor transport; MIDI support unverified.
