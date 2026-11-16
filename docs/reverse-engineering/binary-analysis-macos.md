# Binary analysis — macOS

Artifact: `reverse/bin/PODGoEdit.dmg`
Extraction: DMG → `PODGoEdit.pkg` → gzip/cpio payload, into
`/tmp/opencode/podgo-re/mac/` (outside the repository).
Target analysed:
`POD Go Edit.app/Contents/MacOS/POD Go Edit`
Size: 14,374,832 bytes (reported by `rabin2 -I`).

No decompiled code is reproduced. Strings and symbols are cited as evidence.

## 1. Container and bundle

| Property | Value | Tool |
|---|---|---|
| DMG | bzip2 UDIF, 33,593,977 bytes | `file`, `7z l` |
| Payload | gzip → ASCII cpio (odc), 60,721,664 bytes | `file`, `cpio` |
| App bundle id | `com.line6.podgoedit` | `Info.plist` |
| Executable | `POD Go Edit` | `Info.plist` |
| Document types | `com.line6.podgoedit.preset`, `com.line6.podgoedit.setlist` | `Info.plist` |
| `AllowOfflineMode` | `true` | `Info.plist` |
| Build machine | `19F101` (macOS 10.15.5 era) | `Info.plist` |
| Minimum macOS | 10.15 (per `LSMinimumSystemVersion`) | `Info.plist` |
| Architecture | x86_64 only (`MACH064`, x86_64 all) | `rabin2 -I` |

`AllowOfflineMode=true` is notable: the official client is explicitly designed
to work without a device, which supports an offline-first core.

## 2. Linked libraries and frameworks

`rabin2 -l`:

```
/System/Library/Frameworks/CoreMIDI.framework/Versions/A/CoreMIDI
/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit
@executable_path/../MacOS/libusb-1.0.0.dylib
/System/Library/Frameworks/SystemConfiguration.framework/Versions/A/SystemConfiguration
/System/Library/Frameworks/IOKit.framework/Versions/A/IOKit
/usr/lib/libz.1.dylib
/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation
/usr/lib/libobjc.A.dylib
/usr/lib/libc++.1.dylib
/usr/lib/libSystem.B.dylib
/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit
/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation
/System/Library/Frameworks/CoreGraphics.framework/Versions/A/CoreGraphics
/System/Library/Frameworks/CoreServices.framework/Versions/A/CoreServices
/System/Library/Frameworks/CoreText
```

**Confirmed facts:**

- macOS uses **CoreMIDI** and a **bundled libusb 1.0** dylib.
- WebKit is used (embedded HTML/JS UI or updater pages).
- IOKit/SystemConfiguration are available for device/network notifications.

**Strongly supported conclusion:** the vendor bulk protocol goes through libusb,
exactly like the Windows path, while MIDI uses CoreMIDI. This is cross-platform
architecture evidence, not a macOS-only quirk.

## 3. Protocol-related symbols and object files

`strings -a -n 5` revealed build paths and class names:

- `L6UsbBulkMsgChannel_OSX`
- `L6UsbControlEndpointMsgPort_OSX`
- `L6LibUsbControlEndpointItf`
- `L6PodGoPreset_DeviceSerialize`
- `L6PodGoPreset_HelixCoreSerialize`
- `L6PodGoPreset_Translate`
- `L6PodGoSetlist`
- `L6PodGoUMDArchive`
- `MsgPackL6Variant`
- `MurmurHash3`
- `L6EdLib_UndoMgr`
- `McWeb`
- `L6MIDI*CoreMIDI`
- `AuthenticationManager`
- `L6UpdateEngine`
- Build root: `/Users/builder/bamboo-agent-home/.../lib/l6devicelib/...`

Also observed object files under `McBsp/McBspMessaging`: `BspChannel.o`,
`BspRouter_OSX.o`, `CircBuf.o`, `MsgCore.o`, `McBspMessaging.o`.

**Interpretation:**

- A shared `l6devicelib` is built for Windows and macOS; only the OS-specific
  bulk/control channel and MIDI backends differ (`_Win` vs `_OSX`).
- `MsgPackL6Variant` confirms MessagePack as the payload serialization.
- `MurmurHash3` is present, but its *use* is not proven; it is a candidate for
  the object-14 seal and must not be assumed (see unknowns).
- `L6EdLib_UndoMgr` supports the expectation that undo is an editor-level
  concern, not device state.
- `AuthenticationManager` exists. No attempt was made to inspect or bypass it;
  it is out of scope per the legal policy.

## 4. VID/PID confirmation

Disassembly at `0x10000e2a0`:

```asm
0x10000e2b5  cmp eax, 0x1fc9
0x10000e2bf  cmp eax, 0xe41
0x10000e2cc  cmp eax, 0x424b
0x10000e2d6  cmp eax, 0x4247
0x10000e2e7  cmp word [rbx+0x02], 0x0c
```

**Confirmed facts:**

- Vendor ID `0x0E41`.
- Product IDs `0x4247` and `0x424B`.
- Additional `0x1FC9` / `0x000C` identity.

This matches the Windows binary and the Python constant `VENDOR_ID = 0x0E41`.

**Confidence:** confirmed for the comparisons.

## 5. Resources

`Contents/Resources/` contains the same logical set as Windows:

`PGControls.json`, `PGModelCatalog.json`, `PGModelCatalog.bin`, `PodGo.sym`,
`PodGoModelDefs.bin`, `*.models`, `default_preset_p34.hlx`,
`POD Go Edit Pilot's Guide.pdf`, plus `Assets.car`, `AppIcon.icns`,
`Dialogs.nib`, `MainMenu.nib`.

**Conclusion (confirmed):** Windows and macOS ship the same data model and
resource formats. A single cross-platform domain layer is justified.

## 6. macOS-specific behaviour and constraints

- No App Sandbox entitlement is visible in `Info.plist`; the app is distributed
  outside the Mac App Store. A sandboxed Mac App Store build would need
  `com.apple.security.device.usb` and likely cannot ship a bundled libusb
  without additional entitlements.
- `CoreMIDI` means the device exposes a class-compliant MIDI interface in
  addition to the vendor bulk interface. This is a **strongly supported**
  conclusion and the basis for a possible iOS MIDI-only path.
- The app is Intel-only; Apple Silicon runs it under Rosetta 2. A native
  arm64 build is a plausible future target.

## 7. Tooling limitations

| Attempt | Result |
|---|---|
| `rea.open_binary` | PE target opened; Mach-O analysis not completed |
| `rea.inspect_macho` | unavailable on this Linux host |
| `rea.inspect_binary_layout` | unavailable (pwntools not configured) |
| `rea.inspect_signature` | not run (macOS tooling absent) |
| Ghidra decompilation | not available within limits |

Fallback: `rabin2`, `rizin`, `strings`, `7z`, `cpio`, `gzip`, `file`. No
code-signature or entitlement verification was possible on Linux. This is a
**platform limitation**.

## 8. Conclusions

| Claim | Confidence |
|---|---|
| macOS client bundles libusb and links CoreMIDI | Confirmed |
| Same `l6devicelib` shared with Windows | Strongly supported |
| Same VID/PID set as Windows | Confirmed |
| MessagePack payload (`MsgPackL6Variant`) | Strongly supported |
| `MurmurHash3` used for object-14 seal | Hypothesis (presence only) |
| App supports offline mode | Confirmed (`AllowOfflineMode`) |
| CoreMIDI class-compliant device path | Strongly supported |
| iOS can use the vendor bulk protocol | Unknown / likely unsupported |

## 9. Next validation steps

1. Dump the USB descriptor set on macOS (`system_profiler SPUSBDataType`) with a
   real POD Go to confirm interface/endpoint numbers and the MIDI interface.
2. Test whether a CoreMIDI-only client can select presets and snapshots without
   the vendor bulk channel.
3. Verify whether `MurmurHash3` input is the object-22 blob (controlled change).
