// Read-only preset orchestration over a WebUSB connection.
//
// The protocol state machine lives in Rust (`PresetFlow`). This module only
// drives it, exactly like `setlist.ts`: take the next request, perform one USB
// round trip, feed the response back. The whole five-packet handshake is
// retried because the POD Go commonly ignores the first attempt.

import { PresetFlow } from '../wasmClient';
import type { PresetStructure } from '../types';
import { PodgoUsbError, type PodgoConnection } from './podgoUsb';

const MAX_HANDSHAKE_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 300;

export interface PresetReadResult {
  /** Same text report as `podgo-probe` on the active preset. */
  report: string;
  /** The `l6-helix` blob (key 104), for a local dump. */
  blob: Uint8Array;
  /** Structured view for the editor (on-wire ids and raw values). */
  structure: PresetStructure;
  /** Number of chunk responses consumed. */
  chunks: number;
  /** True when the chunk cap was reached before the device ended the object. */
  truncated: boolean;
}

const PHASE_LABELS: Record<string, string> = {
  handshake: 'Handshake',
  'open-presets': 'Opening the preset list',
  'open-object': 'Opening the preset',
  chunks: 'Reading blocks',
  done: 'Done',
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
 * Drive one preset flow to completion, retrying the handshake if needed.
 *
 * @param makeFlow Builds a fresh flow for each attempt.
 * @param name Preset name for a slot read; empty to use object 23.
 */
async function readPresetWith(
  device: PodgoConnection,
  makeFlow: () => PresetFlow,
  name: string,
  onProgress?: (message: string) => void,
): Promise<PresetReadResult> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_HANDSHAKE_ATTEMPTS; attempt += 1) {
    device.discard();
    const flow = makeFlow();
    let phase = flow.phase();
    let handshakeRetries = 0;

    try {
      while (!flow.is_finished()) {
        let request = flow.next_request();
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

        // The pedal often ignores the first handshake after an object. Retry
        // the sequence in place so the objects already read stay available
        // (in particular object 23's setlist/slot/name).
        let response: Uint8Array;
        for (;;) {
          const inHandshake = flow.phase() === 'handshake';
          try {
            response = await device.request(request, flow.timeout_ms());
            break;
          } catch (error) {
            if (
              !inHandshake ||
              handshakeRetries >= MAX_HANDSHAKE_ATTEMPTS
            ) {
              throw error;
            }
            handshakeRetries += 1;
            onProgress?.(
              `Handshake tentative ${handshakeRetries}/${MAX_HANDSHAKE_ATTEMPTS} échouée, nouvelle tentative…`,
            );
            await delay(BACKOFF_BASE_MS * 2 ** (handshakeRetries - 1));
            device.discard();
            flow.restart_handshake();
            const replay = flow.next_request();
            if (!replay) {
              throw new PodgoUsbError(
                `handshake impossible à rejouer en phase « ${flow.phase()} »`,
              );
            }
            request = replay;
          }
        }

        flow.accept_response(response);
        if (flow.phase() !== 'handshake') {
          handshakeRetries = 0;
        }
      }

      const json = name
        ? flow.structure_json_named(name)
        : flow.structure_json();
      const result: PresetReadResult = {
        report: flow.report(),
        blob: flow.blob(),
        structure: JSON.parse(json) as PresetStructure,
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
          `Handshake toujours muet, redémarrage du flux (${attempt}/${MAX_HANDSHAKE_ATTEMPTS})…`,
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

/**
 * Read the active preset: object 23 (active state) then object 22.
 *
 * If the device does not answer object 23 at all, the read falls back to
 * object 22 alone, with the same open request the two-object flow uses. The
 * setlist/slot then stay unknown, and the name comes from the page when it is
 * known.
 *
 * @param device Open, claimed connection.
 * @param onProgress Optional status callback for the UI.
 * @param fallbackName Name to show when object 23 could not be read.
 */
export async function readActivePreset(
  device: PodgoConnection,
  onProgress?: (message: string) => void,
  fallbackName = '',
): Promise<PresetReadResult> {
  try {
    return await readPresetWith(device, () => new PresetFlow(), '', onProgress);
  } catch (error) {
    const message = messageOf(error);
    if (!message.includes('aucune réponse')) {
      throw error;
    }
    onProgress?.(
      'Object 23 did not answer; reading the active preset body without it…',
    );
    return readPresetWith(
      device,
      () => PresetFlow.for_active_body(),
      fallbackName,
      onProgress,
    );
  }
}

/**
 * Read one Factory (`0`) or User (`1`) slot by its setlist position.
 *
 * Sends the target `{107, 108, 101}` parameters of an operation-4 open, as the
 * official editor does during a backup. The setlist supplies the name.
 *
 * @param device Open, claimed connection.
 * @param setlist `0` Factory, `1` User.
 * @param slot Slot position in the setlist (0-based).
 * @param name Preset name shown by the librarian.
 * @param onProgress Optional status callback for the UI.
 */
export function readPresetSlot(
  device: PodgoConnection,
  setlist: 0 | 1,
  slot: number,
  name: string,
  onProgress?: (message: string) => void,
): Promise<PresetReadResult> {
  return readPresetWith(
    device,
    () => PresetFlow.for_slot(setlist, slot),
    name,
    onProgress,
  );
}
