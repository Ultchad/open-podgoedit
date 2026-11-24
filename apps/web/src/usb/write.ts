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

import {
  BypassFlow,
  ChainWriteFlow,
  ModelWriteFlow,
  ParamWriteFlow,
  RecallFlow,
  RemoveEffectFlow,
  SavePresetFlow,
  SnapshotFlow,
} from '../wasmClient';
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

/** One `recall_preset` request (operation 20). */
export interface RecallRequest {
  /** Setlist: 0 = Factory, 1 = User. */
  setlist: 0 | 1;
  /** Slot in that setlist (0-based). */
  slot: number;
}

/** One bypass request (operation 41). */
export interface BypassRequest {
  /** Raw chain index (input is 0). */
  block: number;
  /** `true` leaves the effect on; `false` bypasses it. */
  enabled: boolean;
}

/** One remove-effect request (operations 28 and 78). */
export interface RemoveEffectRequest {
  /** Raw chain index (input is 0). */
  block: number;
}

/** One whole-chain upload (operation 21). */
export interface ChainWriteRequest {
  /** Complete `l6-helix` container to apply. */
  blob: Uint8Array;
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

/**
 * Flow whose first command chains a follow-up (`remove`: op 28 then op 78).
 *
 * The page has to stop draining the channel once the current command's status
 * arrives, otherwise it waits for a second status that never comes.
 */
interface ChainedWriteFlow extends WriteFlow {
  status_received(): boolean;
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
          let status = false;
          while (!flow.is_finished() && !status && empty < DRAIN_READS) {
            const response = await device.readWrite(flow.timeout_ms());
            if (!response) {
              empty += 1;
              continue;
            }
            empty = 0;
            flow.accept_response(response);
            // A removal chains op 78 after op 28: once this command's status
            // arrived, the follow-up frame must be sent instead of waiting.
            status =
              'status_received' in flow
                ? (flow as ChainedWriteFlow).status_received()
                : flow.is_finished();
          }
          if (!flow.is_finished() && !status) {
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

/**
 * Recall a stored preset (operation 20).
 *
 * This is what turns a preset switch into an audible change: it loads the slot
 * into the pedal's edit buffer. The status is `1` in the captured editor; the
 * flow accepts `0` as well.
 */
export async function recallPreset(
  device: PodgoConnection,
  request: RecallRequest,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () => {
      try {
        return new RecallFlow(
          request.setlist,
          request.slot,
          (transactionCounter += 1),
        );
      } catch (error) {
        throw new PodgoUsbError(`rappel impossible: ${messageOf(error)}`);
      }
    },
    'Rappel du preset',
    onProgress,
  );
}

/**
 * Recall one snapshot on the pedal (operation 88).
 *
 * Captured from POD Go Edit in `podgo-snapshots.pcapng` (2026-11-24): the
 * pedal answers status `0`, then sends the `105:42` and `105:46` snapshot
 * notifications. The index is 0-based.
 */
export async function recallSnapshot(
  device: PodgoConnection,
  index: number,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () => {
      try {
        return SnapshotFlow.recall(index, (transactionCounter += 1));
      } catch (error) {
        throw new PodgoUsbError(
          `rappel de snapshot impossible: ${messageOf(error)}`,
        );
      }
    },
    `Rappel du snapshot ${index + 1}`,
    onProgress,
  );
}

/**
 * Rename one snapshot (operation 89).
 *
 * `name` is at most 10 printable ASCII bytes; the encoder appends the NUL the
 * pedal stores. The pedal answers status `0` and the `105:43` notification.
 * The label is applied live; Save (op 71) is what stores it in the setlist.
 */
export async function renameSnapshot(
  device: PodgoConnection,
  request: { index: number; name: string },
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () => {
      try {
        return SnapshotFlow.rename(
          request.index,
          request.name,
          (transactionCounter += 1),
        );
      } catch (error) {
        throw new PodgoUsbError(
          `renommage de snapshot impossible: ${messageOf(error)}`,
        );
      }
    },
    `Renommage du snapshot ${request.index + 1}`,
    onProgress,
  );
}

/**
 * Set one snapshot's LED palette entry (operation 98).
 *
 * `palette` is `0` Auto … `11` Off. The pedal answers status `0` and the
 * `105:48` notification.
 */
export async function setSnapshotLedColor(
  device: PodgoConnection,
  request: { index: number; palette: number },
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () => {
      try {
        return SnapshotFlow.ledColor(
          request.index,
          request.palette,
          (transactionCounter += 1),
        );
      } catch (error) {
        throw new PodgoUsbError(
          `couleur de snapshot impossible: ${messageOf(error)}`,
        );
      }
    },
    `Couleur du snapshot ${request.index + 1}`,
    onProgress,
  );
}

/**
 * Assign one parameter to the Snapshots controller (operation 37).
 *
 * `block` is the raw chain index and `param` the catalog position. The pedal
 * answers status `0` followed by an op-34 controller notification; only the
 * assigning direction has a capture.
 */
export async function assignSnapshotParam(
  device: PodgoConnection,
  request: { block: number; param: number; assigned: boolean },
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () =>
      SnapshotFlow.param(
        request.block,
        request.param,
        request.assigned,
        (transactionCounter += 1),
      ),
    `Contrôle snapshots du block ${request.block}`,
    onProgress,
  );
}

/**
 * Set one block's bypass state (operation 41).
 *
 * Key `59` carries the enabled flag (`false` = bypassed). The pedal echoes the
 * new state as an op-49 notification.
 */
export async function writeBypass(
  device: PodgoConnection,
  request: BypassRequest,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () =>
      new BypassFlow(
        request.block,
        request.enabled,
        (transactionCounter += 1),
      ),
    'Contournement',
    onProgress,
  );
}

/**
 * Remove one effect (operations 28 then 78).
 *
 * The two commands share one write session; the Rust flow builds the second
 * one after the first status and advances the cursor from that status.
 */
export async function removeEffect(
  device: PodgoConnection,
  request: RemoveEffectRequest,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  return driveWriteFlow(
    device,
    () => new RemoveEffectFlow(request.block, (transactionCounter += 1)),
    'Suppression de l’effet',
    onProgress,
  );
}

/**
 * Upload a whole preset body (operation 21).
 *
 * Reordering is only possible by uploading the complete chain, so the caller
 * must pass the `l6-helix` container to apply. That container should come from
 * a fresh object-22 read, with the move already applied by the Rust domain
 * layer, so the upload matches the pedal's current edit buffer.
 *
 * Unlike a single command, the pedal answers while the stream is still being
 * written. The flow is therefore driven frame by frame, with one response read
 * after each frame; the status advances the cursor and bare acks are ignored.
 */
export async function writeChain(
  device: PodgoConnection,
  request: ChainWriteRequest,
  onProgress?: (message: string) => void,
): Promise<WriteResult> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    device.discard();
    await delay(READ_SETTLE_MS);
    device.discard();

    let flow: ChainWriteFlow;
    try {
      flow = new ChainWriteFlow(request.blob, (transactionCounter += 1));
    } catch (error) {
      throw new PodgoUsbError(`écriture de chaîne impossible: ${messageOf(error)}`);
    }

    let lastFrame: Uint8Array | null = null;
    try {
      while (!flow.is_finished()) {
        const frame = flow.next_request();
        if (frame) {
          await device.send(frame);
          lastFrame = frame;
          onProgress?.(
            `Envoi de la chaîne… ${flow.describe()}`,
          );
        }
        while (flow.expects_response() && !flow.is_finished()) {
          const response = await device.readWrite(flow.timeout_ms());
          if (response === null) {
            flow.accept_timeout();
          } else {
            flow.accept_response(response);
          }
        }
      }

      const result = flow.result_json();
      if (!result) {
        throw new PodgoUsbError('le flux de chaîne s’est arrêté sans résultat');
      }
      const parsed = JSON.parse(result) as { ok?: boolean; message?: string };
      if (parsed.ok !== true) {
        throw new PodgoUsbError(
          parsed.message ?? 'le pédalier a refusé la chaîne',
        );
      }
      if (!lastFrame) {
        throw new PodgoUsbError('aucune trame de chaîne n’a été envoyée');
      }
      return { attempts: attempt, frame: lastFrame };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_WRITE_ATTEMPTS) {
        onProgress?.(
          `Chaîne : tentative ${attempt}/${MAX_WRITE_ATTEMPTS} échouée, nouvelle tentative…`,
        );
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    } finally {
      flow.free();
    }
  }

  throw new PodgoUsbError(
    `écriture de chaîne impossible après ${MAX_WRITE_ATTEMPTS} tentatives: ${messageOf(
      lastError,
    )}`,
  );
}
