// Structured preset view produced by the Rust core (`PresetFlow.structure_json`
// or `preset_structure`). On-wire ids only: names and display values are
// resolved by `src/catalog`.

export type ParamKind = 'cont' | 'int' | 'bool';

export interface CatalogParam {
  /** On-wire parameter name (`@trails`, `FcLow`, …). */
  n: string;
  min: number | null;
  max: number | null;
  k: ParamKind;
  /** Value labels for discrete parameters. */
  labels?: string[];
}

export interface CatalogModel {
  /** Full model name (`HD2_WahFasselStereo`). */
  name: string;
  /** Official visible name (`Fassel`). */
  display: string;
  /** Human-readable short name (`Fassel`). */
  short: string;
  category: string | null;
  sub: string | null;
  /** JSON `@type` the vendor editor writes for this model. */
  type?: number | null;
  /**
   * Vendor default values, including block attributes such as `@mic` and
   * `@trails`. Used when a model is loaded into a block offline.
   */
  defaults?: Record<string, number | boolean>;
  params: CatalogParam[];
}

export type ChainParamValue = number | boolean | null;

export type ChainEntry =
  | { slot: number; kind: 'input'; params: ChainParamValue[] }
  | { slot: number; kind: 'output'; params: ChainParamValue[] }
  | {
      slot: number;
      kind: 'block';
      modelId: number;
      category: number | null;
      enabled: boolean;
      noSnapshotBypass: boolean;
      params: ChainParamValue[];
    }
  | {
      slot: number;
      kind: 'looper';
      modelId: number | null;
      enabled: boolean;
      params: ChainParamValue[];
    }
  | { slot: number; kind: 'empty' }
  | { slot: number; kind: 'unknown'; class: number };

export type ProcessingEntry = Extract<
  ChainEntry,
  { kind: 'block' | 'looper' | 'empty' | 'unknown' }
>;

export interface FootswitchAssignment {
  group: number;
  /** `FS1`…`FS8` or `EXP Toe`. */
  switch: string;
  /** 1-based processing slot. */
  block: number;
  label: string;
  enabled: boolean;
}

export interface ControllerAssignment {
  controller: number;
  paramIndex: number;
  min: number;
  max: number;
}

export interface PresetStructure {
  preset: { name: string; setlist: number | null; slot: number | null };
  product: string;
  firmware: string;
  tempo: number | null;
  currentSnapshot: number | null;
  snapshots: { name: string; valid: boolean; tempo: number | null }[];
  chain: ChainEntry[];
  footswitches: FootswitchAssignment[];
  controllers: ControllerAssignment[];
}

export function isProcessing(entry: ChainEntry): entry is ProcessingEntry {
  return (
    entry.kind === 'block' ||
    entry.kind === 'looper' ||
    entry.kind === 'empty' ||
    entry.kind === 'unknown'
  );
}

/** Selected chain position: an endpoint or a 0-based processing index. */
export type Selection = 'input' | 'output' | number;

/**
 * One `set_param` (operation 30) request from the inspector.
 *
 * `block` is the raw chain index (`entry.slot`, input is `0`) and `value` is
 * in raw DSP units, ready for `writeParam`.
 */
export interface ParamWriteTarget {
  block: number;
  param: number;
  value: number;
  /** Human description used by the confirmation dialog and the log. */
  label: string;
}

/** One entry of a streamed setlist (`slot` = position in the setlist). */
export interface SetlistEntry {
  slot: number;
  name: string;
}

/** One preset inside a verified `.pgbak` file, as reported by Rust. */
export interface BackupVerifyEntry {
  setlist: number;
  slot: number;
  name: string;
  /** Raw `l6-helix` body length in bytes. */
  size: number;
  /** Lower-case SHA-256 of the raw body. */
  sha256: string;
}

/**
 * Result of `verifyBackup` in the Rust core.
 *
 * `digest` covers the whole file, so it changes if any byte (metadata included)
 * is modified. The core refuses to return this object for a damaged file.
 */
export interface BackupVerify {
  product: string;
  firmware: string;
  /** Lower-case SHA-256 of the complete `.pgbak` file. */
  digest: string;
  entries: BackupVerifyEntry[];
}

/** One preset skipped while building a full backup. */
export interface BackupSkipped {
  setlist: number;
  slot: number;
  name: string;
  reason: string;
}
