import init, {
  core_version as wasmCoreVersion,
  inspect_preset,
  inspect_setlist,
  move_chain_entry as wasmMoveChainEntry,
  preset_structure as wasmPresetStructure,
  setlist_entries_json as wasmSetlistEntries,
  subset_backup as wasmSubsetBackup,
  verify_backup as wasmVerifyBackup,
} from './wasm/podgo_wasm.js';
import type { BackupVerify } from './types';

let initialised: Promise<void> | null = null;

/** Initialise the WASM module once, even under React StrictMode. */
export function initWasm(): Promise<void> {
  if (!initialised) {
    initialised = init().then(() => undefined);
  }
  return initialised;
}

export function inspectPreset(bytes: Uint8Array): string {
  return inspect_preset(bytes);
}

export function inspectSetlist(bytes: Uint8Array): string {
  return inspect_setlist(bytes);
}

/** Structured preset view (JSON) for a raw `l6-helix` blob. */
export function presetStructure(bytes: Uint8Array): unknown {
  return JSON.parse(wasmPresetStructure(bytes)) as unknown;
}

/** Move one processing block inside an `l6-helix` container (raw indices). */
export function moveChainEntry(
  bytes: Uint8Array,
  from: number,
  to: number,
): Uint8Array {
  return wasmMoveChainEntry(bytes, from, to);
}

/** Setlist entries (JSON) for a reassembled setlist stream. */
export function setlistEntries(bytes: Uint8Array): unknown {
  return JSON.parse(wasmSetlistEntries(bytes)) as unknown;
}

export function coreVersion(): string {
  return wasmCoreVersion();
}

/** Verify a `.pgbak` file in Rust and return its metadata and digest. */
export function verifyBackup(bytes: Uint8Array): BackupVerify {
  return JSON.parse(wasmVerifyBackup(bytes)) as BackupVerify;
}

/**
 * Encode a subset of a verified `.pgbak`.
 *
 * `pairs` is a flat `[setlist, slot, …]` array; the result keeps the same
 * product/firmware header and every selected body byte for byte.
 */
export function subsetBackup(
  bytes: Uint8Array,
  pairs: Uint8Array,
): Uint8Array {
  return wasmSubsetBackup(bytes, pairs);
}

export {
  BackupBuilder,
  BypassFlow,
  ChainWriteFlow,
  ModelWriteFlow,
  ParamWriteFlow,
  PresetFlow,
  ReadFlow,
  RecallFlow,
  RemoveEffectFlow,
  RestoreFlow,
  SavePresetFlow,
  SnapshotFlow,
} from './wasm/podgo_wasm.js';
