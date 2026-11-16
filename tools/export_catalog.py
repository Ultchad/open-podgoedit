#!/usr/bin/env python3
"""Export the model catalog to the compact JSON the web page ships.

The catalog data comes from the MIT-licensed `openpodgo` project
(`reverse/openpodgo/src/openpodgo/data/models.json` and `controls.json`), which
derives it from POD Go Edit resources plus a `.pgb` backup. It is factual
interoperability data (id → name → parameter range), not artwork or code; see
`docs/protocol/model-catalog.md`.

Usage:

    python3 tools/export_catalog.py

Writes `apps/web/src/catalog/catalog.json`. The file is committed because
`reverse/` is a local checkout, not a build input of the web app.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "reverse" / "openpodgo" / "src" / "openpodgo" / "data"
OUTPUT = ROOT / "apps" / "web" / "src" / "catalog" / "catalog.json"

#: POD Go Edit palette by UI category (`palette.py`, official `color` field).
CATEGORY_COLORS = {
    "Amp": "#DD1111",
    "Cab": "#DD1111",
    "Dist": "#f5901e",
    "Dyn": "#DDCC00",
    "EQ": "#DDCC00",
    "Mod": "#0094E9",
    "Delay": "#00CC00",
    "Reverb": "#FF5C00",
    "Pitch": "#AD46E2",
    "Filter": "#AD46E2",
    "Wah": "#A844DB",
    "Vol": "#38A696",
    "Send/Return": "#9C9C9C",
    "Looper": "#9C9C9C",
    "Other": "#9C9C9C",
}

#: Categories that are not chain blocks.
NON_BLOCK = {None, "None", "Input", "Output"}

PREFIX_CATEGORIES = (
    ("P34_", None),
    ("HD2_Amp", "Amp"),
    ("HD2_Preamp", "Amp"),
    ("HD2_Cab", "Cab"),
    ("HD2_Dist", "Dist"),
    ("HD2_DM", "Dist"),
    ("HD2_Compressor", "Dyn"),
    ("HD2_EQ", "EQ"),
    ("HD2_Delay", "Delay"),
    ("HD2_DL", "Delay"),
    ("HD2_Reverb", "Reverb"),
    ("VIC_", "Reverb"),
    ("HD2_Chorus", "Mod"),
    ("HD2_Flanger", "Mod"),
    ("HD2_Phaser", "Mod"),
    ("HD2_Rotary", "Mod"),
    ("HD2_Tremolo", "Mod"),
    ("HD2_Ring", "Mod"),
    ("HD2_MM", "Mod"),
    ("HD2_Filter", "Filter"),
    ("HD2_FM", "Filter"),
    ("HD2_Pitch", "Pitch"),
    ("HD2_Synth", "Pitch"),
    ("HD2_Wah", "Wah"),
    ("HD2_Vol", "Vol"),
    ("HD2_FXLoop", "Send/Return"),
)

STRIP_WORDS = (
    "Compressor", "Preamp", "Delay", "Reverb", "Chorus", "Flanger",
    "Phaser", "Rotary", "Tremolo", "Filter", "Pitch", "Synth", "Dist",
    "Amp", "Cab", "Wah", "Vol", "EQ",
)
CAMEL = re.compile(
    r"(?<=[A-Z])(?=[A-Z][a-z])"
    r"|(?<=[a-z])(?=[A-Z])"
    r"|(?<=[0-9])(?=[A-Z])"
    r"|(?<=(?<![0-9])[a-z])(?=[0-9])"
)


def short_name(model_name: str) -> str:
    """Human-readable short name (port of `openpodgo.ui.names.short_name`)."""
    name = re.sub(r"^(HD2|VIC|P34)_", "", model_name)
    for word in STRIP_WORDS:
        if name.startswith(word) and len(name) > len(word):
            name = name[len(word):].lstrip("_")
            break
    for suffix in ("Stereo", "Mono"):
        if name.endswith(suffix) and len(name) > len(suffix):
            name = name[: -len(suffix)]
    return CAMEL.sub(" ", name).replace("_", " ").strip()


def display_category(name: str, entry: dict) -> str | None:
    category = entry.get("category")
    if category is not None:
        return None if category in NON_BLOCK else category
    for prefix, cat in PREFIX_CATEGORIES:
        if name.startswith(prefix):
            return cat
    return "Other"


def resolve_control(controls: dict, display_type: str | None) -> dict:
    """Follow `alias` links until a concrete control or a dead end."""
    if not display_type:
        return {}
    entry = controls.get(display_type)
    seen = set()
    while isinstance(entry, dict) and "alias" in entry and entry["alias"] not in seen:
        seen.add(entry["alias"])
        entry = controls.get(entry["alias"])
    return entry or {}


def labels_from(control: dict) -> list[str] | None:
    fmt = control.get("format")
    return list(fmt) if isinstance(fmt, list) else None


def main() -> None:
    models_doc = json.loads((DATA / "models.json").read_text(encoding="utf-8"))
    controls = json.loads((DATA / "controls.json").read_text(encoding="utf-8"))

    models: dict[str, dict] = {}
    params_total = 0
    labelled = 0

    for name, entry in models_doc["models"].items():
        wire_id = entry.get("wire_id")
        order = entry.get("param_order")
        if wire_id is None or not order:
            continue
        specs = entry.get("params") or {}
        params = []
        for param_name in order:
            spec = specs.get(param_name) or {}
            control = resolve_control(controls, spec.get("display_type"))
            labels = labels_from(control)
            vmin, vmax = spec.get("min"), spec.get("max")
            if spec.get("bool") or spec.get("value_type") == 2:
                kind = "bool"
            elif spec.get("value_type") == 0 or control.get("isDiscrete"):
                kind = "int"
            else:
                kind = "cont"
            item = {"n": param_name, "min": vmin, "max": vmax, "k": kind}
            if kind == "bool":
                item["min"], item["max"] = 0, 1
                if not labels:
                    labels = ["Off", "On"]
            if labels and vmin is not None and vmax is not None:
                # Only keep labels that map one-to-one onto the integer range.
                if len(labels) == int(round(vmax - vmin)) + 1:
                    item["labels"] = labels
                    labelled += 1
                elif kind == "bool" and len(labels) == 2:
                    item["labels"] = labels
                    labelled += 1
            params.append(item)
            params_total += 1
        models[str(wire_id)] = {
            "name": name,
            "display": entry.get("display_name") or short_name(name),
            "short": short_name(name),
            "category": display_category(name, entry),
            "sub": entry.get("subcategory"),
            # JSON `@type` the vendor editor writes for this model (0 effect,
            # 1 amp, 2 cab, 5 delay/fx loop, …), needed to load a model into a
            # block of an offline `.pgp`.
            "type": entry.get("type"),
            # Vendor defaults, including block attributes (`@mic`, `@trails`),
            # so a freshly loaded model starts with the same values the
            # official editor uses.
            "defaults": entry.get("defaults") or {},
            "params": params,
        }

    document = {
        "source": {
            "project": "openpodgo (MIT)",
            "files": ["models.json", "controls.json"],
            "backup": (models_doc.get("source") or {}).get("backup"),
            "generated_by": "tools/export_catalog.py",
        },
        "categories": CATEGORY_COLORS,
        "models": models,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(document, indent=None, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"{len(models)} models, {params_total} params ({labelled} labelled) -> {OUTPUT}")
    print(f"{OUTPUT.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
