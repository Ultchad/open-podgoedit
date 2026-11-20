// Full restore orchestration over a WebUSB connection.
//
// The restore replays the read-channel preamble (`READ_SEQUENCE`) and then
// streams one operation-5 message per preset, in file order. The Rust
// `RestoreFlow` owns the framing, the stream-window cursor and the status
// decoding; this module only sends frames, waits for window grants and turns
// failures into messages.
//
// Restore is destructive and deliberately narrow: it sends operation 5 only.
// The operation-9/86/113 traffic and the final operation-254 seen in the
// capture are not sent. No restore from this build has been applied to a pedal
// yet; see `docs/protocol/writes.md`.

import { RestoreFlow } from '../wasmClient';
import { PodgoUsbError, type PodgoConnection } from './podgoUsb';

/** The pedal may ignore the first preamble after a read session. */
const MAX_PREAMBLE_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 300;

let transactionCounter = 3000;

export interface RestoreProgress {
  /** Entries already handed to the flow, 1-based while streaming. */
  done: number;
  total: number;
  setlist: number | null;
  slot: number | null;
  name: string;
}

export interface RestoreResult {
  /** Presets streamed, as counted by the Rust flow. */
  entries: number;
  /** Transaction id of the first message (diagnostics only). */
  transactionStart: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function labelOf(json: string): {
  setlist: number | null;
  slot: number | null;
  name: string;
} {
  try {
    const value = JSON.parse(json) as {
      setlist?: number;
      slot?: number;
      name?: string;
    };
    return {
      setlist: typeof value.setlist === 'number' ? value.setlist : null,
      slot: typeof value.slot === 'number' ? value.slot : null,
      name: typeof value.name === 'string' ? value.name : '',
    };
  } catch {
    return { setlist: null, slot: null, name: '' };
  }
}

/**
 * Stream a verified `.pgbak` back to the pedal.
 *
 * The caller must have verified the file and kept a fresh backup; this module
 * does not re-check the container beyond what `RestoreFlow` decodes.
 *
 * @param device Open, claimed connection.
 * @param bytes Verified `.pgbak` file.
 * @param onProgress Optional status callback for the UI and the log.
 */
export async function restoreFullBackup(
  device: PodgoConnection,
  bytes: Uint8Array,
  onProgress?: (progress: RestoreProgress) => void,
): Promise<RestoreResult> {
  const transactionStart = (transactionCounter += 50);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_PREAMBLE_ATTEMPTS; attempt += 1) {
    device.discard();
    let flow: RestoreFlow;
    try {
      flow = new RestoreFlow(bytes, transactionStart);
    } catch (error) {
      throw new PodgoUsbError(messageOf(error));
    }

    try {
      let lastReported = -1;
      while (!flow.is_finished()) {
        const request = flow.next_request();
        if (!request) {
          break;
        }
        await device.send(request);

        while (flow.expects_response()) {
          const response = await device.readRead(flow.timeout_ms());
          if (response === null) {
            flow.accept_timeout();
          } else {
            flow.accept_response(response);
          }
        }

        if (flow.phase() === 'stream' && flow.progress() !== lastReported) {
          lastReported = flow.progress();
          const label = labelOf(flow.current_json());
          onProgress?.({
            done: flow.progress() + 1,
            total: flow.total(),
            ...label,
          });
        }
      }

      const result = flow.result_json();
      if (!result) {
        throw new PodgoUsbError('restore stopped without a result');
      }
      const parsed = JSON.parse(result) as {
        ok?: boolean;
        message?: string;
        entries?: number;
      };
      if (parsed.ok !== true) {
        throw new PodgoUsbError(parsed.message ?? 'the pedal refused the restore');
      }
      return {
        entries: parsed.entries ?? flow.total(),
        transactionStart,
      };
    } catch (error) {
      lastError = error;
      const message = messageOf(error);
      // Only a silent preamble is retried. A rejected window means the pedal
      // is already applying part of the file, so stop immediately.
      const retryable = message.includes(
        'did not answer the restore preamble',
      );
      if (!retryable || attempt >= MAX_PREAMBLE_ATTEMPTS) {
        throw new PodgoUsbError(`restore failed: ${message}`);
      }
      onProgress?.({
        done: 0,
        total: flow.total(),
        setlist: null,
        slot: null,
        name: `preamble attempt ${attempt}/${MAX_PREAMBLE_ATTEMPTS}`,
      });
      await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    } finally {
      flow.free();
    }
  }

  throw new PodgoUsbError(
    `restore failed after ${MAX_PREAMBLE_ATTEMPTS} attempts: ${messageOf(
      lastError,
    )}`,
  );
}
