// Shared plumbing for native USB host bridges.
//
// The Android shell and the Tauri desktop shell expose the same four
// primitives: open, close, write, read and discard. A native reader owns the
// IN endpoint and queues packets, so this class matches replies against the
// mirrored channel exactly like the WebUSB connection does.
//
// Binary data crosses both bridges as base64.

import {
  channelMatches,
  expectedChannel,
  isEventChannel,
  isEventData,
  PodgoUsbError,
  type PodgoConnection,
  type PodgoDeviceInfo,
  toError,
  UsbTimeoutError,
  WRITE_RESPONSE,
  READ_RESPONSE,
} from './podgoUsb';

const MAX_QUEUED_PACKETS = 64;

/** Primitives a native shell exposes after its device is open. */
export interface NativeUsbBridge {
  /** Release the interface and detach from the device. */
  close(): Promise<void>;
  /** Queue one OUT transfer (base64) and resolve once it is delivered. */
  write(data: string): Promise<void>;
  /** Drop packets queued by the native reader. */
  discard(): Promise<void>;
  /** Wait up to `timeoutMs` for the next IN packet, or resolve to `null`. */
  read(timeoutMs: number): Promise<string | null>;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * One open native session with the same surface as the WebUSB connection, so
 * callers never branch on the platform.
 */
export abstract class QueuedPodgoConnection implements PodgoConnection {
  private queue: Uint8Array[] = [];
  private lock: Promise<unknown> = Promise.resolve();

  protected constructor(
    readonly info: PodgoDeviceInfo,
    private readonly bridge: () => NativeUsbBridge,
  ) {}

  /** Drop packets buffered before the next request (handshake retry). */
  async discard(): Promise<void> {
    await this.withLock(async () => {
      this.queue = [];
      try {
        await this.bridge().discard();
      } catch {
        // A detached device is already empty.
      }
    });
  }

  /**
   * Write one request and wait for the matching response.
   *
   * Matching mirrors the WebUSB reader: the first non-matching packet keeps
   * waiting, and a silence of `timeoutMs` rejects with a timeout.
   */
  async request(packet: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    return this.withLock(async () => {
      const expected = expectedChannel(packet);
      await this.writePacket(packet);
      const response = await this.readMatching(expected, timeoutMs);
      if (!response) {
        throw new UsbTimeoutError(
          `no response on the expected channel after ${timeoutMs} ms`,
        );
      }
      return response;
    });
  }

  /** Send one write-channel frame without waiting for a response. */
  async send(packet: Uint8Array): Promise<void> {
    return this.withLock(() => this.writePacket(packet));
  }

  /** Next write-channel response (`0x03ED → 0x1080`), or `null`. */
  async readWrite(timeoutMs: number): Promise<Uint8Array | null> {
    return this.withLock(() =>
      this.readMatching([...WRITE_RESPONSE], timeoutMs),
    );
  }

  /** Next read-channel response (`0x03EF → 0x1001`), or `null`. */
  async readRead(timeoutMs: number): Promise<Uint8Array | null> {
    return this.withLock(() => this.readMatching([...READ_RESPONSE], timeoutMs));
  }

  /**
   * Poll the event channel once and acknowledge every data frame.
   *
   * Non-event packets are queued for the next operation instead of being
   * dropped, and a control frame (the poll echo) ends the burst.
   */
  async pollEvents(
    poll: Uint8Array,
    timeoutMs: number,
    ack: (frame: Uint8Array) => Uint8Array | null,
  ): Promise<void> {
    await this.withLock(async () => {
      // Frames may already be queued by a normal request reader. Keep the
      // read/write responses, still deliver data frames a previous poll left
      // in flight, and drop the stale control frames.
      const queued = this.queue;
      this.queue = [];
      for (const frame of queued) {
        if (!isEventChannel(frame)) {
          this.queue.push(frame);
        } else if (isEventData(frame)) {
          const acknowledgement = ack(frame);
          if (acknowledgement) {
            await this.writePacket(acknowledgement);
          }
        }
      }

      await this.writePacket(poll);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return;
        }
        let text: string | null;
        try {
          text = await this.bridge().read(remaining);
        } catch (error) {
          throw new PodgoUsbError(`USB read failed: ${toError(error).message}`);
        }
        if (text === null) {
          return;
        }
        for (const part of text.split('\n')) {
          if (part.length === 0) {
            continue;
          }
          const packet = decodeBase64(part);
          if (!isEventChannel(packet)) {
            this.enqueue(packet);
            continue;
          }
          if (!isEventData(packet)) {
            if (packet.length > 11 && packet[11] === 0x9d) {
              // A plain bridge acknowledges an event command with a bare
              // 0x9d frame. Drain the burst at a short cadence, then end it
              // once the bridge reports nothing more.
              continue;
            }
            return;
          }
          const acknowledgement = ack(packet);
          if (acknowledgement) {
            await this.writePacket(acknowledgement);
          }
        }
      }
    });
  }

  /**
   * Send one event poll and report whether the bridge delivered an answer.
   *
   * A bridge that acknowledges writes but never fills its read queue cannot
   * be watched live, and finding out here keeps the failure out of the poll
   * loop.
   *
   * A bridge whose native side mirrors each packet once (one reply per
   * request) leaves the handshake echoes queued; it answers the poll with one
   * of those instead of the device's own `cmd=0x10` echo. That proves it
   * cannot carry the event channel, so live sync stays off and the log points
   * at manual reads. A real pedal always answers with its own poll echo.
   */
  async probeEvents(
    poll: Uint8Array,
    timeoutMs: number,
    ack: (frame: Uint8Array) => Uint8Array | null,
  ): Promise<boolean> {
    return this.withLock(async () => {
      if (this.queue.some(isEventChannel)) {
        return false;
      }
      await this.writePacket(poll);
      try {
        const text = await this.bridge().read(timeoutMs);
        if (text === null) {
          return false;
        }
        for (const part of text.split('\n')) {
          if (part.length === 0) {
            continue;
          }
          const packet = decodeBase64(part);
          if (!isEventChannel(packet)) {
            this.enqueue(packet);
            continue;
          }
          if (!isEventData(packet)) {
            return packet.length > 11 && packet[11] === 0x10;
          }
          const acknowledgement = ack(packet);
          if (acknowledgement) {
            await this.writePacket(acknowledgement);
          }
          // A pushed notification proves the channel is live.
          return true;
        }
        return false;
      } catch (error) {
        throw new PodgoUsbError(`USB read failed: ${toError(error).message}`);
      }
    });
  }

  async close(): Promise<void> {
    await this.withLock(async () => {
      this.queue = [];
      try {
        await this.bridge().close();
      } catch {
        // Unplugging already detached the device.
      }
    });
  }

  private async writePacket(packet: Uint8Array): Promise<void> {
    try {
      await this.bridge().write(encodeBase64(packet));
    } catch (error) {
      throw new PodgoUsbError(
        `USB write failed: ${toError(error).message}`,
      );
    }
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lock.then(operation, operation);
    this.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Return the next packet matching `expected`, waiting until the deadline.
   *
   * `expected === null` means "any packet" (handshake probing).
   */
  private async readMatching(
    expected: number[] | null,
    timeoutMs: number,
  ): Promise<Uint8Array | null> {
    const bridge = this.bridge();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = this.queue.findIndex((packet) =>
        channelMatches(packet, expected),
      );
      if (queued >= 0) {
        return this.queue.splice(queued, 1)[0];
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      let text: string | null;
      try {
        text = await bridge.read(remaining);
      } catch (error) {
        throw new PodgoUsbError(`USB read failed: ${toError(error).message}`);
      }
      if (text === null) {
        return null;
      }
      for (const part of text.split('\n')) {
        if (part.length === 0) {
          continue;
        }
        // Event data frames are kept for the live-sync poll instead of being
        // dropped: the pedal pushes them on the same IN endpoint.
        this.enqueue(decodeBase64(part));
      }
    }
  }

  private enqueue(packet: Uint8Array): void {
    this.queue.push(packet);
    if (this.queue.length > MAX_QUEUED_PACKETS) {
      this.queue.shift();
    }
  }
}
