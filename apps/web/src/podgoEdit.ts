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
  SnapshotParamValue,
  SnapshotState,
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
  /**
   * The parsed `L6Setlist` document, kept so an export only rewrites the
   * slots that changed. Absent when the member was read without a directory.
   */
  document?: Record<string, unknown> | null;
  /**
   * The stored bytes of this setlist member, as they appear in the file, so
   * an untouched setlist is copied verbatim instead of being re-serialized.
   */
  stored?: Uint8Array | null;
  /**
   * Tag of the container member this setlist was read from (`SL00`, …).
   * The export rewrites this exact member instead of guessing from its index.
   */
  memberTag?: string;
}

/**
 * One member of the `AF6L` container, as read from the file.
 *
 * `stored` is the exact byte range the directory points at (still
 * compressed when `codec` is 1). Unchanged members are written back verbatim,
 * which preserves impulse responses, the model archive and any member this
 * build does not understand.
 */
export interface PgbMember {
  /** Four-character tag, already un-reversed (`SL00`, `GLOB`, …). */
  tag: string;
  /** `0` = stored, `1` = zlib. */
  codec: number;
  /** Uncompressed size, as recorded in the directory. */
  original: number;
  /** Stored bytes: the compressed stream when `codec` is 1. */
  stored: Uint8Array;
  /** The `u32` in front of the tag (0 in observed files). */
  reserved: number;
}

/** Everything needed to rebuild an `AF6L` backup byte-for-byte. */
export interface PgbContainer {
  /** The original 48-byte header; offsets are patched on export. */
  header: Uint8Array;
  /** The 24-byte directory header body (between `IDGP` and the records). */
  directoryHeader: Uint8Array;
  /** The 4-byte zero trailer after the last record. */
  trailer: Uint8Array;
  members: PgbMember[];
}

export interface EditBackup {
  kind: 'pgb';
  setlists: EditSetlist[];
  globals: Record<string, unknown> | null;
  irCount: number;
  device: number | null;
  deviceVersion: number | null;
  /** Container structure for a lossless `.pgb` export; `null` if unreadable. */
  container: PgbContainer | null;
  /**
   * Where the preset being edited sat in this backup, when it was opened from
   * a `.pgb` entry. `Export .pgb` replaces that slot and keeps the rest.
   */
  source?: { setlist: number; slot: number };
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
  /** The `u32` in front of the tag (0 in observed files). */
  reserved: number;
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
      reserved: nameLength,
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
  let container: PgbContainer | null = null;
  if (entries) {
    try {
      for (const entry of entries) {
        const raw = bytes.subarray(entry.offset, entry.offset + entry.size);
        members.push(entry.codec === 1 ? await inflate(raw) : raw);
      }
    } catch {
      members.length = 0;
    }
    if (members.length === entries.length) {
      const headerLength = view.getUint32(directoryOffset + 4, true);
      const recordsStart = directoryOffset + 8 + headerLength;
      // The trailer is whatever follows the last record; observed files use
      // four zero bytes, but keep the exact bytes so the export matches.
      const lastRecord = recordsStart + entries.length * 36;
      container = {
        header: bytes.slice(0, 48),
        directoryHeader: bytes.slice(
          directoryOffset + 8,
          directoryOffset + 8 + headerLength,
        ),
        trailer: bytes.slice(lastRecord),
        members: entries.map((entry) => ({
          tag: entry.tag,
          codec: entry.codec,
          original: entry.original,
          stored: bytes.slice(entry.offset, entry.offset + entry.size),
          reserved: entry.reserved,
        })),
      };
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

  for (const [memberIndex, member] of members.entries()) {
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
        document: doc,
        stored: container ? container.members[memberIndex].stored : null,
        memberTag: container ? container.members[memberIndex].tag : undefined,
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
    container,
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
const MODEL_BY_ID = new Map<number, CatalogModel>();
for (const [id, model] of Object.entries(MODELS)) {
  MODEL_BY_NAME.set(model.name, { id: Number(id), model });
  MODEL_BY_ID.set(Number(id), model);
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
        block: index,
        controller,
        paramIndex,
        min: asNumber(spec?.['@min']) ?? 0,
        max: asNumber(spec?.['@max']) ?? 1,
      });
    }
  }

  const snapshots: SnapshotState[] = [0, 1, 2, 3].map((index) => {
    const snapshot = asObject(tone[`snapshot${index}`]) ?? {};
    const blocksObject = asObject(asObject(snapshot.blocks)?.dsp0);
    const blocks = Array.from({ length: BLOCK_COUNT }, (_, blockIndex) => {
      const value = blocksObject?.[`block${blockIndex}`];
      return typeof value === 'boolean' ? value : null;
    });

    const values: SnapshotParamValue[] = [];
    const snapshotControllers = asObject(asObject(snapshot.controllers)?.dsp0);
    for (let blockIndex = 0; blockIndex < BLOCK_COUNT; blockIndex += 1) {
      const controllerBlock = asObject(
        snapshotControllers?.[`block${blockIndex}`],
      );
      if (!controllerBlock) {
        continue;
      }
      const block = asObject(dsp0[`block${blockIndex}`]);
      const modelName = asString(block?.['@model']);
      const known = modelName ? MODEL_BY_NAME.get(modelName) : undefined;
      if (!known) {
        continue;
      }
      for (const [paramName, rawSpec] of Object.entries(controllerBlock)) {
        const paramIndex = known.model.params.findIndex(
          (param) => param.n === paramName,
        );
        const param = known.model.params[paramIndex];
        const spec = asObject(rawSpec);
        if (paramIndex < 0 || !spec) {
          continue;
        }
        const rawValue = spec['@value'];
        let value: ChainParamValue = null;
        if (typeof rawValue === 'boolean') {
          value = rawValue;
        } else {
          const numeric = asNumber(rawValue);
          if (numeric !== null) {
            value = param.k === 'bool' ? numeric !== 0 : numeric;
          }
        }
        if (value === null) {
          continue;
        }
        values.push({
          block: blockIndex,
          paramIndex,
          value,
          fsEnabled: spec['@fs_enabled'] === true,
        });
      }
    }

    return {
      name: asString(snapshot['@name']) ?? '',
      valid: snapshot['@valid'] === true,
      tempo: asNumber(snapshot['@tempo']),
      ledColor: asNumber(snapshot['@ledcolor']) ?? 0,
      blocks,
      controllers: values,
    };
  });

  // The base block object is the preset-level state; the selected snapshot's
  // entries override it for the values the inspector shows. A snapshot that
  // has no entry keeps the base value, which is how the vendor editor treats
  // parameters that are not assigned to the Snapshots controller.
  const currentSnapshot = asNumber(global['@current_snapshot']);
  const activeSnapshot =
    snapshots[
      currentSnapshot !== null && currentSnapshot >= 0 && currentSnapshot < 4
        ? currentSnapshot
        : 0
    ];
  for (const entry of chain) {
    if (entry.kind !== 'block' && entry.kind !== 'looper') {
      continue;
    }
    const blockIndex = entry.slot - 1;
    const enabled = activeSnapshot.blocks[blockIndex];
    if (typeof enabled === 'boolean') {
      entry.enabled = enabled;
    }
    for (const stored of activeSnapshot.controllers) {
      if (
        stored.block !== blockIndex ||
        stored.paramIndex < 0 ||
        stored.paramIndex >= entry.params.length
      ) {
        continue;
      }
      entry.params[stored.paramIndex] = stored.value;
    }
  }

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
    currentSnapshot,
    snapshots,
    chain,
    footswitches,
    controllers,
  };
}

/**
 * Rebuild an editable JSON document from a preset read over the pedal.
 *
 * A device read is an `l6-helix` MessagePack body, not a `.pgp` document, so
 * this is a lossy rebuild: it materializes the fields the editor displays
 * (models, parameter values, snapshots, switches and controllers). Unknown
 * `l6-helix` fields cannot be recovered and are not invented. The result is an
 * offline draft for model swaps and `.pgp` export; it is deliberately **not**
 * a path to writing a preset body back to the pedal.
 *
 * Values are copied into the `L6Preset` v6 shape the rest of the offline
 * editor already understands, so `toneToStructure` renders the same chain.
 */
export function structureToEditPreset(
  structure: PresetStructure,
  setlist: number | null = null,
  slot: number | null = null,
): EditPreset {
  const bySlot = new Map(structure.chain.map((entry) => [entry.slot, entry]));
  const valueAt = (
    params: ChainParamValue[] | undefined,
    index: number,
    fallback: number,
  ): number => {
    const value = params?.[index];
    return typeof value === 'number' ? value : fallback;
  };

  const dsp0: Record<string, unknown> = {};
  const input = bySlot.get(0);
  dsp0.input = {
    '@input': 3,
    '@model': 'P34_AppDSPFlowInput',
    noiseGate: input?.kind === 'input' ? input.params[0] === true : true,
    threshold: valueAt(
      input?.kind === 'input' ? input.params : undefined,
      1,
      -48,
    ),
    decay: valueAt(
      input?.kind === 'input' ? input.params : undefined,
      2,
      0.5,
    ),
  };

  for (let index = 0; index < BLOCK_COUNT; index += 1) {
    const entry = bySlot.get(index + 1);
    if (!entry || (entry.kind !== 'block' && entry.kind !== 'looper')) {
      dsp0[`block${index}`] = { '@position': index };
      continue;
    }
    const model =
      entry.modelId !== null ? MODEL_BY_ID.get(entry.modelId) : undefined;
    const block: Record<string, unknown> = {
      '@enabled': entry.enabled,
      '@model': model?.name ?? `unknown_${entry.modelId}`,
      '@no_snapshot_bypass':
        entry.kind === 'block' ? entry.noSnapshotBypass : false,
      '@position': index,
      '@type':
        model?.type ??
        (model?.category === 'Amp' ? 1 : model?.category === 'Cab' ? 2 : 0),
    };
    model?.params.forEach((param, paramIndex) => {
      const value = entry.params[paramIndex];
      if (value !== null && value !== undefined) {
        block[param.n] = value;
      }
    });
    dsp0[`block${index}`] = block;
  }

  const output = structure.chain.find((entry) => entry.kind === 'output');
  dsp0.output = {
    '@model': 'P34_AppDSPFlowOutput',
    '@output': 1,
    gain: valueAt(
      output?.kind === 'output' ? output.params : undefined,
      1,
      0,
    ),
    pan: valueAt(
      output?.kind === 'output' ? output.params : undefined,
      0,
      0.5,
    ),
  };

  const footswitch: Record<string, unknown> = {};
  for (const assignment of structure.footswitches ?? []) {
    footswitch[`block${assignment.block - 1}`] = {
      '@fs_enabled': assignment.enabled,
      '@fs_index': assignment.group + 1,
      '@fs_label': assignment.label,
    };
  }

  const controller: Record<string, unknown> = {};
  for (const assignment of structure.controllers ?? []) {
    const entry = bySlot.get(assignment.block + 1);
    const model =
      entry && (entry.kind === 'block' || entry.kind === 'looper') &&
      entry.modelId !== null
        ? MODEL_BY_ID.get(entry.modelId)
        : null;
    const param = model?.params[assignment.paramIndex];
    if (!param) {
      continue;
    }
    const block = (controller[`block${assignment.block}`] ??= {}) as Record<
      string,
      unknown
    >;
    block[param.n] = {
      // Documents name Snapshots `10`; a pedal read carries the wire `11`.
      '@controller': isSnapshotController(assignment.controller)
        ? SNAPSHOT_CONTROLLER
        : assignment.controller,
      '@min': assignment.min,
      '@max': assignment.max,
    };
  }

  const snapshots: Record<string, unknown> = {};
  (structure.snapshots ?? []).forEach((snapshot, index) => {
    const blocks: Record<string, boolean> = {};
    (snapshot.blocks ?? []).forEach((value, blockIndex) => {
      if (typeof value === 'boolean') {
        blocks[`block${blockIndex}`] = value;
      }
    });
    const values: Record<string, unknown> = {};
    for (const stored of snapshot.controllers ?? []) {
      const entry = bySlot.get(stored.block + 1);
      const model =
        entry && (entry.kind === 'block' || entry.kind === 'looper') &&
        entry.modelId !== null
          ? MODEL_BY_ID.get(entry.modelId)
          : null;
      const param = model?.params[stored.paramIndex];
      if (!param) {
        continue;
      }
      const block = (values[`block${stored.block}`] ??= {}) as Record<
        string,
        unknown
      >;
      block[param.n] = {
        '@value': stored.value,
        '@fs_enabled': stored.fsEnabled,
      };
    }
    snapshots[`snapshot${index}`] = {
      '@name': snapshot.name ?? '',
      '@valid': snapshot.valid === true,
      '@tempo': snapshot.tempo ?? structure.tempo ?? 120,
      '@ledcolor': snapshot.ledColor ?? 0,
      blocks: { dsp0: blocks },
      controllers: { dsp0: values },
    };
  });

  const name = structure.preset.name || 'POD Go preset';
  const document: Record<string, unknown> = {
    meta: { original: 0, pbn: 0, premium: 0 },
    schema: 'L6Preset',
    version: 6,
    data: {
      device: deviceNumber(structure.product),
      device_version: firmwareNumber(structure.firmware),
      meta: {
        application: 'Open POD Go Edit',
        build_sha: `device-read:${structure.product || 'POD Go'}:${
          structure.firmware || 'unknown'
        }`,
        name,
      },
      tone: {
        controller: { dsp0: controller },
        dsp0,
        footswitch: { dsp0: footswitch },
        global: {
          '@current_snapshot': structure.currentSnapshot ?? 0,
          '@model': '@global_params',
          '@pedalstate': 2,
          '@tempo': structure.tempo ?? 120,
        },
        meta: { name },
        ...snapshots,
      },
    },
  };
  return presetFromDocument(document, setlist, slot);
}

/** Extract the `0x…` product id from `productLabel`; default to a POD Go. */
function deviceNumber(product: string): number {
  const match = /0x([0-9a-f]+)/i.exec(product);
  return match ? Number.parseInt(match[1], 16) : 0x210008;
}

/** Encode `2.50` as POD Go Edit's packed `0x02500000` firmware number. */
function firmwareNumber(firmware: string): number {
  const match = /^(\d+)\.(\d{2})$/.exec(firmware.trim());
  if (!match) {
    return 0x02500000;
  }
  const major = Number.parseInt(match[1], 10) & 0xff;
  const minor = Number.parseInt(match[2], 16) & 0xff;
  return ((major << 24) | (minor << 16)) >>> 0;
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
 * `@controller` number used for the Snapshots controller in documents.
 *
 * `.hlx`/`.pgp` files use `10` for Snapshots. `podgo-snapshots.pcapng`
 * (2026-11-24) shows the pedal itself reporting **11** on the wire when a
 * parameter is assigned (op 37 `{74: 11}` and the op-34 notification), so a
 * preset read back from the pedal carries `11`; both numbers name the same
 * controller here (`isSnapshotController`).
 */
export const SNAPSHOT_CONTROLLER = 10;

/** On-wire controller number the pedal reports for Snapshots (op 37). */
export const SNAPSHOT_CONTROLLER_WIRE = 11;

/** True for either number that names the Snapshots controller. */
export function isSnapshotController(controller: number | null | undefined): boolean {
  return controller === SNAPSHOT_CONTROLLER || controller === SNAPSHOT_CONTROLLER_WIRE;
}

/** EXP 1 controller number in `.pgp` documents (evidenced by fixtures). */
export const EXP_CONTROLLER_1 = 1;

/** EXP 2 controller number in `.pgp` documents (evidenced by fixtures). */
export const EXP_CONTROLLER_2 = 2;

/**
 * Controller numbers for FS1–FS6 in `.pgp` documents.
 *
 * These follow the Line 6 convention (`3` = FS1 … `8` = FS6) and are **not**
 * hardware-validated: no capture shows the official editor assigning a
 * footswitch to a parameter. They are used for offline `.pgp` authoring only;
 * a pedal read never writes them.
 */
export const FOOTSWITCH_CONTROLLER_MIN = 3;
export const FOOTSWITCH_CONTROLLER_MAX = 8;

/**
 * Bypass-assignment switch groups in `.pgp` documents (`tone.footswitch`).
 *
 * `0`…`7` = FS1…FS8 and `8` = the expression-pedal toe switch (`@fs_index`
 * is this value + 1). Several blocks may share one group: the manual's "Merge"
 * option assigns multiple blocks to the same footswitch, and each block keeps
 * its own `tone.footswitch.dsp0.blockN` entry with the same `@fs_index`.
 */
export const FOOTSWITCH_GROUP_MIN = 0;
export const FOOTSWITCH_GROUP_MAX = 8;

/** Switch label used by the pedal and the manual (`FS1`…`FS8`, `EXP Toe`). */
export function footswitchSwitchLabel(group: number): string {
  return group === FOOTSWITCH_GROUP_MAX ? 'EXP Toe' : `FS${group + 1}`;
}

/** Human label for a stored controller number.
 *
 * Snapshots matches both the document (`10`) and wire (`11`) numbers.
 */
export function controllerLabel(controller: number): string {
  if (isSnapshotController(controller)) {
    return 'Snapshots';
  }
  if (controller === EXP_CONTROLLER_1) {
    return 'EXP 1';
  }
  if (controller === EXP_CONTROLLER_2) {
    return 'EXP 2';
  }
  if (
    controller >= FOOTSWITCH_CONTROLLER_MIN &&
    controller <= FOOTSWITCH_CONTROLLER_MAX
  ) {
    return `FS${controller - FOOTSWITCH_CONTROLLER_MIN + 1}`;
  }
  return `Controller ${controller}`;
}

function ensureObject(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = asObject(parent[key]);
  if (existing) {
    return existing;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function pruneEmpty(parent: Record<string, unknown>, key: string): void {
  const child = asObject(parent[key]);
  if (child && Object.keys(child).length === 0) {
    delete parent[key];
  }
}

function ensureSnapshot(
  preset: EditPreset,
  index: number,
): Record<string, unknown> {
  return ensureObject(preset.tone, `snapshot${index}`);
}

function snapshotControllerBlock(
  preset: EditPreset,
  index: number,
): Record<string, unknown> {
  const snapshot = ensureSnapshot(preset, index);
  const controllers = ensureObject(snapshot, 'controllers');
  return ensureObject(controllers, 'dsp0');
}

/** Raw `@value` stored in a snapshot: booleans are written as 0/1. */
function snapshotRawValue(value: number | boolean): number {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

/**
 * True when a parameter has a stored value for this snapshot.
 *
 * These values recall with the snapshot whether the base controller is the
 * Snapshots controller or an EXP/footswitch assignment, so the inspector can
 * edit the active snapshot instead of the preset-level value.
 */
export function hasImportedSnapshotParam(
  preset: EditPreset,
  snapshotIndex: number,
  block: number,
  paramName: string,
): boolean {
  if (snapshotIndex < 0 || snapshotIndex > 3) {
    return false;
  }
  const snapshot = asObject(preset.tone[`snapshot${snapshotIndex}`]);
  const blockControllers = asObject(
    asObject(asObject(snapshot?.controllers)?.dsp0)?.[`block${block}`],
  );
  return asObject(blockControllers?.[paramName]) !== null;
}

/**
 * Write one snapshot's value for a parameter.
 *
 * The block value is updated too, so the exported preset still carries the
 * value the vendor editor shows for the loaded snapshot. Only `@value` is
 * touched; `@fs_enabled` and unknown keys on the entry survive.
 */
export function setImportedSnapshotParam(
  preset: EditPreset,
  snapshotIndex: number,
  block: number,
  paramName: string,
  value: number | boolean,
): void {
  if (snapshotIndex < 0 || snapshotIndex > 3) {
    return;
  }
  const dsp0 = snapshotControllerBlock(preset, snapshotIndex);
  const blockControllers = ensureObject(dsp0, `block${block}`);
  const existing = asObject(blockControllers[paramName]);
  if (existing) {
    existing['@value'] = snapshotRawValue(value);
  } else {
    blockControllers[paramName] = {
      '@fs_enabled': false,
      '@value': snapshotRawValue(value),
    };
  }
}

/**
 * Assign or remove the Snapshots controller on one parameter.
 *
 * Assigning creates the base controller entry plus a value for all four
 * snapshots (the caller passes the value currently shown). Removing deletes
 * the base entry and every per-snapshot value for that parameter. The caller
 * must refuse to replace a different controller; this helper preserves any
 * existing per-snapshot values when they are already present.
 */
export function setImportedSnapshotAssignment(
  preset: EditPreset,
  block: number,
  paramName: string,
  assigned: boolean,
  value: number | boolean,
): void {
  const controllerRoot = asObject(preset.tone.controller);
  if (assigned) {
    if (!controllerRoot) {
      preset.tone.controller = {};
    }
    const root = asObject(preset.tone.controller) ?? {};
    const dsp0 = ensureObject(root, 'dsp0');
    const blockControllers = ensureObject(dsp0, `block${block}`);
    blockControllers[paramName] = {
      '@controller': SNAPSHOT_CONTROLLER,
      '@min': 0,
      '@max': 1,
    };
    for (let index = 0; index < 4; index += 1) {
      const snapshotDsp0 = snapshotControllerBlock(preset, index);
      const snapshotBlock = ensureObject(snapshotDsp0, `block${block}`);
      if (!asObject(snapshotBlock[paramName])) {
        snapshotBlock[paramName] = {
          '@fs_enabled': false,
          '@value': snapshotRawValue(value),
        };
      }
    }
    return;
  }

  const dsp0 = asObject(controllerRoot?.dsp0);
  const blockControllers = asObject(dsp0?.[`block${block}`]);
  if (blockControllers) {
    delete blockControllers[paramName];
    if (dsp0) {
      pruneEmpty(dsp0, `block${block}`);
    }
  }
  for (let index = 0; index < 4; index += 1) {
    const snapshot = asObject(preset.tone[`snapshot${index}`]);
    const snapshotDsp0 = asObject(asObject(snapshot?.controllers)?.dsp0);
    const snapshotBlock = asObject(snapshotDsp0?.[`block${block}`]);
    if (!snapshotBlock) {
      continue;
    }
    delete snapshotBlock[paramName];
    if (snapshotDsp0) {
      pruneEmpty(snapshotDsp0, `block${block}`);
    }
  }
}

/**
 * Assign an EXP pedal or footswitch controller to one parameter, or remove it.
 *
 * Offline `.pgp` authoring only. The helper edits `tone.controller.dsp0` and
 * preserves `@min`, `@max` and any unknown keys on an existing entry. It never
 * touches `tone.footswitch` or snapshot values: assigning a bypass footswitch
 * and assigning a parameter controller are separate fields in the document.
 *
 * The FS1–FS6 numbers are inferred (see {@link FOOTSWITCH_CONTROLLER_MIN});
 * no capture validates them, so this is not wired to a pedal write.
 */
export function setImportedControllerAssignment(
  preset: EditPreset,
  block: number,
  paramName: string,
  controller: number | null,
): void {
  const controllerRoot = asObject(preset.tone.controller);
  if (controller === null) {
    const dsp0 = asObject(controllerRoot?.dsp0);
    const blockControllers = asObject(dsp0?.[`block${block}`]);
    if (blockControllers) {
      delete blockControllers[paramName];
      if (dsp0) {
        pruneEmpty(dsp0, `block${block}`);
      }
    }
    return;
  }

  if (!controllerRoot) {
    preset.tone.controller = {};
  }
  const root = asObject(preset.tone.controller) ?? {};
  const dsp0 = ensureObject(root, 'dsp0');
  const blockControllers = ensureObject(dsp0, `block${block}`);
  const existing = asObject(blockControllers[paramName]);
  blockControllers[paramName] = {
    ...existing,
    // Documents name Snapshots `10`; a pedal read carries the wire `11`.
    '@controller': isSnapshotController(controller)
      ? SNAPSHOT_CONTROLLER
      : controller,
    '@min': asNumber(existing?.['@min']) ?? 0,
    '@max': asNumber(existing?.['@max']) ?? 1,
  };
}

/**
 * Assign a block's bypass to a footswitch, or remove the assignment.
 *
 * Offline `.pgp` authoring only: this writes the `tone.footswitch` bypass map
 * (the manual's "Bypass/Control > Bypass > Switch"), which is separate from a
 * parameter's controller. Several blocks may share the same switch (the
 * manual calls this "Merge"), so this never clears another block's entry; each
 * block carries its own `blockN` object with the same `@fs_index`.
 *
 * `group` is 0-based (`0`…`7` = FS1…FS8, `8` = EXP toe). Pass `null` to remove
 * the assignment. Existing keys (`@fs_label`, `@fs_ledcolor`, `@fs_momentary`,
 * `@fs_primary`) are preserved; a custom label is never overwritten.
 */
export function setImportedFootswitchAssignment(
  preset: EditPreset,
  block: number,
  group: number | null,
  label?: string,
): void {
  if (!Number.isInteger(block) || block < 0 || block >= BLOCK_COUNT) {
    return;
  }
  const root = asObject(asObject(preset.tone.footswitch)?.dsp0);
  const key = `block${block}`;
  if (group === null) {
    if (root) {
      delete root[key];
    }
    return;
  }
  if (
    !Number.isInteger(group) ||
    group < FOOTSWITCH_GROUP_MIN ||
    group > FOOTSWITCH_GROUP_MAX
  ) {
    return;
  }
  if (!asObject(preset.tone.footswitch)) {
    preset.tone.footswitch = {};
  }
  const footswitchRoot = asObject(preset.tone.footswitch) ?? {};
  const dsp0 = ensureObject(footswitchRoot, 'dsp0');
  const existing = asObject(dsp0[key]);
  const entry: Record<string, unknown> = existing ? { ...existing } : {};
  entry['@fs_enabled'] = true;
  entry['@fs_index'] = group + 1;
  const currentLabel = asString(entry['@fs_label']);
  if ((currentLabel === null || currentLabel === '') && label !== undefined) {
    entry['@fs_label'] = label;
  }
  dsp0[key] = entry;
}

/**
 * Set one block's bypass state for a snapshot.
 *
 * The other snapshots are seeded from the previous block state when they do
 * not carry an explicit value yet, so adding a bypass state to one snapshot
 * cannot silently change the others. The base `@enabled` follows the active
 * snapshot and is what the vendor editor shows for the loaded preset.
 */
export function setImportedBlockEnabled(
  preset: EditPreset,
  snapshotIndex: number,
  block: number,
  enabled: boolean,
): void {
  if (snapshotIndex < 0 || snapshotIndex > 3) {
    return;
  }
  const baseBlock = asObject(asObject(preset.tone.dsp0)?.[`block${block}`]);
  const previous = baseBlock?.['@enabled'] !== false;
  for (let index = 0; index < 4; index += 1) {
    const snapshot = ensureSnapshot(preset, index);
    const blocks = ensureObject(snapshot, 'blocks');
    const dsp0 = ensureObject(blocks, 'dsp0');
    const key = `block${block}`;
    if (typeof dsp0[key] !== 'boolean') {
      dsp0[key] = previous;
    }
    if (index === snapshotIndex) {
      dsp0[key] = enabled;
    }
  }
  if (baseBlock) {
    baseBlock['@enabled'] = enabled;
  }
}

/** Set one snapshot's footswitch LED palette index (0 = Auto … 11 = Off). */
export function setImportedSnapshotLedColor(
  preset: EditPreset,
  index: number,
  color: number,
): void {
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    return;
  }
  if (!Number.isInteger(color) || color < 0 || color > 11) {
    return;
  }
  ensureSnapshot(preset, index)['@ledcolor'] = color;
}

/**
 * Set the loaded snapshot (`@current_snapshot`, 0-based).
 *
 * This only changes the document. While a pedal is connected the page recalls
 * the snapshot with operation 88 and records the pedal's answer in
 * `@pedal_snapshot`, so a document keeps both what the editor shows and what
 * the pedal last reported.
 */
export function setImportedSnapshot(preset: EditPreset, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    return;
  }
  const global = asObject(preset.tone.global);
  if (global) {
    global['@current_snapshot'] = index;
  }
}

/**
 * Snapshot the **pedal** last reported, or `null`.
 *
 * Written when the pedal acknowledges a snapshot recall (op 88) or sends a
 * snapshot notification. It is what the next Save (op 71) makes permanent:
 * the pedal stores that snapshot as the one a fresh recall starts on.
 */
export function pedalSnapshotIndex(preset: EditPreset): number | null {
  const value = asNumber(asObject(preset.tone.global)?.['@pedal_snapshot']);
  return value !== null && Number.isInteger(value) && value >= 0 && value <= 3
    ? value
    : null;
}

/** Record the snapshot the pedal reported (see {@link pedalSnapshotIndex}). */
export function setPedalSnapshotIndex(
  preset: EditPreset,
  index: number,
): void {
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    return;
  }
  const global = asObject(preset.tone.global);
  if (global) {
    global['@pedal_snapshot'] = index;
  }
}

/**
 * Rename one snapshot, keeping its stored state and validity flag.
 *
 * An empty name removes `@name`, so the vendor editor falls back to
 * `SNAPSHOT n`. Snapshots that were `{}` get an object with only the name;
 * this does not mark them valid, because this build has no evidence for when
 * the pedal flips `@valid`.
 */
export function setImportedSnapshotName(
  preset: EditPreset,
  index: number,
  name: string,
): void {
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    return;
  }
  const key = `snapshot${index}`;
  const snapshot = asObject(preset.tone[key]);
  if (!snapshot) {
    if (name) {
      preset.tone[key] = { '@name': name };
    }
    return;
  }
  if (name) {
    snapshot['@name'] = name;
  } else {
    delete snapshot['@name'];
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
 * Remove one effect from an offline document.
 *
 * The slot becomes the vendor's unused-slot shape (`{ "@position": block }`,
 * no `@model`), which `toneToStructure` reads as an empty slot. The block's
 * footswitch, controller and snapshot overrides are cleared along with it, so
 * the preset keeps no dangling assignments to a block that no longer exists.
 */
export function removeImportedBlock(preset: EditPreset, block: number): void {
  if (!Number.isInteger(block) || block < 0 || block >= BLOCK_COUNT) {
    return;
  }
  const tone = preset.tone;
  const dsp0 = asObject(tone.dsp0);
  if (!dsp0) {
    return;
  }
  dsp0[`block${block}`] = { '@position': block };

  // Per-block roots: `tone.footswitch.dsp0` and `tone.controller.dsp0` carry
  // one key per block (`block0`, `block1`, …). Clear both so the removed
  // effect keeps no switch or controller assignment.
  const footswitchRoot =
    asObject(asObject(tone.footswitch)?.dsp0);
  if (footswitchRoot) {
    delete footswitchRoot[`block${block}`];
  }
  const controllerRoot = asObject(asObject(tone.controller)?.dsp0);
  if (controllerRoot) {
    delete controllerRoot[`block${block}`];
  }

  // Snapshot overrides for this block: the bypass boolean and any stored
  // controller values.
  for (let index = 0; index < 4; index += 1) {
    const snapshot = asObject(tone[`snapshot${index}`]);
    if (!snapshot) {
      continue;
    }
    const blocks = asObject(asObject(snapshot.blocks)?.dsp0);
    if (blocks) {
      delete blocks[`block${block}`];
    }
    const controllers = asObject(asObject(snapshot.controllers)?.dsp0);
    if (controllers) {
      delete controllers[`block${block}`];
    }
  }
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

// --- `.pgb` export ---------------------------------------------------------
//
// A backup is rebuilt from the container read at import time. Members that
// were not edited keep their exact stored bytes, so impulse responses, the
// model archive and any unknown member survive untouched. Only the setlists
// that changed are re-serialized and recompressed; the header, the directory
// header and the trailer are copied, and the offsets are patched.
//
// The layout is `ITM`: it reproduces the observed `AF6L` file (48-byte header,
// consecutive members, `IDGP` directory, 36-byte records). POD Go Edit has not
// been asked to open a re-written backup yet.

/** The body of one setlist entry (`data` of an `.pgp`'s `L6Preset`). */
function presetBody(preset: EditPreset): Record<string, unknown> {
  if (preset.document) {
    const data = asObject(preset.document.data);
    if (data) {
      return data;
    }
  }
  // A `.pgb` setlist entry stores exactly these four keys; `meta` carries
  // only the build and the name. Keep that observed shape rather than the
  // richer `.pgp` metadata envelope.
  return {
    device: preset.device,
    device_version: preset.deviceVersion,
    meta: {
      build_sha: preset.buildSha,
      name: preset.name,
    },
    tone: preset.tone,
  };
}

/** Replace one slot in a setlist document, keeping every other entry. */
function withSlot(
  document: Record<string, unknown>,
  slot: number,
  preset: EditPreset | null,
): Record<string, unknown> {
  const data = asObject(document.data) ?? {};
  const rawPresets = Array.isArray(data.presets) ? [...data.presets] : [];
  while (rawPresets.length < SLOT_COUNT) {
    rawPresets.push({});
  }
  rawPresets[slot] = preset ? presetBody(preset) : {};
  return { ...document, data: { ...data, presets: rawPresets } };
}

/**
 * Apply the edited presets to a parsed backup.
 *
 * `edits` maps a setlist index to the slots that changed; each value is the
 * draft to store, or `null` to empty the slot. The returned backup keeps the
 * original container and documents, so `serializePgb` can preserve them.
 */
export function applyBackupEdits(
  backup: EditBackup,
  edits: Map<number, Map<number, EditPreset | null>>,
): EditBackup {
  if (edits.size === 0) {
    return backup;
  }
  const setlists = backup.setlists.map((setlist, index) => {
    const slots = edits.get(index);
    if (!slots || !setlist.document) {
      return setlist;
    }
    let document = setlist.document;
    const presets = [...setlist.presets];
    for (const [slot, preset] of slots) {
      if (slot < 0 || slot >= SLOT_COUNT) {
        continue;
      }
      document = withSlot(document, slot, preset);
      presets[slot] = preset;
    }
    return { ...setlist, presets, document, stored: null };
  });
  return { ...backup, setlists };
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error(
      'This browser cannot write .pgb files (CompressionStream is missing). Use Chrome or Edge.',
    );
  }
  const body = new Blob([new Uint8Array(bytes)]).stream();
  const stream = body.pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface StoredMember {
  tag: string;
  reserved: number;
  codec: number;
  original: number;
  stored: Uint8Array;
}

/**
 * Rebuild the `AF6L` container from a parsed backup.
 *
 * Only the setlist members whose `stored` bytes were cleared by
 * `applyBackupEdits` are re-encoded; every other member (and the header,
 * directory header and trailer) is copied verbatim. Throws when the backup
 * was read without a directory, because the member order would be unknown.
 */
export async function serializePgb(backup: EditBackup): Promise<Uint8Array> {
  const container = backup.container;
  if (!container) {
    throw new Error(
      'This .pgb was read without its directory, so it cannot be rebuilt. ' +
        'Re-import a backup that POD Go Edit exported.',
    );
  }

  const encoder = new TextEncoder();
  const setlistByTag = new Map<string, EditSetlist>();
  for (const setlist of backup.setlists) {
    if (setlist.memberTag) {
      setlistByTag.set(setlist.memberTag, setlist);
    }
  }

  const members: StoredMember[] = [];
  for (const member of container.members) {
    const setlist = setlistByTag.get(member.tag);
    if (!setlist || setlist.stored) {
      members.push({
        tag: member.tag,
        reserved: member.reserved,
        codec: member.codec,
        original: member.original,
        stored: member.stored,
      });
      continue;
    }
    if (!setlist.document) {
      throw new Error(
        `Setlist ${member.tag} has no document to write.`,
      );
    }
    const plain = encoder.encode(JSON.stringify(setlist.document, null, 1));
    const compressed = await deflate(plain);
    members.push({
      tag: member.tag,
      reserved: member.reserved,
      codec: 1,
      original: plain.length,
      stored: compressed,
    });
  }

  const header = new Uint8Array(container.header);
  const headerView = new DataView(header.buffer, header.byteOffset);
  const headerLength = header.length >= 48 ? 48 : header.length;
  let offset = headerLength;
  for (const member of members) {
    offset += member.stored.length;
  }
  const directoryOffset = offset;

  const directorySize =
    8 + container.directoryHeader.length + members.length * 36 + container.trailer.length;
  const directory = new Uint8Array(directorySize);
  const directoryView = new DataView(directory.buffer);
  directory.set([0x49, 0x44, 0x47, 0x50], 0); // "IDGP"
  directoryView.setUint32(4, container.directoryHeader.length, true);
  directory.set(container.directoryHeader, 8);
  let pos = 8 + container.directoryHeader.length;
  let dataOffset = headerLength;
  for (const member of members) {
    directoryView.setUint32(pos, member.reserved, true);
    for (let index = 0; index < 4; index += 1) {
      directory[pos + 4 + index] = member.tag.charCodeAt(3 - index);
    }
    directoryView.setBigUint64(pos + 8, BigInt(dataOffset), true);
    directoryView.setBigUint64(pos + 16, BigInt(member.stored.length), true);
    directoryView.setUint32(pos + 24, member.codec, true);
    directoryView.setBigUint64(pos + 28, BigInt(member.original), true);
    dataOffset += member.stored.length;
    pos += 36;
  }
  directory.set(container.trailer, pos);

  headerView.setBigUint64(8, BigInt(directoryOffset), true);

  const total =
    headerLength +
    members.reduce((sum, member) => sum + member.stored.length, 0) +
    directorySize;
  const out = new Uint8Array(total);
  out.set(header, 0);
  let cursor = headerLength;
  for (const member of members) {
    out.set(member.stored, cursor);
    cursor += member.stored.length;
  }
  out.set(directory, cursor);
  return out;
}

// --- selective backup content ---------------------------------------------
//
// A `AF6L` backup is a bag of tagged members: `SL00`/`SL01` setlists, `I000`
// impulse responses, `GLOB` globals, plus the `SLNM` name table and `UMDS`
// model archive. The page can import or export any of the four user-visible
// groups while keeping the bookkeeping members so the file stays readable.

const FACTORY_SETLIST_TAG = 'SL00';
const USER_SETLIST_TAG = 'SL01';
/** Impulse responses are `I000`, `I001`, … (`RIFF/WAVE` content). */
const IR_MEMBER_TAG = /^I\d{3}$/;

/** Which optional parts of a `.pgb` to import or export. */
export interface BackupContentSelection {
  factory: boolean;
  user: boolean;
  irs: boolean;
  globals: boolean;
}

/**
 * Slot-level granularity, keyed by setlist member tag (`SL00`, `SL01`).
 *
 * Stored only when the user ticked individual presets. An absent entry (or an
 * entry without `slots`) means the whole setlist is imported/exported; an
 * entry with a non-empty `slots` set restricts the operation to those slots.
 */
export interface BackupSlotSelection {
  /** Setlist member tag the slots belong to. */
  tag: string;
  /** Slot indexes to keep. */
  slots: Set<number>;
}

/** What a parsed `.pgb` offers, in the terms the selection uses. */
export interface BackupContent {
  /** Non-empty presets in the Factory setlist. */
  factory: number;
  /** Non-empty presets in the User setlist. */
  user: number;
  /** Number of impulse-response members. */
  irs: number;
  /** True when the globals member is present. */
  globals: boolean;
}

/** True for an impulse-response member (`I000`, `I001`, …). */
export function isIrMember(tag: string): boolean {
  return IR_MEMBER_TAG.test(tag);
}

function setlistTag(
  backup: EditBackup,
  index: number,
  fallback: string,
): string {
  return backup.setlists[index]?.memberTag ?? fallback;
}

/** True when the selection includes this setlist member. */
export function setlistInSelection(
  setlist: EditSetlist,
  selection: BackupContentSelection,
): boolean {
  if (setlist.memberTag === FACTORY_SETLIST_TAG) {
    return selection.factory;
  }
  if (setlist.memberTag === USER_SETLIST_TAG) {
    return selection.user;
  }
  // Read without a directory: the tag is unknown, so never hide it.
  return true;
}

/** Count the parts a `.pgb` offers to import or export. */
export function backupContent(backup: EditBackup): BackupContent {
  const container = backup.container;
  const factoryTag = setlistTag(backup, 0, FACTORY_SETLIST_TAG);
  const userTag = setlistTag(backup, 1, USER_SETLIST_TAG);
  const count = (setlist: EditSetlist | undefined): number =>
    setlist ? setlist.presets.filter((preset) => preset !== null).length : 0;
  return {
    factory: count(
      backup.setlists.find((setlist) => setlist.memberTag === factoryTag) ??
        backup.setlists[0],
    ),
    user: count(
      backup.setlists.find((setlist) => setlist.memberTag === userTag) ??
        backup.setlists[1],
    ),
    irs:
      container?.members.filter((member) => isIrMember(member.tag)).length ?? 0,
    globals:
      container?.members.some((member) => member.tag === 'GLOB') ?? false,
  };
}

/**
 * Keep only the selected parts of a backup.
 *
 * Members this build does not recognise (the `SLNM` name table, the `UMDS`
 * model archive, anything unknown) are always kept, so the rebuilt file stays
 * readable. `serializePgb` recomputes every directory offset afterwards.
 */
export function selectBackupContent(
  backup: EditBackup,
  selection: BackupContentSelection,
  slots?: BackupSlotSelection[],
): EditBackup {
  const container = backup.container;
  if (!container) {
    throw new Error(
      'This .pgb was read without its directory, so it cannot be rebuilt.',
    );
  }
  const factoryTag = setlistTag(backup, 0, FACTORY_SETLIST_TAG);
  const userTag = setlistTag(backup, 1, USER_SETLIST_TAG);
  const keep = (tag: string): boolean => {
    if (tag === factoryTag) {
      return selection.factory;
    }
    if (tag === userTag) {
      return selection.user;
    }
    if (isIrMember(tag)) {
      return selection.irs;
    }
    if (tag === 'GLOB') {
      return selection.globals;
    }
    return true;
  };
  const slotSet = (setlist: EditSetlist | undefined): Set<number> | undefined => {
    if (!setlist?.memberTag || !slots) {
      return undefined;
    }
    return slots.find((s) => s.tag === setlist.memberTag)?.slots;
  };
  const setlists = backup.setlists
    .filter((setlist) => !setlist.memberTag || keep(setlist.memberTag))
    .map((setlist) => {
      const restricted = slotSet(setlist);
      if (!setlist.memberTag || restricted === undefined || restricted.size === setlist.presets.length) {
        return setlist;
      }
      if (restricted.size === 0) {
        throw new Error(
          `Setlist ${setlist.name} has presets ticked that add up to nothing to export.`,
        );
      }
      // Empty every slot outside the selection and rebuild the document so the
      // export contains exactly the ticked presets.
      const presets = setlist.presets.map((preset, slot) =>
        restricted.has(slot) ? preset : null,
      );
      let document = setlist.document;
      if (document) {
        const data = asObject(document.data) ?? {};
        const rawPresets = Array.isArray(data.presets)
          ? [...(data.presets as unknown[])]
          : [];
        while (rawPresets.length < SLOT_COUNT) {
          rawPresets.push({});
        }
        for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
          if (!restricted.has(slot)) {
            rawPresets[slot] = {};
          }
        }
        document = { ...document, data: { ...data, presets: rawPresets } };
      }
      return { ...setlist, presets, document, stored: null };
    });
  return {
    ...backup,
    setlists,
    container: {
      ...container,
      members: container.members.filter((member) => keep(member.tag)),
    },
  };
}

/** Filename-safe export name for a `.pgb` backup. */
export function backupFileName(name: string): string {
  const clean = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${clean || 'podgo-backup'}.pgb`;
}
