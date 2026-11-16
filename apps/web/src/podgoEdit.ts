// Read-only adapter for POD Go Edit's own preset files.
//
// `.pgp` is a single-preset JSON export (`schema: "L6Preset"`). `.pgb` is the
// `AF6L` container used by "Backup": a binary header, a series of zlib members
// and an `IDGP` directory at the end. The setlist members are JSON documents
// (`schema: "L6Setlist"`, 128 entries each); an empty slot is `{}`.
//
// The adapter is deliberately read-only. POD Go Edit stores parameters by
// name in real units, whereas the pedal exchanges an `l6-helix` MessagePack
// body. Converting between the two would require an encoder that this project
// does not have evidence for, so an imported file is rendered through the
// same `PresetStructure` contract as a device read and writes stay disabled.
//
// Files are parsed in this tab, in memory. Nothing is uploaded, written back
// to disk or persisted.

import { MODELS } from './catalog';
import type {
  CatalogModel,
  ChainEntry,
  ChainParamValue,
  ControllerAssignment,
  FootswitchAssignment,
  PresetStructure,
} from './types';

/** One preset read from a `.pgp` or a `.pgb` setlist. */
export interface EditPreset {
  name: string;
  tone: Record<string, unknown>;
  device: number | null;
  deviceVersion: number | null;
  buildSha: string | null;
  /** Setlist index inside a `.pgb`; `null` for a standalone `.pgp`. */
  setlist: number | null;
  /** Slot index inside the setlist; `null` for a standalone `.pgp`. */
  slot: number | null;
  /**
   * The whole `L6Preset` document, when the preset came from a `.pgp`.
   *
   * Kept so an export preserves every field the reader does not understand.
   * A `.pgb` entry only stores the `data` body, so it is `null` there and
   * export rebuilds the document from the observed `.pgp` shape.
   */
  document: Record<string, unknown> | null;
}

export interface EditSetlist {
  name: string;
  /** 128 entries; `null` marks an empty slot (`{}` in the file). */
  presets: (EditPreset | null)[];
}

export interface EditBackup {
  kind: 'pgb';
  setlists: EditSetlist[];
  globals: Record<string, unknown> | null;
  irCount: number;
  device: number | null;
  deviceVersion: number | null;
}

export interface EditSingle {
  kind: 'pgp';
  preset: EditPreset;
}

export type EditFile = EditBackup | EditSingle;

const MAGIC = 'AF6L';
const DIRECTORY_MAGIC = 'IDGP';
/** The pedal and POD Go Edit both expose 128 slots per setlist. */
export const SLOT_COUNT = 128;
const BLOCK_COUNT = 10;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) {
      return out;
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

interface DirEntry {
  /** Four-character tag, already un-reversed (`SL00`, `GLOB`, …). */
  tag: string;
  offset: number;
  size: number;
  /** `0` = stored, `1` = zlib. */
  codec: number;
  original: number;
}

function readDirectory(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): DirEntry[] | null {
  if (offset < 0 || offset + 8 > bytes.length) {
    return null;
  }
  if (ascii(bytes, offset, 4) !== DIRECTORY_MAGIC) {
    return null;
  }
  const headerLength = view.getUint32(offset + 4, true);
  let pos = offset + 8 + headerLength;
  const entries: DirEntry[] = [];
  while (pos + 36 <= bytes.length) {
    const nameLength = view.getUint32(pos, true);
    const tag = ascii(bytes, pos + 4, 4);
    if (!/^[A-Z0-9]{4}$/.test(tag)) {
      break;
    }
    const dataOffset = Number(view.getBigUint64(pos + 8, true));
    const size = Number(view.getBigUint64(pos + 16, true));
    const codec = view.getUint32(pos + 24, true);
    const original = Number(view.getBigUint64(pos + 28, true));
    if (
      dataOffset + size > bytes.length ||
      (codec !== 0 && codec !== 1) ||
      nameLength > bytes.length
    ) {
      return null;
    }
    entries.push({
      tag: tag.split('').reverse().join(''),
      offset: dataOffset,
      size,
      codec,
      original,
    });
    pos += 36 + nameLength;
  }
  return entries.length > 0 ? entries : null;
}

async function inflate(slice: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser cannot read .pgb files (DecompressionStream is missing). Use Chrome or Edge.',
    );
  }
  const body = new Blob([new Uint8Array(slice)]).stream();
  const stream = body.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Fallback for a `.pgb` whose directory is missing or damaged.
 *
 * zlib members are consecutive. Find every plausible header, then try to end
 * each stream at the next plausible header (or at EOF) and keep the first
 * slice that inflates. The primary path is the directory, which gives exact
 * bounds; this only keeps old or unusual backups readable.
 */
async function scanStreams(bytes: Uint8Array): Promise<Uint8Array[]> {
  const starts: number[] = [];
  for (let index = 0; index + 2 < bytes.length; index += 1) {
    if (bytes[index] !== 0x78) {
      continue;
    }
    const header = (bytes[index] << 8) | bytes[index + 1];
    if (header % 31 !== 0) {
      continue;
    }
    starts.push(index);
  }

  const out: Uint8Array[] = [];
  let index = 0;
  while (index < starts.length) {
    const start = starts[index];
    let decoded: Uint8Array | null = null;
    let next = index + 1;
    for (let candidate = index + 1; candidate <= starts.length; candidate += 1) {
      const end = candidate < starts.length ? starts[candidate] : bytes.length;
      try {
        decoded = await inflate(bytes.subarray(start, end));
        next = candidate;
        break;
      } catch {
        // The slice ended inside the stream, or contains trailing bytes.
      }
    }
    if (decoded) {
      out.push(decoded);
    }
    index = next;
  }
  return out;
}

async function parsePgb(bytes: Uint8Array): Promise<EditBackup> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directoryOffset = Number(view.getBigUint64(8, true));
  const entries = readDirectory(view, bytes, directoryOffset);

  const members: Uint8Array[] = [];
  if (entries) {
    try {
      for (const entry of entries) {
        const raw = bytes.subarray(entry.offset, entry.offset + entry.size);
        members.push(entry.codec === 1 ? await inflate(raw) : raw);
      }
    } catch {
      members.length = 0;
    }
  }
  if (members.length === 0) {
    members.push(...(await scanStreams(bytes)));
  }
  if (members.length === 0) {
    throw new Error(
      'No readable member in this .pgb (expected zlib or stored data).',
    );
  }

  const decoder = new TextDecoder();
  const setlists: EditSetlist[] = [];
  let globals: Record<string, unknown> | null = null;
  let irCount = 0;
  let device: number | null = null;
  let deviceVersion: number | null = null;

  for (const member of members) {
    if (
      member.length >= 4 &&
      member[0] === 0x52 &&
      member[1] === 0x49 &&
      member[2] === 0x46 &&
      member[3] === 0x46
    ) {
      irCount += 1;
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(decoder.decode(member));
    } catch {
      continue;
    }
    const doc = asObject(document);
    if (!doc) {
      continue;
    }
    const schema = asString(doc.schema);
    if (schema === 'L6Setlist') {
      const data = asObject(doc.data);
      const meta = asObject(data?.meta);
      const rawPresets = data?.presets;
      const presets: (EditPreset | null)[] = [];
      if (Array.isArray(rawPresets)) {
        rawPresets.forEach((rawPreset, slot) => {
          const value = asObject(rawPreset);
          if (!value || Object.keys(value).length === 0) {
            presets.push(null);
            return;
          }
          // A setlist entry is the preset body; accept a wrapped export too.
          const body = asObject(value.data) ?? value;
          const tone = asObject(body.tone);
          if (!tone) {
            presets.push(null);
            return;
          }
          const presetMeta = asObject(body.meta);
          if (device === null) {
            device = asNumber(body.device);
          }
          if (deviceVersion === null) {
            deviceVersion = asNumber(body.device_version);
          }
          presets.push({
            name: asString(presetMeta?.name) ?? '',
            tone,
            device: asNumber(body.device),
            deviceVersion: asNumber(body.device_version),
            buildSha: asString(presetMeta?.build_sha),
            setlist: setlists.length,
            slot,
            document: null,
          });
        });
      }
      setlists.push({
        name: asString(meta?.name) ?? `Setlist ${setlists.length}`,
        presets,
      });
    } else if (schema === null && globals === null && 'System' in doc) {
      globals = doc;
    }
    // `L6UMDArchive` only describes models; it carries no preset data.
  }

  if (setlists.length === 0) {
    throw new Error('This .pgb contains no L6Setlist document.');
  }

  return {
    kind: 'pgb',
    setlists,
    globals,
    irCount,
    device,
    deviceVersion,
  };
}

function parsePgp(bytes: Uint8Array): EditSingle {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  while (
    start < bytes.length &&
    (bytes[start] === 0x20 ||
      bytes[start] === 0x09 ||
      bytes[start] === 0x0a ||
      bytes[start] === 0x0d)
  ) {
    start += 1;
  }
  if (bytes[start] !== 0x7b) {
    throw new Error(
      'Unrecognised file: expected an AF6L .pgb backup or a JSON .pgp preset.',
    );
  }
  const document: unknown = JSON.parse(
    new TextDecoder().decode(bytes.subarray(start)),
  );
  const doc = asObject(document);
  const data = asObject(doc?.data);
  const tone = asObject(data?.tone);
  if (!data || !tone) {
    throw new Error('This .pgp has no data.tone object.');
  }
  const meta = asObject(data.meta);
  return {
    kind: 'pgp',
    preset: {
      name: asString(meta?.name) ?? '',
      tone,
      device: asNumber(data.device),
      deviceVersion: asNumber(data.device_version),
      buildSha: asString(meta?.build_sha),
      setlist: null,
      slot: null,
      document: doc,
    },
  };
}

/**
 * Parse a `.pgp` or `.pgb` file from its bytes.
 *
 * Throws a user-facing message when the file is neither format, when the JSON
 * is malformed, or when a `.pgb` has no setlist. The caller must not persist
 * the bytes: the file can contain personal preset names.
 */
export async function parsePodgoEditFile(
  bytes: Uint8Array,
): Promise<EditFile> {
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === MAGIC) {
    return parsePgb(bytes);
  }
  return parsePgp(bytes);
}

const MODEL_BY_NAME = new Map<
  string,
  { id: number; model: CatalogModel }
>();
for (const [id, model] of Object.entries(MODELS)) {
  MODEL_BY_NAME.set(model.name, { id: Number(id), model });
}

/** Decode POD Go Edit's packed version (`0x02500000` → `2.50`). */
export function decodeFirmware(version: number | null): string {
  if (version === null) {
    return '';
  }
  const major = (version >>> 24) & 0xff;
  const minor = (version >>> 16) & 0xff;
  const digits = `${(minor >>> 4) & 0x0f}${minor & 0x0f}`;
  return `${major}.${digits}`;
}

/** Human-readable product label for `data.device`. */
export function productLabel(device: number | null): string {
  if (device === null) {
    return 'POD Go Edit export';
  }
  return device === 0x210008
    ? 'POD Go (0x210008)'
    : `device 0x${device.toString(16)}`;
}

/**
 * Convert a POD Go Edit tone into the view model the editor renders.
 *
 * Parameter values are already in the units the catalog declares, so they are
 * copied as-is; the catalog supplies labels, ranges and 0–10 knob scaling.
 * The result is display-only: it has no `l6-helix` body and no setlist body.
 */
export function toneToStructure(preset: EditPreset): PresetStructure {
  const tone = preset.tone;
  const dsp0 = asObject(tone.dsp0) ?? {};
  const global = asObject(tone.global) ?? {};

  const chain: ChainEntry[] = [];
  const input = asObject(dsp0.input) ?? {};
  chain.push({
    slot: 0,
    kind: 'input',
    params: [
      input.noiseGate === true,
      asNumber(input.threshold),
      asNumber(input.decay),
    ],
  });

  for (let index = 0; index < BLOCK_COUNT; index += 1) {
    const slot = index + 1;
    const block = asObject(dsp0[`block${index}`]);
    if (!block || Object.keys(block).length === 0) {
      chain.push({ slot, kind: 'empty' });
      continue;
    }
    const modelName = asString(block['@model']);
    if (!modelName) {
      // The vendor JSON keeps `{"@position": n}` for an unused slot.
      chain.push({ slot, kind: 'empty' });
      continue;
    }
    const known = MODEL_BY_NAME.get(modelName);
    if (!known) {
      chain.push({
        slot,
        kind: 'unknown',
        class: asNumber(block['@type']) ?? 0,
      });
      continue;
    }
    const params: ChainParamValue[] = known.model.params.map((param) => {
      const value = block[param.n];
      if (typeof value === 'boolean') {
        return value;
      }
      return asNumber(value);
    });
    const enabled = block['@enabled'] !== false;
    if (known.model.category === 'Looper') {
      chain.push({
        slot,
        kind: 'looper',
        modelId: known.id,
        enabled,
        params,
      });
    } else {
      chain.push({
        slot,
        kind: 'block',
        modelId: known.id,
        category: null,
        enabled,
        noSnapshotBypass: block['@no_snapshot_bypass'] === true,
        params,
      });
    }
  }

  const output = asObject(dsp0.output) ?? {};
  chain.push({
    slot: chain.length,
    kind: 'output',
    params: [asNumber(output.pan), asNumber(output.gain)],
  });

  const footswitches: FootswitchAssignment[] = [];
  const controllers: ControllerAssignment[] = [];
  const footswitchRoot = asObject(asObject(tone.footswitch)?.dsp0);
  const controllerRoot = asObject(asObject(tone.controller)?.dsp0);

  for (let index = 0; index < BLOCK_COUNT; index += 1) {
    const block = asObject(dsp0[`block${index}`]);
    if (!block) {
      continue;
    }
    const fsBlock = asObject(footswitchRoot?.[`block${index}`]);
    const switchIndex = asNumber(fsBlock?.['@fs_index']);
    if (switchIndex !== null && switchIndex >= 1 && switchIndex <= 9) {
      const group = switchIndex - 1;
      footswitches.push({
        group,
        switch: group === 8 ? 'EXP Toe' : `FS${group + 1}`,
        block: index + 1,
        label: asString(fsBlock?.['@fs_label']) ?? '',
        enabled: fsBlock?.['@fs_enabled'] === true,
      });
    }

    const controllerBlock = asObject(controllerRoot?.[`block${index}`]);
    const modelName = asString(block['@model']);
    const known = modelName ? MODEL_BY_NAME.get(modelName) : undefined;
    if (!controllerBlock || !known) {
      continue;
    }
    for (const [paramName, rawSpec] of Object.entries(controllerBlock)) {
      const spec = asObject(rawSpec);
      const controller = asNumber(spec?.['@controller']);
      const paramIndex = known.model.params.findIndex(
        (param) => param.n === paramName,
      );
      if (controller === null || paramIndex < 0) {
        continue;
      }
      controllers.push({
        controller,
        paramIndex,
        min: asNumber(spec?.['@min']) ?? 0,
        max: asNumber(spec?.['@max']) ?? 1,
      });
    }
  }

  const snapshots = [0, 1, 2, 3].map((index) => {
    const snapshot = asObject(tone[`snapshot${index}`]) ?? {};
    return {
      name: asString(snapshot['@name']) ?? '',
      valid: snapshot['@valid'] === true,
      tempo: asNumber(snapshot['@tempo']),
    };
  });

  const inSetlist =
    preset.setlist === 0 || preset.setlist === 1 ? preset.setlist : null;

  return {
    preset: {
      name: preset.name,
      setlist: inSetlist,
      slot: preset.slot,
    },
    product: productLabel(preset.device),
    firmware: decodeFirmware(preset.deviceVersion),
    tempo: asNumber(global['@tempo']),
    currentSnapshot: asNumber(global['@current_snapshot']),
    snapshots,
    chain,
    footswitches,
    controllers,
  };
}

/** Number of non-empty slots in a setlist (for summaries). */
export function presetCount(setlist: EditSetlist): number {
  return setlist.presets.filter((preset) => preset !== null).length;
}

/** Build an editable preset from a full `L6Preset` document. */
export function presetFromDocument(
  doc: Record<string, unknown>,
  setlist: number | null = null,
  slot: number | null = null,
): EditPreset {
  const data = asObject(doc.data) ?? {};
  const meta = asObject(data.meta);
  const tone = asObject(data.tone) ?? {};
  return {
    name: asString(meta?.name) ?? '',
    tone,
    device: asNumber(data.device),
    deviceVersion: asNumber(data.device_version),
    buildSha: asString(meta?.build_sha),
    setlist,
    slot,
    document: doc,
  };
}

/**
 * Deep copy an editable preset.
 *
 * `tone` and `document.data.tone` must keep pointing at the same object: edits
 * mutate `tone`, while an export serializes `document`. Cloning the document
 * first and deriving the view from it preserves that link.
 */
export function clonePreset(preset: EditPreset): EditPreset {
  if (preset.document) {
    const document = JSON.parse(
      JSON.stringify(preset.document),
    ) as Record<string, unknown>;
    return presetFromDocument(document, preset.setlist, preset.slot);
  }
  return {
    ...preset,
    tone: JSON.parse(JSON.stringify(preset.tone)) as Record<string, unknown>,
  };
}

// --- Offline edit and `.pgp` export ---------------------------------------
//
// The adapter keeps the parsed document, so an edit only touches the field the
// user changed and the export preserves every other key, including fields this
// build does not understand. Values stay in POD Go Edit's units and names.

/** Rename an imported preset in place (document metadata included). */
export function setImportedName(preset: EditPreset, name: string): void {
  preset.name = name;
  const meta = asObject(asObject(preset.document?.data)?.meta);
  if (meta) {
    meta.name = name;
  }
  const toneMeta = asObject(preset.tone.meta);
  if (toneMeta) {
    toneMeta.name = name;
  }
}

/**
 * Set one block parameter in place.
 *
 * `block` is the 0-based `dsp0` block index (`block0`…`block9`); the parameter
 * key is the catalog name (`Drive`, `Mix`, …). A value the catalog declares is
 * copied verbatim, so a 0..1 knob keeps its raw fraction.
 */
export function setImportedParam(
  preset: EditPreset,
  block: number,
  param: string,
  value: number | boolean,
): void {
  const dsp0 = asObject(preset.tone.dsp0);
  const entry = asObject(dsp0?.[`block${block}`]);
  if (entry) {
    entry[param] = value;
  }
}

/**
 * Move one block to another position in an offline document.
 *
 * Reordering the chain also reorders every section that is keyed by block
 * index (`footswitch`, `controller` and each snapshot's bypass/controller
 * map), so an assignment stays with its block. `@position` is rewritten to
 * match the new index. Unknown keys on the block objects are preserved.
 */
export function moveImportedBlock(
  preset: EditPreset,
  from: number,
  to: number,
): void {
  if (from === to || from < 0 || to < 0 || from >= BLOCK_COUNT || to >= BLOCK_COUNT) {
    return;
  }
  const tone = preset.tone;
  const dsp0 = asObject(tone.dsp0);
  if (!dsp0) {
    return;
  }

  // `order[newIndex] = oldIndex`
  const order = Array.from({ length: BLOCK_COUNT }, (_, index) => index);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);

  const blocks = order.map(
    (old) => asObject(dsp0[`block${old}`]) ?? { '@position': old },
  );
  order.forEach((_, position) => {
    const block = blocks[position];
    block['@position'] = position;
    dsp0[`block${position}`] = block;
  });

  const reorder = (section: Record<string, unknown> | null): void => {
    if (!section) {
      return;
    }
    const values = order.map((old) => section[`block${old}`]);
    for (let position = 0; position < BLOCK_COUNT; position += 1) {
      const key = `block${position}`;
      if (values[position] === undefined) {
        delete section[key];
      } else {
        section[key] = values[position];
      }
    }
  };

  reorder(asObject(asObject(tone.footswitch)?.dsp0));
  reorder(asObject(asObject(tone.controller)?.dsp0));
  for (const [key, value] of Object.entries(tone)) {
    if (!/^snapshot\d+$/.test(key)) {
      continue;
    }
    const snapshot = asObject(value);
    reorder(asObject(asObject(snapshot?.blocks)?.dsp0));
    reorder(asObject(asObject(snapshot?.controllers)?.dsp0));
  }
}

/**
 * Load a catalog model into one `dsp0` block of an offline document.
 *
 * Only the block object is replaced: its `@position`, enable state and
 * bypass flag survive, and the model's vendor defaults (including `@mic` and
 * `@trails`) fill the parameters, so the value set matches what POD Go Edit
 * loads for a fresh model. Footswitch and controller sections are left
 * untouched; the vendor editor treats their unknown keys as harmless.
 *
 * This edits the JSON export only. Writing a model to the pedal needs the
 * chain-body path (`set_model`, op 40), which this build does not ship.
 */
export function setImportedModel(
  preset: EditPreset,
  block: number,
  model: CatalogModel,
): void {
  const dsp0 = asObject(preset.tone.dsp0);
  if (!dsp0) {
    return;
  }
  const key = `block${block}`;
  const existing = asObject(dsp0[key]) ?? {};
  const defaults = model.defaults ?? {};
  const next: Record<string, unknown> = {
    '@enabled': existing['@enabled'] !== false,
    '@model': model.name,
    '@no_snapshot_bypass': existing['@no_snapshot_bypass'] === true,
    '@position': asNumber(existing['@position']) ?? block,
    '@type':
      model.type ??
      (model.category === 'Amp' ? 1 : model.category === 'Cab' ? 2 : 0),
  };
  for (const param of model.params) {
    const value = defaults[param.n];
    if (typeof value === 'boolean' || typeof value === 'number') {
      next[param.n] = value;
    } else if (param.k === 'bool') {
      next[param.n] = false;
    } else {
      next[param.n] = param.min ?? 0;
    }
  }
  // Block attributes the vendor resources call defaults (`@mic`, `@trails`).
  for (const [name, value] of Object.entries(defaults)) {
    if (name.startsWith('@')) {
      next[name] = value;
    }
  }
  dsp0[key] = next;
}

/**
 * Build the `.pgp` document for a preset.
 *
 * A `.pgp` import keeps its original document. A `.pgb` entry only carries the
 * `data` body, so the envelope is rebuilt from the shape observed in official
 * exports: `schema: "L6Preset"`, `version: 6` and the three top-level `meta`
 * flags. That envelope is `ITM` (inferred from the observed file), not a
 * confirmed writer contract.
 */
export function buildPgpDocument(
  preset: EditPreset,
): Record<string, unknown> {
  if (preset.document) {
    return preset.document;
  }
  return {
    data: {
      device: preset.device,
      device_version: preset.deviceVersion,
      meta: {
        application: 'POD Go Edit',
        build_sha: preset.buildSha,
        name: preset.name,
      },
      tone: preset.tone,
    },
    meta: { original: 0, pbn: 0, premium: 0 },
    schema: 'L6Preset',
    version: 6,
  };
}

/** Serialize an imported preset as the JSON POD Go Edit reads (`.pgp`). */
export function serializePgp(preset: EditPreset): string {
  return `${JSON.stringify(buildPgpDocument(preset), null, 1)}\n`;
}

/** Filename-safe export name, keeping ASCII letters, digits, `-` and `_`. */
export function presetFileName(name: string): string {
  const clean = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${clean || 'podgo-preset'}.pgp`;
}
