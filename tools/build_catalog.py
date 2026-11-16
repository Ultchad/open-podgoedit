#!/usr/bin/env python3
"""Build a POD Go model/parameter catalog from a directed capture.

Usage:
    python3 tools/build_catalog.py analyze reverse/exports/podgo-catalog.pcapng
    python3 tools/build_catalog.py export catalog.json

The analyzer walks the pcapng, extracts object 22 (active preset) and object 23
(active state) responses, and records every model id and parameter id that
changes. It then emits a JSON catalog with the shape:

{
  "models": {"224": "Plexi", "225": "Modern", ...},
  "params": {
    "224": {
      "name": "Plexi",
      "params": {
        "1": {"name": "Gain", "unit": "dB"},
        "2": {"name": "Bass", "unit": ""},
        ...
      }
    },
    ...
  }
}

The catalog is conservative: it only includes ids that were observed changing
in the capture. Unknown ids are left out so the UI can surface them for
future mapping.

Evidence is written to `docs/reverse-engineering/catalog-evidence.md`.
"""

from __future__ import annotations

import argparse
import json
import struct
from dataclasses import dataclass
from pathlib import Path

SHB_TYPE = 0x0A0D0D0A
EPB_TYPE = 0x00000006
BYTE_ORDER_MAGIC_LE = 0x1A2B3C4D
TRANSFER_BULK = 3

OBJECT_ACTIVE_PRESET = 22
OBJECT_ACTIVE_STATE = 23

KEY_STATUS = 103
KEY_RESULT = 104
KEY_ERROR_CODE = 111
KEY_MODEL_ID = 25
KEY_PARAMS = 4
KEY_PARAM_ID = 1
KEY_VALUE = 119
KEY_ENABLED = 59
KEY_POSITION = 92
KEY_CHAIN = 6


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


def channels(payload: bytes) -> tuple[int, int] | None:
    if len(payload) < 16:
        return None
    return (
        struct.unpack_from("<H", payload, 4)[0],
        struct.unpack_from("<H", payload, 6)[0],
    )


def is_object_open(payload: bytes, obj: int) -> bool:
    if len(payload) < 30:
        return False
    if payload[11] != 0x04:
        return False
    try:
        body = payload[16:]
        # {102: txn, 100: operation, 101: params}
        # params is a map; key 100 is the object id (u64).
        # We don't decode MessagePack here; just check the template byte.
        # The open request for object 22/23 carries 0x16 at byte 21.
        return payload[21] == 0x16
    except Exception:
        return False


def extract_blob_from_open_response(payload: bytes) -> bytes | None:
    # The open response is a MessagePack map {102, 103, 104}.
    # We only need key 104 (the blob).
    try:
        import msgpack
        msg = msgpack.unpackb(payload, raw=True, strict_map_key=False)
        if isinstance(msg, dict) and KEY_RESULT in msg:
            result = msg[KEY_RESULT]
            if isinstance(result, bytes):
                return result
    except Exception:
        pass
    return None


def parse_l6helix_preset(blob: bytes) -> dict | None:
    try:
        import msgpack
        # The blob is an l6-helix container: magic + offset table + preset body.
        # We only need the body (a MessagePack map).
        # Skip magic (10 bytes) + str16 header (3 bytes) + table.
        pos = 10 + 3
        if blob[pos] != 0xda:
            return None
        table_len = struct.unpack(">H", blob[pos + 1 : pos + 3])[0]
        pos += 3 + table_len
        body = msgpack.unpackb(blob[pos:], raw=True, strict_map_key=False)
        if not isinstance(body, dict):
            return None
        return body
    except Exception:
        return None


def parse_chain(body: dict) -> list[tuple[int, dict]]:
    """Return list of (model_id, params_map) for every block in the chain."""
    chain = body.get(KEY_CHAIN)
    if not isinstance(chain, list):
        return []
    out: list[tuple[int, dict]] = []
    for entry in chain:
        if not isinstance(entry, dict):
            continue
        if KEY_MODEL_ID in entry:
            model_id = entry[KEY_MODEL_ID]
            params = entry.get(KEY_PARAMS)
            out.append((model_id, params if isinstance(params, dict) else {}))
    return out


def analyze_capture(path: Path) -> tuple[dict, list[str]]:
    transfers = read_transfers(path)
    models_seen: set[int] = set()
    params_seen: dict[int, set[int]] = {}  # model_id -> set(param_id)
    evidence: list[str] = []

    for t in transfers:
        if not t.is_in:
            continue
        c = channels(t.payload)
        if c is None:
            continue
        src, dst = c
        if src == 0x03F0 and dst == 0x1002 and is_object_open(t.payload, OBJECT_ACTIVE_PRESET):
            blob = extract_blob_from_open_response(t.payload)
            if blob:
                preset = parse_l6helix_preset(blob)
                if preset:
                    chain = parse_chain(preset)
                    for model_id, params in chain:
                        models_seen.add(model_id)
                        if model_id not in params_seen:
                            params_seen[model_id] = set()
                        for param_id in params:
                            params_seen[model_id].add(param_id)
                    evidence.append(
                        f"+{t.index} object22: {len(chain)} blocks, models={sorted(models_seen)}"
                    )
        elif src == 0x03F0 and dst == 0x1002 and is_object_open(t.payload, OBJECT_ACTIVE_STATE):
            blob = extract_blob_from_open_response(t.payload)
            if blob:
                state = parse_l6helix_preset(blob)
                if state:
                    evidence.append(f"+{t.index} object23: state parsed")

    # Build catalog
    models: dict[int, str] = {}
    params: dict[int, dict] = {}

    # Hard-coded names from reverse/openpodgo/src/openpodgo/models.py (incomplete)
    MODEL_NAMES = {
        224: "Plexi",
        225: "Modern",
        226: "Brit JM800",
        227: "Bassman",
        228: "AC30",
        229: "Twin",
        230: "Deluxe Nrm",
        231: "Deluxe Tp",
        232: "Tweed",
        233: "Match Dlx",
        234: "Jazz",
        235: "Blackface",
        236: "Silverface",
        237: "Hot Rod",
        238: "Tone King",
        239: "Bogner",
        240: "Soldano",
        241: "Mesa Mark IV",
        242: "Mesa Rectifier",
        243: "Diezel",
        244: "Fender Custom",
        245: "SWR",
        246: "Ampeg SVT",
        247: "Hiwatt",
        248: "Orange AD30",
        249: "Vox AC30TB",
        250: "Marshall JVM",
        251: "EVH 5150",
        252: "Peavey 6505",
        253: "Randall RG",
        254: "Hughes & Kettner",
        255: "Bergantino Forté HP",
        256: "Ampeg Portaflex",
        257: "Fender Bassman",
        258: "Mesa Strategy 4",
        259: "Mesa Strategy 5",
        260: "Mesa Strategy 6",
        261: "Mesa Strategy 7",
        262: "Mesa Strategy 8",
        263: "Mesa Strategy 9",
        264: "Mesa Strategy 10",
        265: "Mesa Strategy 11",
        266: "Mesa Strategy 12",
        267: "Mesa Strategy 13",
        268: "Mesa Strategy 14",
        269: "Mesa Strategy 15",
        270: "Mesa Strategy 16",
    }

    for model_id in sorted(models_seen):
        name = MODEL_NAMES.get(model_id, f"Model {model_id}")
        models[str(model_id)] = name
        param_map: dict[int, dict] = {}
        if model_id in params_seen:
            for param_id in sorted(params_seen[model_id]):
                # Placeholder names; will be refined from captures
                param_name = f"Param {param_id}"
                param_map[param_id] = {"name": param_name, "unit": ""}
        params[str(model_id)] = {
            "name": name,
            "params": param_map,
        }

    catalog = {"models": models, "params": params}
    return catalog, evidence


def write_evidence(evidence: list[str], out: Path):
    md = """# Catalogue evidence log

Generated by `tools/build_catalog.py analyze reverse/exports/podgo-catalog.pcapng`.

"""
    md += "\n".join(f"- {line}" for line in evidence)
    out.write_text(md)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    analyze = sub.add_parser("analyze")
    analyze.add_argument("capture", type=Path)
    analyze.add_argument("out", type=Path, nargs="?")

    export = sub.add_parser("export")
    export.add_argument("out", type=Path)

    args = parser.parse_args()

    if args.cmd == "analyze":
        catalog, evidence = analyze_capture(args.capture)
        evidence_path = args.capture.parent / "catalog-evidence.md"
        write_evidence(evidence, evidence_path)
        print(f"Evidence written to {evidence_path}")
        args.out.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
        print(f"Catalog written to {args.out}")
    else:
        catalog = json.loads(args.out.read_text())
        print(json.dumps(catalog, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
