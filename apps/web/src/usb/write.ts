// Device-write paths: one `set_param` (operation 30) or one `save_preset`
// (operation 71) over the write channel.
//
// The Rust flows own the handshake, the frame and the status decoding; this
// module only moves bytes and retries. Both entry points are called only after
// the page has armed writes and the user confirmed the action. A save also
// requires a destination-slot backup, handled by the page.
//
// `set_param` edits the preset in RAM; `save_preset` writes its metadata
// (setlist, slot and name) to the pedal's User list.

import { ModelWriteFlow, ParamWriteFlow, SavePresetFlow } from '../wasmClient';
import { PodgoUsbError, type PodgoConnection } from './podgoUsb';

/** The pedal often ignores the first write handshake after a read. */
const MAX_WRITE_ATTEMPTS = 5;
/** Handshake replays before the whole flow is restarted. */
const MAX_HANDSHAKE_RETRIES = 5;
const BACKOFF_BASE_MS = 300;
/** Empty 250 ms drain reads accepted after the command before giving up. */
const DRAIN_READS = 8;
/** Time given to late read-channel replies before the handshake starts. */
const READ_SETTLE_MS = 300;

let transactionCounter = 2000;

/** One `set_param` request: raw chain index, parameter position and raw value. */
export interface ParamWriteRequest {
  /** Raw chain index (input is 0), as stored in key 98. */
  block: number;
  /** Catalog parameter position, as stored in key 28. */
  param: number;
  /** Raw DSP value: 0..1 for knobs, display units for other ranges. */
  value: number;
}

/** One `save_preset` request. */
export interface SavePresetRequest {
  /** Destination slot in the User setlist (0-based). */
  slot: number;
  /** Visible name, 1..=16 printable ASCII bytes. */
  name: string;
}

/** One `set_model` request: raw chain index plus the catalog's on-wire id. */
export interface ModelWriteRequest {
  /** Raw chain index (input is 0), as stored in key 98. */
  block: number;
  /** Catalog on-wire model id, stored in key 25. */
  wireId: number;
  /** Existing block flag, stored in key 23. */
  noSnapshotBypass: boolean;
}

export interface WriteResult {
  /** Handshake attempts used before the device answered. */
  attempts: number;
  /** Command frame sent, for the diagnostics log. */
  frame: Uint8Array;
}

/** Common surface of both generated WASM write flows. */
interface WriteFlow {
  phase(): string;
  timeout_ms(): number;
  next_request(): Uint8Array | undefined;
  accept_response(bytes: Uint8Array): void;
  restart_handshake(): void;
  is_finished(): boolean;
  result_json(): string | undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Send one write command over the write channel and wait for its status.
 *
 * Hardware log of 2026-11-13 (POD Go Wireless, fw 2.50): the first handshake
 * after a read session is ignored, exactly like the read channel. The retry
 * therefore replays the four handshake packets in place before restarting the
 * whole flow.
 *
 * # Errors
 *
 * Throws when the handshake never completes, the device reports a non-zero
 * status, or no status frame arrives.
 */
async function driveWriteFlow(
  device: PodgoConnection,
  makeFlow: () => WriteFlow,
  label: string,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    // Queue leftovers of the read session first: `discard` only drops what is
    // already buffered, and a late read reply must not be taken for a write ack.
    device.discard();
    await delay(READ_SETTLE_MS);
    device.discard();
    let flow: WriteFlow;
    try {
      flow = makeFlow();
    } catch (error) {
      throw new PodgoUsbError(messageOf(error));
    }
    let sent: Uint8Array | null = null;
    let handshakeRetries = 0;

    try {
      while (!flow.is_finished()) {
        const frame = flow.next_request();
        if (!frame) {
          throw new PodgoUsbError(
            `flux ${label} bloqué en phase « ${flow.phase()} »`,
          );
        }
        await device.send(frame);
        sent = frame;

        if (flow.phase() === 'command') {
          // The device answers with one or more bare acknowledgements, then a
          // framed echo carrying the status. Keep reading until it arrives.
          let empty = 0;
          while (!flow.is_finished() && empty < DRAIN_READS) {
            const response = await device.readWrite(flow.timeout_ms());
            if (!response) {
              empty += 1;
              continue;
            }
            empty = 0;
            flow.accept_response(response);
          }
          if (!flow.is_finished()) {
            throw new PodgoUsbError(
              `aucun statut du pédalier après la commande ${label}`,
            );
          }
        } else {
          let response = await device.readWrite(flow.timeout_ms());
          while (!response) {
            if (handshakeRetries >= MAX_HANDSHAKE_RETRIES) {
              throw new PodgoUsbError(
                `aucune réponse au handshake ${label}`,
              );
            }
            handshakeRetries += 1;
            onProgress?.(
              `${label} : handshake muet (${handshakeRetries}/${MAX_HANDSHAKE_RETRIES}), nouvelle tentative…`,
            );
            await delay(BACKOFF_BASE_MS * 2 ** (handshakeRetries - 1));
            device.discard();
            flow.restart_handshake();
            const replay = flow.next_request();
            if (!replay) {
              throw new PodgoUsbError(
                `handshake ${label} impossible à rejouer en phase « ${flow.phase()} »`,
              );
            }
            await device.send(replay);
            response = await device.readWrite(flow.timeout_ms());
          }
          flow.accept_response(response);
        }
      }
    } catch (error) {
      lastError = error;
      if (attempt < MAX_WRITE_ATTEMPTS) {
        onProgress?.(
          `${label} : tentative ${attempt}/${MAX_WRITE_ATTEMPTS} échouée, nouvelle tentative…`,
        );
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
      continue;
    }

    const result = flow.result_json();
    if (!result) {
      throw new PodgoUsbError(
        `le flux ${label} s'est arrêté sans résultat`,
      );
    }
    const parsed = JSON.parse(result) as { ok?: boolean; message?: string };
    if (parsed.ok !== true) {
      throw new PodgoUsbError(parsed.message ?? 'le pédalier a refusé la commande');
    }
    if (!sent) {
      throw new PodgoUsbError(`aucune commande ${label} n'a été envoyée`);
    }
    return { attempts: attempt, frame: sent };
  }

  throw new PodgoUsbError(
    `${label} impossible après ${MAX_WRITE_ATTEMPTS} tentatives: ${messageOf(
      lastError,
    )}`,
  );
}

/**
 * Send one `set_param` command over the write channel.
 */
export async function writeParam(
  device: PodgoConnection,
  request: ParamWriteRequest,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () => {
      try {
        return new ParamWriteFlow(
          request.block,
          request.param,
          request.value,
          (transactionCounter += 1),
        );
      } catch (error) {
        throw new PodgoUsbError(
          `paramètre non écrivable: ${messageOf(error)}`,
        );
      }
    },
    'Écriture',
    onProgress,
  );
}

/**
 * Send one `set_model` command over the write channel.
 *
 * The pedal loads the model with its own defaults and reports them on the
 * event channel. The layout comes from the MIT reference's annotated capture
 * (`change-pedal-from-app.pcapng`, packet 35) and is not yet validated on
 * hardware in this repository.
 */
export async function writeModel(
  device: PodgoConnection,
  request: ModelWriteRequest,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () =>
      new ModelWriteFlow(
        request.block,
        request.wireId,
        request.noSnapshotBypass,
        (transactionCounter += 1),
      ),
    'Changement de modèle',
    onProgress,
  );
}

/**
 * Save the active preset to a User-setlist slot (operation 71).
 *
 * The command is metadata-only: it stores the active preset under `slot` with
 * `name` and does not upload the preset body. The caller must read and keep a
 * backup of the destination slot first.
 */
export async function savePreset(
  device: PodgoConnection,
  request: SavePresetRequest,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () => {
      try {
        return new SavePresetFlow(
          1,
          request.slot,
          request.name,
          (transactionCounter += 1),
        );
      } catch (error) {
        throw new PodgoUsbError(
          `sauvegarde impossible: ${messageOf(error)}`,
        );
      }
    },
    'Sauvegarde',
    onProgress,
  );
}
