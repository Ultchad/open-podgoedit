#!/usr/bin/env python3
"""Analyse a POD Go USBPcap capture (pcapng) without third-party modules.

The capture must come from USBPcap (Wireshark on Windows, link type 249).
Only the little-endian pcapng container is handled, which is what USBPcap
writes. See `docs/development/manual-testing-todo.md` §3.4 for the capture
protocol and `docs/protocol/notifications.md` for the framing this tool
decodes.

Usage:
    python3 tools/podgo-capture.py summary capture.pcapng
    python3 tools/podgo-capture.py map capture.pcapng [--gap 4]
    python3 tools/podgo-capture.py events capture.pcapng [--gap 4]
    python3 tools/podgo-capture.py export capture.pcapng out.bin

`export` writes the notifications as `u16 LE length` + frame bytes, the format
of `fixtures/events_fw250.bin`.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

SHB_TYPE = 0x0A0D0D0A
EPB_TYPE = 0x00000006
BYTE_ORDER_MAGIC_LE = 0x1A2B3C4D
TRANSFER_BULK = 3

EVENT_SRC = 0x1002
EVENT_DST = 0x03F0
WRITE_CHANNEL = 0x1080


# --- pcapng / USBPcap -------------------------------------------------------


@dataclass
class Transfer:
    index: int
    ts_us: int
    irp_id: int
    endpoint: int
    payload: bytes

    @property
    def is_in(self) -> bool:
        return bool(self.endpoint & 0x80)


def iter_blocks(data: bytes):
    pos = 0
    while pos + 12 <= len(data):
        btype, blen = struct.unpack_from("<II", data, pos)
        if blen < 12 or blen % 4 or pos + blen > len(data):
            raise ValueError(f"corrupt pcapng block at offset {pos:#x}")
        yield btype, data[pos + 8 : pos + blen - 4]
        pos += blen


def read_transfers(path: Path) -> list[Transfer]:
    data = path.read_bytes()
    if len(data) < 12 or struct.unpack_from("<I", data)[0] != SHB_TYPE:
        raise ValueError(f"{path}: not a pcapng file")
    if struct.unpack_from("<I", data, 8)[0] != BYTE_ORDER_MAGIC_LE:
        raise ValueError(f"{path}: unsupported byte-order magic")

    transfers: list[Transfer] = []
    for btype, body in iter_blocks(data):
        if btype != EPB_TYPE:
            continue
        _, ts_hi, ts_lo, cap_len, _ = struct.unpack_from("<IIIII", body)
        record = body[20 : 20 + cap_len]
        if len(record) < 27:
            continue
        header_len = struct.unpack_from("<H", record)[0]
        info = record[16]
        endpoint = record[21]
        transfer_type = record[22]
        data_len = struct.unpack_from("<I", record, 23)[0]
        if transfer_type != TRANSFER_BULK or data_len == 0:
            continue
        payload = record[header_len : header_len + data_len]
        if len(payload) != data_len:
            continue  # truncated by snaplen: unusable
        transfers.append(
            Transfer(
                index=len(transfers),
                ts_us=(ts_hi << 32) | ts_lo,
                irp_id=struct.unpack_from("<Q", record, 2)[0],
                endpoint=endpoint,
                payload=payload,
            )
        )
    return transfers


# --- protocol framing -------------------------------------------------------


def channels(payload: bytes) -> tuple[int, int] | None:
    if len(payload) < 16:
        return None
    return (
        struct.unpack_from("<H", payload, 4)[0],
        struct.unpack_from("<H", payload, 6)[0],
    )


def is_notification(payload: bytes) -> bool:
    return (
        len(payload) >= 28
        and channels(payload) == (EVENT_DST, EVENT_SRC)
        and payload[11] == 0x04
    )


def notification_body(payload: bytes) -> bytes:
    declared = struct.unpack_from("<I", payload, 20)[0]
    return payload[24 : 24 + declared]


# --- minimal MessagePack decoder -------------------------------------------


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def take(self, n: int) -> bytes:
        chunk = self.data[self.pos : self.pos + n]
        if len(chunk) != n:
            raise ValueError("truncated")
        self.pos += n
        return chunk

    def u8(self) -> int:
        return self.take(1)[0]

    def value(self):
        marker = self.u8()
        if marker <= 0x7F:
            return marker
        if marker >= 0xE0:
            return marker - 0x100
        if 0x80 <= marker <= 0x8F:
            return {self.value(): self.value() for _ in range(marker & 0x0F)}
        if 0x90 <= marker <= 0x9F:
            return [self.value() for _ in range(marker & 0x0F)]
        if 0xA0 <= marker <= 0xBF:
            return self.take(marker & 0x1F).decode("utf-8", "replace")
        if marker == 0xC0:
            return None
        if marker == 0xC2:
            return False
        if marker == 0xC3:
            return True
        if marker == 0xC4:
            return self.take(self.u8())
        if marker == 0xC5:
            return self.take(struct.unpack(">H", self.take(2))[0])
        if marker == 0xC6:
            return self.take(struct.unpack(">I", self.take(4))[0])
        if marker == 0xCA:
            return struct.unpack(">f", self.take(4))[0]
        if marker == 0xCB:
            return struct.unpack(">d", self.take(8))[0]
        if marker == 0xCC:
            return self.u8()
        if marker == 0xCD:
            return struct.unpack(">H", self.take(2))[0]
        if marker == 0xCE:
            return struct.unpack(">I", self.take(4))[0]
        if marker == 0xCF:
            return struct.unpack(">Q", self.take(8))[0]
        if marker == 0xD0:
            return struct.unpack(">b", self.take(1))[0]
        if marker == 0xD1:
            return struct.unpack(">h", self.take(2))[0]
        if marker == 0xD2:
            return struct.unpack(">i", self.take(4))[0]
        if marker == 0xD3:
            return struct.unpack(">q", self.take(8))[0]
        if marker in (0xD9, 0xDA, 0xDB):
            size = {
                0xD9: lambda: self.u8(),
                0xDA: lambda: struct.unpack(">H", self.take(2))[0],
                0xDB: lambda: struct.unpack(">I", self.take(4))[0],
            }[marker]()
            return self.take(size).decode("utf-8", "replace")
        if marker == 0xDC:
            return [self.value() for _ in range(struct.unpack(">H", self.take(2))[0])]
        if marker == 0xDD:
            return [self.value() for _ in range(struct.unpack(">I", self.take(4))[0])]
        if marker == 0xDE:
            return {
                self.value(): self.value()
                for _ in range(struct.unpack(">H", self.take(2))[0])
            }
        if marker == 0xDF:
            return {
                self.value(): self.value()
                for _ in range(struct.unpack(">I", self.take(4))[0])
            }
        raise ValueError(f"unsupported marker {marker:#04x} at {self.pos - 1}")


def decode_event(payload: bytes) -> dict | None:
    try:
        value = Reader(notification_body(payload)).value()
    except Exception:
        return None
    return value if isinstance(value, dict) and 105 in value else None


# --- commands ---------------------------------------------------------------


def cmd_summary(transfers: list[Transfer]) -> None:
    duration = (transfers[-1].ts_us - transfers[0].ts_us) / 1e6
    print(f"transfers with data: {len(transfers)} over {duration:.1f} s")
    endpoints: dict[tuple[int, str], int] = {}
    for transfer in transfers:
        key = (transfer.endpoint, "IN" if transfer.is_in else "OUT")
        endpoints[key] = endpoints.get(key, 0) + 1
    print("by endpoint:", dict(sorted(endpoints.items())))

    counts: dict[tuple[int, int], int] = {}
    for transfer in transfers:
        channel = channels(transfer.payload)
        if channel:
            counts[channel] = counts.get(channel, 0) + 1
    print("by channel (src -> dst):")
    for (src, dst), count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  0x{src:04x} -> 0x{dst:04x} : {count}")

    notifications = [t for t in transfers if is_notification(t.payload)]
    opcodes = {}
    for transfer in notifications:
        event = decode_event(transfer.payload)
        if event:
            opcodes[event[105]] = opcodes.get(event[105], 0) + 1
    print(f"notifications: {len(notifications)}")
    print("opcodes:", dict(sorted(opcodes.items())))


def bursts(transfers: list[Transfer], gap_s: float) -> list[list[Transfer]]:
    notification_times = [
        t.ts_us for t in transfers if is_notification(t.payload)
    ]
    groups: list[list[Transfer]] = []
    last_ts = None
    for transfer in transfers:
        if not is_notification(transfer.payload):
            continue
        if last_ts is not None and (transfer.ts_us - last_ts) / 1e6 >= gap_s:
            pass  # a new group starts; handled below
        if last_ts is None or (transfer.ts_us - last_ts) / 1e6 >= gap_s:
            groups.append([])
        groups[-1].append(transfer)
        last_ts = transfer.ts_us
    return groups


def cmd_events(transfers: list[Transfer], gap_s: float) -> None:
    start = transfers[0].ts_us
    write_times = [
        t.ts_us
        for t in transfers
        if channels(t.payload) and WRITE_CHANNEL in channels(t.payload)
    ]

    for number, burst in enumerate(bursts(transfers, gap_s), start=1):
        first = burst[0].ts_us
        # Write traffic in the 2 s window before the burst suggests the action
        # was initiated from POD Go Edit rather than the pedal.
        recent_write = any(first - 2_000_000 <= ts <= first for ts in write_times)
        print(
            f"\nburst {number}  t=+{(first - start) / 1e6:7.2f}s  "
            f"frames={len(burst)}  write-before={'yes' if recent_write else 'no'}"
        )
        for transfer in burst:
            event = decode_event(transfer.payload)
            if not event:
                print(f"   #{transfer.index} undecodable")
                continue
            payload = {k: v for k, v in event.items() if k != 105}
            print(f"   op={event[105]:<3} {payload}")


def cmd_map(transfers: list[Transfer], gap_s: float) -> None:
    """Summarise each burst: opcode histogram and distinct payload shapes.

    One burst is one user action (knob, footswitch, editor edit), so this is
    the table to read when mapping opcodes to actions.
    """
    start = transfers[0].ts_us
    groups = bursts(transfers, gap_s)
    print(f"{len(groups)} bursts, gap >= {gap_s} s")
    for number, burst in enumerate(groups, start=1):
        first = burst[0].ts_us
        duration = (burst[-1].ts_us - first) / 1e6
        shapes: dict[int, dict[str, int]] = {}
        for transfer in burst:
            event = decode_event(transfer.payload)
            if not event:
                continue
            opcode = event[105]
            payload = event.get(106)
            inner = (
                payload.get(106)
                if isinstance(payload, dict) and 106 in payload
                else payload
            )
            label = json.dumps(inner, sort_keys=True, default=str)
            bucket = shapes.setdefault(opcode, {})
            bucket[label] = bucket.get(label, 0) + 1
        summary = ", ".join(
            f"{opcode}x{sum(counts.values())}"
            for opcode, counts in sorted(shapes.items())
        )
        print(
            f"\nburst {number:2}  t=+{(first - start) / 1e6:7.2f}s  "
            f"dur={duration:6.2f}s  frames={len(burst)}  {summary}"
        )
        for opcode, counts in sorted(shapes.items()):
            for label, count in list(counts.items())[:3]:
                print(f"   op={opcode:<3} x{count:<3} {label}")
            if len(counts) > 3:
                print(f"   op={opcode:<3} ... {len(counts) - 3} more shapes")


def cmd_export(transfers: list[Transfer], out: Path) -> None:
    frames = [t.payload for t in transfers if is_notification(t.payload)]
    data = bytearray()
    for frame in frames:
        data += struct.pack("<H", len(frame)) + frame
    out.write_bytes(data)
    print(f"wrote {len(frames)} notifications ({len(data)} B) to {out}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    summary = sub.add_parser("summary")
    summary.add_argument("capture", type=Path)

    mapping = sub.add_parser("map")
    mapping.add_argument("capture", type=Path)
    mapping.add_argument("--gap", type=float, default=4.0)

    events = sub.add_parser("events")
    events.add_argument("capture", type=Path)
    events.add_argument("--gap", type=float, default=4.0)

    export = sub.add_parser("export")
    export.add_argument("capture", type=Path)
    export.add_argument("out", type=Path)

    args = parser.parse_args(argv)
    transfers = read_transfers(args.capture)
    if not transfers:
        print("no bulk transfers with data", file=sys.stderr)
        return 1

    if args.command == "summary":
        cmd_summary(transfers)
    elif args.command == "map":
        cmd_map(transfers, args.gap)
    elif args.command == "events":
        cmd_events(transfers, args.gap)
    else:
        cmd_export(transfers, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
