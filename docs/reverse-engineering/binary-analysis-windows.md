# Binary analysis — Windows

Artifact: `reverse/bin/POD_Go_Edit_v2.50_Installer.exe`
Extraction: `7z x` into `/tmp/opencode/podgo-re/win/` (outside the repository).
Target analysed: `POD Go Edit/POD Go Edit.exe`
SHA-256: `1edab677ffedbf0cb15ab9accb6a9c44a7b7b11229e74d8a88d711f901e9240b`
Size: 9,203,088 bytes.

This document records only observations actually obtained. No decompiled code
is reproduced; function names and strings are cited as evidence, not copied
source.

## 1. Container and version

| Property | Value | Tool |
|---|---|---|
| Installer type | PE32 i386, NSIS self-extracting | `file`, `7z l` |
| Installer size | 69,906,696 bytes | `ls` |
| Inner exe | PE32 GUI, 5 sections | `objdump -h` |
| Sections | `.text` 0x6572BC, `.rdata` 0x15FD62, `.data` 0x24000, `.rsrc` 0x5B030, `.reloc` 0x8DA68 | `objdump -h` |
| Linker | 14.39 | PE header parse |
| Timestamp | 2025-01-14 | `rabin2 -I` |
| Company | Yamaha Guitar Group, Inc. | `strings -el` |
| Product | POD Go Edit | `strings -el` |
| Version | 2.50 | `strings -el` |
| PDB path | `C:\build\SW-PGWRFT-PODGO\projects\win\Release\POD Go Edit.pdb` | `rabin2 -I` |
| Signed | true (Authenticode) | `rabin2 -I` |

## 2. Imports

`objdump -p` DLL list:

```
WINMM.dll, gdiplus.dll, VERSION.dll, SHLWAPI.dll, SETUPAPI.dll,
IPHLPAPI.DLL, WININET.dll, KERNEL32.dll, USER32.dll, GDI32.dll,
ADVAPI32.dll, SHELL32.dll, ole32.dll, OLEAUT32.dll, pthreadVC2.dll,
COMCTL32.dll, COMDLG32.dll
```

Relevant APIs observed with `rabin2 -i`:

- `WINMM.dll`: `midiInOpen`, `midiInClose`, `midiInPrepareHeader`,
  `midiOutOpen`, `midiOutClose`, `midiOutShortMsg`, `midiOutLongMsg`,
  `midiOutReset`, `midiOutGetDevCapsW`.
- `SETUPAPI.dll`: device enumeration (SetupDi family).
- `KERNEL32.dll`: `CreateFileW`, `DeviceIoControl`, file I/O.
- `Interposer.dll` referenced in strings (audio interposer, not protocol).

**Interpretation (strongly supported):** the editor enumerates USB devices with
SetupAPI, opens a WinUSB/libusb-style handle with `CreateFile` +
`DeviceIoControl`, and uses WINMM for class-compliant MIDI. There is no dynamic
`libusb-1.0.dll` import; libusb is statically linked or wrapped by the
`L6LibUsbControlEndpointItf` layer.

**Confidence:** strongly supported.

## 3. Protocol-related strings

Observed with `strings -a -n 5` and `rabin2 -zz`:

- `L6DeviceCenter_Win::enumerateUsbDevices() - device: vid 0x%x, pid 0x%x added`
- `L6DeviceCenter_Win::instanceDeviceHelper(VERIFYING) - adding device %s, model %s (midi 0x%x)`
- `L6DeviceCenter_Win::instanceDeviceHelper(CONNECT) - rejecting device (interlock) ...`
- `L6UsbBulkMsgChannel`, `L6UsbControlEndpointItf`, `L6LibUsbControlEndpointItf`
- `L6HelixMsgPort`
- `WinUsb`, `kUsbBulkEndpointMode`, `kUsbControlEndpointMode`
- `DeviceModel`, `DeviceSerialNo`, `DeviceFirmwareVersion`,
  `DeviceFirmwareBuild`, `DeviceFirmwareVersionString`
- `POD Go`, `POD Go Wireless`, `Helix Floor`, `Helix Rack`, `Helix LT`,
  `Helix Control`
- `.?AVL6Device@@`, `.?AVL6DeviceCenter_Win@@`, `.?AVL6DeviceLibInterlock@@`,
  `.?AVL6HelixMsgPort@@`

**Interpretation:** device discovery, model identification, firmware metadata,
bulk/control endpoint abstraction and an "interlock" rejection path exist in the
official client. Names alone are not proof of wire semantics; they corroborate
the Python model.

## 4. VID/PID confirmation

Disassembly at `0x005be6c0` (rizin):

```asm
0x005be6dd  mov dword [ebp+0x08], 0x4247
0x005be6ea  mov eax, 0xe41
0x005be6ef  mov dword [ebp-0x04], 0x424b
0x005be6f6  cmp dx, ax                  ; idVendor == 0x0E41
0x005be706  cmp ax, word [ebp+0x08]     ; idProduct == 0x4247
0x005be70c  mov eax, 0x1fc9
0x005be716  cmp word [esi+0x02], 0x0c   ; 0x1FC9:0x000C
0x005be71d  cmp word [ebp-0x0c], ax     ; or idProduct == 0x424B
```

**Confirmed facts:**

- Vendor ID `0x0E41` (Line 6).
- Product IDs `0x4247` (POD Go) and `0x424B` (POD Go Wireless class product).
- Additional identity `0x1FC9:0x000C` (NXP vendor; consistent with a
  bootloader/update mode).

**Confidence:** confirmed for the comparisons; the *role* of `0x424B` and
`0x1FC9` is strongly supported but not exercised.

## 5. `l6-helix` and resource evidence

- Magic `l6-helix\0` found at `.rdata` `0x00aaffb0`, `0x00abc6b9`,
  `0x00bb90f1`, `0x00bb9ed1`, `0x00bbacd9`, `0x00bbbab1`.
- MessagePack-prefixed magic `a9 6c 36 2d 68 65 6c 69 78` at `0x00abc6b8`,
  `0x00bb90f0`, `0x00bb9ed0`, `0x00bbacd8`, `0x00bbbab0`.

**Interpretation:** the official client embeds the same container format used
on the wire (`l6-helix`), confirming the Python findings.

**Confidence:** confirmed.

## 6. Embedded resources

Extracted `res/`:

| File | Size | Nature |
|---|---|---|
| `PGControls.json` | 113,336 | Control/display metadata |
| `PGModelCatalog.json` | 290,022 | Categories, models, images |
| `PGModelCatalog.bin` | 116,896 | Binary catalog |
| `PodGo.sym` | 94,058 | JSON symbol table |
| `PodGoModelDefs.bin` | 661,392 | Binary model definitions |
| `amp.models` … `filter.models` | 27–355 KB | JSON model metadata |
| `default_preset_p34.hlx` | 7,440 | JSON default preset |
| `POD Go Edit Pilot's Guide.pdf` | 20 MB | Manual (not analysed for content) |

Structural observations:

- `PodGo.sym` is a JSON array of `{"symbol": "...", "parameters": [...]}`.
  The array index is the on-wire model id (key 25), per the Python project and
  corroborated by the embedded `.hlx` model names.
- `*.models` is a JSON array of objects with `symbolicID`, `cablink`,
  `category`, parameter metadata.
- `default_preset_p34.hlx` is **JSON text**, not MessagePack; `.hlx` files are
  the JSON authoring format, while the device blob is the binary container.
- `PGModelCatalog.json` lists categories with numeric ids, `shortName`,
  `color` and model entries.

**Confidence:** confirmed for structure; the mapping index↔wire id is strongly
supported (validated 16/16 in the Python project, not re-run here).

## 7. Initialization/shutdown shape (from strings and imports)

- `VERIFYING` then `CONNECT` phases during device instantiation.
- Interlock rejection path before a device is accepted.
- Firmware/model/serial metadata read during verification.
- MIDI device id derived per device (`midi 0x%x`).

**Confidence:** strongly supported as control flow; exact packet order is not
proven here.

## 8. Tooling limitations

| Attempt | Result |
|---|---|
| `rea.open_binary` | succeeded |
| `rea.inspect_pe_resources` | succeeded (evidence `ev_25aa388a…`) |
| `rea.binary_overview` | **timeout** after 330 s (Ghidra analysis) |
| `rea.inspect_binary_layout` | unavailable (pwntools not configured) |
| Ghidra decompilation | not available within limits |

Fallback: `rabin2`, `rizin`, `objdump`, `strings`, `7z`. No function-level
decompilation was performed, so conclusions rely on imports, strings,
disassembly snippets and resources. This is a **platform limitation**, not a
negative result.

## 9. Conclusions

| Claim | Confidence |
|---|---|
| Windows client is 32-bit PE, v2.50, Yamaha | Confirmed |
| Uses SetupAPI + WinUSB/libusb bulk transport | Strongly supported |
| Uses WINMM MIDI | Confirmed |
| VID `0x0E41`, PID `0x4247`/`0x424B` | Confirmed |
| Bootloader identity `0x1FC9:0x000C` | Strongly supported |
| Embeds `l6-helix` container | Confirmed |
| Same resource schema as macOS | Confirmed (structure) |
| Exact handshake byte order on Windows | Not proven (consistent with Python) |

## 10. Next validation steps

1. Capture a read-only connect with USBPcap and compare the first ten frames to
   the Rust codec.
2. Confirm `0x424B` product identity on hardware or via descriptor dump.
3. Resolve object-14 checksum with a controlled single-parameter change.
