import init, {
  build_event_ack_frame,
  build_event_poll_frame,
  core_version as wasmCoreVersion,
  decode_event_json,
  event_frame_advance,
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

/** One decoded event-channel notification. */
export interface PedalEvent {
  /** Event opcode (key 105). */
  opcode: number;
  /** Unwrapped payload (key 106, envelope removed); `null` for op 21/49. */
  payload: Record<string, unknown> | null;
}

/**
 * Decode one event-channel frame.
 *
 * Returns `null` for a malformed frame instead of throwing: a bad burst must
 * not stop live synchronisation.
 */
export function decodeEvent(bytes: Uint8Array): PedalEvent | null {
  const parsed = JSON.parse(decode_event_json(bytes)) as
    | PedalEvent
    | { error: string };
  if ('error' in parsed) {
    return null;
  }
  return parsed;
}

/** Build one event-channel poll (`cmd=0x10`). */
export function eventPollFrame(seq: number, cursor: number): Uint8Array {
  return build_event_poll_frame(seq, cursor);
}

/** Build one event-channel acknowledgement (`cmd=0x08`). */
export function eventAckFrame(seq: number, cursor: number): Uint8Array {
  return build_event_ack_frame(seq, cursor);
}

/** Cursor advance for one event data frame, or 0 when malformed. */
export function eventFrameAdvance(bytes: Uint8Array): number {
  return event_frame_advance(bytes);
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
