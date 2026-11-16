// Full backup orchestration over a WebUSB connection.
//
// A full backup is the two setlists plus the raw `l6-helix` body of every
// non-empty slot. The bodies are stored verbatim: nothing is decoded or
// re-encoded, so a restore can reproduce them byte for byte. The container and
// every digest live in Rust (`BackupBuilder`/`verify_backup`); this module only
// drives the existing read flows and reports progress.

import { BackupBuilder, verifyBackup } from '../wasmClient';
import type {
  BackupSkipped,
  BackupVerify,
  SetlistEntry,
} from '../types';
import type { PodgoUsbConnection } from './podgoUsb';
import { readPresetSlot } from './preset';
import { readSetlist, type SetlistKind } from './setlist';

/** Message the read flow returns when a slot holds no preset body. */
const EMPTY_SLOT = 'not a blob: nil';

const SETLIST_NAMES: Record<SetlistKind, string> = {
  0: 'Factory',
  1: 'User',
};

export interface FullBackupResult {
  /** Complete `.pgbak` bytes, already re-verified in Rust. */
  bytes: Uint8Array;
  /** Metadata and digests of the encoded file. */
  summary: BackupVerify;
  /** Slots that held no preset, with the reason. */
  skipped: BackupSkipped[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  device: PodgoUsbConnection,
  onProgress?: (message: string) => void,
): Promise<FullBackupResult> {
  const builder = new BackupBuilder('', '');
  const skipped: BackupSkipped[] = [];
  let metadata = false;
  let presets = 0;

  try {
    for (const setlist of [0, 1] as const) {
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
          if (!metadata) {
            builder.set_metadata(result.structure.product, result.structure.firmware);
            metadata = true;
          }
          builder.add(setlist, entry.slot, entry.name, result.blob);
          presets += 1;
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

    if (presets === 0) {
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

function emptyEntry(
  setlist: SetlistKind,
  entry: SetlistEntry,
  reason: string,
): BackupSkipped {
  return { setlist, slot: entry.slot, name: entry.name, reason };
}
