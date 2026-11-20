// Backup orchestration over a WebUSB connection.
//
// A backup is a set of setlists plus the raw `l6-helix` body of every selected
// slot. The bodies are stored verbatim: nothing is decoded or re-encoded, so a
// restore can reproduce them byte for byte. The container and every digest live
// in Rust (`BackupBuilder`/`verify_backup`); this module only drives the
// existing read flows and reports progress.
//
// `createFullBackup` reads both setlists and every non-empty slot.
// `createSelectedBackup` reads only the requested slots, which yields a normal
// `.pgbak` that the same restore flow can stream.

import { BackupBuilder, verifyBackup } from '../wasmClient';
import type {
  BackupSkipped,
  BackupVerify,
  SetlistEntry,
} from '../types';
import type { PodgoConnection } from './podgoUsb';
import { readPresetSlot } from './preset';
import { readSetlist, type SetlistKind } from './setlist';

/** Message the read flow returns when a slot holds no preset body. */
const EMPTY_SLOT = 'not a blob: nil';

const SETLIST_NAMES: Record<SetlistKind, string> = {
  0: 'Factory',
  1: 'User',
};

/** One slot requested for a partial backup. */
export interface BackupTarget {
  setlist: SetlistKind;
  slot: number;
}

export interface FullBackupResult {
  /** Complete `.pgbak` bytes, already re-verified in Rust. */
  bytes: Uint8Array;
  /** Metadata and digests of the encoded file. */
  summary: BackupVerify;
  /** Slots that held no preset, with the reason. */
  skipped: BackupSkipped[];
}

interface BuildState {
  metadata: boolean;
  presets: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyEntry(
  setlist: SetlistKind,
  entry: SetlistEntry,
  reason: string,
): BackupSkipped {
  return { setlist, slot: entry.slot, name: entry.name, reason };
}

/**
 * Read one setlist and add the requested slots to the builder.
 *
 * `slots` is `null` for every non-empty slot. The setlist itself is always
 * read: its names are authoritative, and a truncated stream must abort the
 * backup rather than produce a partial file.
 */
async function collectSlots(
  device: PodgoConnection,
  setlist: SetlistKind,
  slots: ReadonlySet<number> | null,
  builder: BackupBuilder,
  state: BuildState,
  skipped: BackupSkipped[],
  onProgress?: (message: string) => void,
): Promise<void> {
  const label = SETLIST_NAMES[setlist];
  onProgress?.(`Backup: reading the ${label} setlist…`);
  // The per-chunk phase messages would flood the log for 256 slots; the
  // per-slot line below is the useful progress unit.
  const list = await readSetlist(device, setlist);
  if (list.truncated) {
    throw new Error(
      `the ${label} setlist read was truncated; refusing a partial backup`,
    );
  }

  for (const [index, entry] of list.entries.entries()) {
    if (slots && !slots.has(entry.slot)) {
      continue;
    }
    const position = `${index + 1}/${list.entries.length}`;
    onProgress?.(
      `Backup: ${label} ${position} (slot ${entry.slot}, ${
        entry.name || 'unnamed'
      })…`,
    );
    if (!entry.name) {
      skipped.push(emptyEntry(setlist, entry, 'the setlist has no name'));
      continue;
    }

    try {
      const result = await readPresetSlot(
        device,
        setlist,
        entry.slot,
        entry.name,
      );
      if (result.truncated) {
        throw new Error(
          `the ${label} preset at slot ${entry.slot} was truncated`,
        );
      }
      if (!state.metadata) {
        builder.set_metadata(result.structure.product, result.structure.firmware);
        state.metadata = true;
      }
      builder.add(setlist, entry.slot, entry.name, result.blob);
      state.presets += 1;
    } catch (error) {
      const message = messageOf(error);
      if (message.includes(EMPTY_SLOT)) {
        skipped.push(emptyEntry(setlist, entry, 'empty slot'));
        continue;
      }
      throw new Error(
        `${label} slot ${entry.slot} (${entry.name}): ${message}`,
      );
    }
  }
}

async function buildBackup(
  device: PodgoConnection,
  targets: BackupTarget[] | null,
  onProgress?: (message: string) => void,
): Promise<FullBackupResult> {
  const builder = new BackupBuilder('', '');
  const skipped: BackupSkipped[] = [];
  const state: BuildState = { metadata: false, presets: 0 };

  try {
    if (targets === null) {
      for (const setlist of [0, 1] as const) {
        await collectSlots(
          device,
          setlist,
          null,
          builder,
          state,
          skipped,
          onProgress,
        );
      }
    } else {
      const bySetlist: Record<SetlistKind, Set<number>> = {
        0: new Set<number>(),
        1: new Set<number>(),
      };
      for (const target of targets) {
        bySetlist[target.setlist].add(target.slot);
      }
      for (const setlist of [0, 1] as const) {
        const slots = bySetlist[setlist];
        if (slots.size === 0) {
          continue;
        }
        await collectSlots(
          device,
          setlist,
          slots,
          builder,
          state,
          skipped,
          onProgress,
        );
      }
    }

    if (state.presets === 0) {
      throw new Error('the pedal returned no preset; refusing an empty backup');
    }

    const bytes = builder.finish();
    const summary = verifyBackup(bytes);
    onProgress?.(
      `Backup: ${summary.entries.length} preset(s), ${bytes.length} B, ` +
        `SHA-256 ${summary.digest}.`,
    );
    return { bytes, summary, skipped };
  } finally {
    builder.free();
  }
}

/**
 * Read every non-empty slot of both setlists and build a `.pgbak` file.
 *
 * Factory is read first, then User, in slot order. A slot the pedal reports as
 * empty is recorded in `skipped` and omitted from the backup; any other error
 * aborts the backup, because a partial file must not be offered as a full one.
 *
 * @param device Open, claimed connection.
 * @param onProgress Optional status callback for the UI and the log.
 */
export async function createFullBackup(
  device: PodgoConnection,
  onProgress?: (message: string) => void,
): Promise<FullBackupResult> {
  return buildBackup(device, null, onProgress);
}

/**
 * Read only the requested slots and build a `.pgbak` file.
 *
 * The result is a normal backup container, so `verifyBackup` accepts it and
 * the restore flow streams just these presets. Empty slots are skipped, but a
 * selection that yields no body is an error.
 *
 * @param device Open, claimed connection.
 * @param targets Setlist/slot pairs to include.
 * @param onProgress Optional status callback for the UI and the log.
 */
export async function createSelectedBackup(
  device: PodgoConnection,
  targets: BackupTarget[],
  onProgress?: (message: string) => void,
): Promise<FullBackupResult> {
  if (targets.length === 0) {
    throw new Error('select at least one slot to back up');
  }
  return buildBackup(device, targets, onProgress);
}
