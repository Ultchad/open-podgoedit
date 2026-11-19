// Read-only setlist orchestration over a WebUSB connection.
//
// The protocol state machine lives in Rust (`ReadFlow`). This module only
// drives it: take the next request, perform one USB round trip, feed the
// response back. The whole five-packet handshake is retried because the POD Go
// commonly ignores the first attempt after connecting.

import { ReadFlow } from '../wasmClient';
import type { SetlistEntry } from '../types';
import { PodgoUsbError, type PodgoConnection } from './podgoUsb';

const MAX_HANDSHAKE_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 300;

export type SetlistKind = 0 | 1;

export interface SetlistReadResult {
  /** Same text report as `podgo-probe --setlist`. */
  report: string;
  /** Reassembled setlist bytes, for diagnostics or a local dump. */
  raw: Uint8Array;
  /** Scanned entries, in stream order (`slot` is the position). */
  entries: SetlistEntry[];
  /** Number of chunk responses consumed. */
  chunks: number;
  /** True when the 64-chunk cap was reached before 128 entries appeared. */
  truncated: boolean;
}

const PHASE_LABELS: Record<string, string> = {
  handshake: 'Handshake',
  'open-presets': 'Ouverture des setlists',
  'open-stream': 'Ouverture du flux',
  chunks: 'Lecture des blocs',
  done: 'Terminé',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read one setlist from the device.
 *
 * @param device Open, claimed connection.
 * @param setlist `0` for Factory, `1` for User.
 * @param onProgress Optional status callback for the UI.
 */
export async function readSetlist(
  device: PodgoConnection,
  setlist: SetlistKind,
  onProgress?: (message: string) => void,
): Promise<SetlistReadResult> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_HANDSHAKE_ATTEMPTS; attempt += 1) {
    device.discard();
    const flow = new ReadFlow(setlist);
    let phase = flow.phase();

    try {
      while (!flow.is_finished()) {
        const request = flow.next_request();
        if (!request) {
          throw new PodgoUsbError(
            `flux bloqué en phase « ${flow.phase()} » sans requête à envoyer`,
          );
        }

        const nextPhase = flow.phase();
        if (nextPhase !== phase || nextPhase === 'chunks') {
          phase = nextPhase;
          const label = PHASE_LABELS[phase] ?? phase;
          onProgress?.(
            phase === 'chunks'
              ? `${label}… ${flow.chunks()} bloc(s)`
              : `${label}…`,
          );
        }

        const response = await device.request(request, flow.timeout_ms());
        flow.accept_response(response);
      }

      const result: SetlistReadResult = {
        report: flow.report(),
        raw: flow.raw(),
        entries: JSON.parse(flow.entries_json()) as SetlistEntry[],
        chunks: flow.chunks(),
        truncated: flow.truncated(),
      };
      flow.free();
      return result;
    } catch (error) {
      const failedPhase = flow.phase();
      flow.free();
      lastError = error;

      if (failedPhase !== 'handshake') {
        throw error;
      }
      if (attempt < MAX_HANDSHAKE_ATTEMPTS) {
        onProgress?.(
          `Handshake tentative ${attempt}/${MAX_HANDSHAKE_ATTEMPTS} échouée, nouvelle tentative…`,
        );
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw new PodgoUsbError(
    `handshake impossible après ${MAX_HANDSHAKE_ATTEMPTS} tentatives: ${messageOf(
      lastError,
    )}`,
  );
}
