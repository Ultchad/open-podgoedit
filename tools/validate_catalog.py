#!/usr/bin/env python3
"""Validate the model catalog against real preset bodies in a USB capture.

Reads a pcapng produced by USBPcap/Wireshark, extracts every complete
read-channel object (open requests plus the chunk responses that follow), and
checks each `l6-helix` preset body against the model catalog:

  * every chain `model_id` resolves to a catalog entry (name, param order);
  * the number of stored parameter values equals the catalog `param_order`
    length (a mismatch means the catalog disagrees with the firmware);
  * the on-wire category agrees with the catalog category where both exist.

Usage:

    python3 tools/validate_catalog.py reverse/exports/podgo-full-backup.pcapng

Evidence goes to stdout; the script never writes to the repository.
"""

from __future__ import annotations

import json
import struct
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ODYSSEY = HERE.parent / "reverse" / "openpodgo" / "src" / "openpodgo" / "data"

SHB_TYPE = 0x0A0D0D0A
EPB_TYPE = 0x00000006
BYTE_ORDER_MAGIC_LE = 0x1A2B3C4D
TRANSFER_BULK = 3

READ_SRC, READ_DST = 0x1001, 0x03EF


# --- pcapng ---------------------------------------------------------------


def iter_blocks(data: bytes):
    pos = 0
    while pos + 12 <= len(data):
        btype, blen = struct.unpack_from("<II", data, pos)
        if blen < 12 or blen % 4 or pos + blen > len(data):
            raise ValueError(f"corrupt pcapng block at offset {pos:#x}")
        yield btype, data[pos + 8 : pos + blen - 4]
        pos += blen


def read_transfers(path: Path):
    data = path.read_bytes()
    if len(data) < 12 or struct.unpack_from("<I", data)[0] != SHB_TYPE:
        raise ValueError(f"{path}: not a pcapng file")
    if struct.unpack_from("<I", data, 8)[0] != BYTE_ORDER_MAGIC_LE:
        raise ValueError(f"{path}: unsupported byte-order magic")

    out = []
    for btype, body in iter_blocks(data):
        if btype != EPB_TYPE:
            continue
        _, ts_hi, ts_lo, cap_len, _ = struct.unpack_from("<IIIII", body)
        record = body[20 : 20 + cap_len]
        if len(record) < 27:
            continue
        header_len = struct.unpack_from("<H", record)[0]
        endpoint = record[21]
        transfer_type = record[22]
        data_len = struct.unpack_from("<I", record, 23)[0]
        if transfer_type != TRANSFER_BULK or data_len == 0:
            continue
        payload = record[header_len : header_len + data_len]
        if len(payload) != data_len:
            continue
        out.append((endpoint & 0x80 != 0, payload))
    return out


def channels(payload: bytes):
    if len(payload) < 16:
        return None
    return (
        struct.unpack_from("<H", payload, 4)[0],
        struct.unpack_from("<H", payload, 6)[0],
    )


# --- minimal MessagePack decoder (stdlib only) ----------------------------


class Reader:
    def __init__(self, data: bytes, raw_strings: bool = False):
        self.data = data
        self.pos = 0
        self.raw_strings = raw_strings

    def take(self, n: int) -> bytes:
        chunk = self.data[self.pos : self.pos + n]
        if len(chunk) != n:
            raise ValueError("truncated")
        self.pos += n
        return chunk

    def u8(self) -> int:
        return self.take(1)[0]

    def string(self, data: bytes):
        return data if self.raw_strings else data.decode("utf-8", "replace")

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
            return self.string(self.take(marker & 0x1F))
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
            return self.string(self.take(size))
        if marker == 0xDC:
            return [self.value() for _ in range(struct.unpack(">H", self.take(2))[0])]
        if marker == 0xDD:
            return [self.value() for _ in range(struct.unpack(">I", self.take(4))[0])]
        if marker == 0xDE:
            return {
                self.value(): self.value()
                for _ in range(struct.unpack(">H", self.take(2))[0])
            }
        raise ValueError(f"unsupported marker {marker:#04x} at {self.pos - 1}")


# --- capture walk ---------------------------------------------------------


def decode_open_request(payload: bytes):
    """MessagePack body of a read-channel open request, or None.

    The body starts at byte 24 in the official-editor captures and in this
    project's own frames; older frames put it at 16, so both are tried.
    """
    for offset in (24, 16):
        try:
            value = Reader(payload[offset:]).value()
        except Exception:
            continue
        if isinstance(value, dict) and 100 in value:
            return value
    return None


def reassemble(transfers):
    """Yield (operation, params, blob) for every complete object read.

    Two response framings occur:

    * official editor (USBPcap): the first data frame after an open carries a
      u32 body length at offset 20 and its body at 24; continuation frames
      carry raw stream bytes from offset 16. Frames are 272 B on the wire.
    * this project's own WebUSB reads: data starts at 16, optionally behind a
      `01 00` + u32 length prefix, and a 16-byte empty response ends the
      object.

    The first data frame decides which shape applies.
    """
    pending = None
    buffer = bytearray()
    expected = None
    official = None

    for is_in, payload in transfers:
        chan = channels(payload)
        if chan is None:
            continue
        if not is_in and chan == (READ_SRC, READ_DST) and payload[11] == 0x04:
            request = decode_open_request(payload)
            if request is None:
                continue
            if pending is not None and buffer:
                yield pending.get(100), pending.get(101), bytes(buffer)
            pending = request
            buffer = bytearray()
            expected = None
            official = None
            continue
        if not is_in or chan != (READ_DST, READ_SRC) or payload[11] != 0x04:
            continue
        if pending is None:
            continue
        if len(payload) == 16:
            # Empty chunk response ends the object (own framing).
            if not official and buffer:
                yield pending.get(100), pending.get(101), bytes(buffer)
            pending = None
            continue
        if official is None:
            official = (
                len(payload) >= 28
                and payload[16:18] == b"\x00\x00"
                and struct.unpack_from("<I", payload, 20)[0] >= 20
            )
            if official:
                expected = struct.unpack_from("<I", payload, 20)[0]
                buffer.extend(payload[24:])
                if len(buffer) >= expected:
                    yield pending.get(100), pending.get(101), bytes(buffer[:expected])
                    pending = None
                continue
        if official:
            buffer.extend(payload[16:])
            if len(buffer) >= expected:
                yield pending.get(100), pending.get(101), bytes(buffer[:expected])
                pending = None
            continue
        # Own framing: the first frame may carry a `01 00` + u32 length prefix.
        data = payload[16:]
        if data[:2] == b"\x01\x00":
            data = data[4:]
            if len(data) >= 4:
                length = struct.unpack_from("<I", data)[0]
                data = data[8 : 8 + length]
        buffer.extend(data)
    if pending is not None and buffer:
        yield pending.get(100), pending.get(101), bytes(buffer)


def extract_blob(raw: bytes) -> bytes:
    """The `l6-helix` blob, unwrapping the object message when needed.

    Streamed objects arrive as `{102: txn, 103: status, 104: <blob>}`; a bare
    blob is returned unchanged.
    """
    if raw[:10] == b"\xa9l6-helix\x00":
        return raw
    try:
        value = Reader(raw, raw_strings=True).value()
    except Exception:
        return raw
    if isinstance(value, dict) and isinstance(value.get(104), (bytes, bytearray)):
        return bytes(value[104])
    return raw


def split_container(blob: bytes):
    try:
        r = Reader(blob, raw_strings=True)
        magic = r.value()
        table = r.value()
        if magic != b"l6-helix\x00" or not isinstance(table, (bytes, bytearray)):
            return None
        return Reader(blob[r.pos :]).value()
    except ValueError:
        return None


def main(argv):
    path = Path(argv[1])
    models_doc = json.loads((ODYSSEY / "models.json").read_text())
    by_id = {}
    for name, entry in models_doc["models"].items():
        if entry.get("wire_id") is not None:
            by_id[entry["wire_id"]] = (name, entry)

    objects = Counter()
    presets = 0
    blocks = 0
    unknown_ids = Counter()
    count_mismatch = Counter()
    category_mismatch = Counter()
    seen_slots = set()

    for op, params, blob in reassemble(read_transfers(path)):
        objects[op] += 1
        body = split_container(extract_blob(blob))
        if body is None:
            continue
        chain = (body.get(0) or {}).get(22)
        if not isinstance(chain, list):
            continue
        presets += 1
        if isinstance(params, dict):
            seen_slots.add((params.get(107), params.get(108)))
        for entry in chain:
            if not isinstance(entry, dict):
                continue
            if entry.get(19) not in (6, 7):
                continue
            payload = entry.get(20) or {}
            model = payload.get(24) if entry.get(19) == 6 else None
            model_id = model.get(25) if isinstance(model, dict) else payload.get(8)
            if not isinstance(model_id, int):
                continue
            blocks += 1
            values = (payload.get(11) or payload.get(7) or {}).get(4) or []
            found = by_id.get(model_id)
            if found is None:
                unknown_ids[model_id] += 1
                continue
            name, spec = found
            order = spec.get("param_order") or []
            if len(order) != len(values):
                count_mismatch[(model_id, name, len(order), len(values))] += 1
            wire_cat = payload.get(9)
            if spec.get("wire_category") is not None and wire_cat != spec["wire_category"]:
                category_mismatch[(model_id, name, spec["wire_category"], wire_cat)] += 1

    print(f"capture: {path}")
    print(f"objects by operation: {dict(sorted(objects.items(), key=lambda kv: (kv[0] is None, kv[0])))}")
    print(f"presets decoded: {presets}, slots: {len(seen_slots)}, blocks: {blocks}")
    print(f"catalog coverage: {blocks - sum(unknown_ids.values())}/{blocks} blocks matched")
    if unknown_ids:
        print("unknown model ids:", dict(unknown_ids))
    if count_mismatch:
        print("param-count mismatches (model, name, catalog, wire, occurrences):")
        for key, n in count_mismatch.most_common(20):
            print("  ", key, n)
    if category_mismatch:
        print("category mismatches:")
        for key, n in category_mismatch.most_common(10):
            print("  ", key, n)
    return 0 if not unknown_ids and not count_mismatch else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
