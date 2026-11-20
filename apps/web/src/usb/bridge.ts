// Transport for the Android shell's USB host bridge.
//
// The native app injects `window.podgoAndroidUsb` with the same four
// primitives WebUSB exposes for our vendor interface, so the POD Go protocol
// (WASM flows) is unchanged. A single native reader thread owns the IN
// endpoint and appends packets to one queue; the page pulls from it.
//
// Binary data crosses the bridge as base64 so the JNI string channel stays
// lossless.

import {
  channelMatches,
  expectedChannel,
  isEventChannel,
  PODGO_PRODUCT_IDS,
  PodgoUsbError,
  type PodgoDeviceInfo,
  toError,
  UsbTimeoutError,
  WRITE_RESPONSE,
  READ_RESPONSE,
} from './podgoUsb';

const MAX_QUEUED_PACKETS = 64;

/**
 * Methods the Android `WebView` exposes after `addJavascriptInterface`.
 *
 * Each call may block in `WebView`'s JS bridge for as long as the native side
 * waits, so timeouts are kept short and packets are batched.
 */
export interface PodgoAndroidUsbBridge {
  /** `true` when the Android app injected the bridge. */
  readonly present?: boolean;
  /** Open the first POD Go on the USB bus; resolves to `description (0xPID)`. */
  open(): Promise<string>;
  /** Release the interface and detach from the device. */
  close(): Promise<void>;
  /** Queue one OUT transfer (base64) and resolve once it is delivered. */
  write(data: string): Promise<void>;
  /** Drop packets queued by the native reader. */
  discard(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the next IN packet.
   *
   * Resolves to one base64 packet, to `"\n"`-joined base64 packets when
   * several arrived together, or to `null` on timeout. Event frames are
   * skipped natively so a pending reply is never replaced by a notification.
   */
  read(timeoutMs: number): Promise<string | null>;
}

declare global {
  interface Window {
    podgoAndroidUsb?: PodgoAndroidUsbBridge;
  }
}

/** The bridge on `window`, or `null` outside the Android shell. */
export function androidUsbBridge(): PodgoAndroidUsbBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = window.podgoAndroidUsb;
  return bridge && typeof bridge.open === 'function' ? bridge : null;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * One open Android session with the same surface as the WebUSB connection,
 * so callers never branch on the platform.
 */
export class PodgoAndroidUsbConnection {
  private queue: Uint8Array[] = [];

  private constructor(readonly info: PodgoDeviceInfo) {}

  static isAvailable(): boolean {
    return androidUsbBridge() !== null;
  }

  /** Open the pedal through the native USB host (the app owns permission). */
  static async open(): Promise<PodgoAndroidUsbConnection> {
    const bridge = androidUsbBridge();
    if (!bridge) {
      throw new PodgoUsbError('USB bridge is not available in this app');
    }
    let description: string;
    try {
      description = await bridge.open();
    } catch (error) {
      throw new PodgoUsbError(
        `could not open the POD Go over USB: ${toError(error).message}`,
      );
    }
    const match = /0x([0-9a-f]{4})/i.exec(description);
    const productId = match
      ? Number.parseInt(match[1], 16)
      : PODGO_PRODUCT_IDS[0];
    return new PodgoAndroidUsbConnection({
      productId,
      productName: description.replace(/\s*\(0x[0-9a-f]{4}\)\s*$/i, ''),
      // The native side claims the vendor interface; endpoints stay internal.
      interfaceNumber: 0,
      endpointOut: 0,
      endpointIn: 0,
    });
  }

  /** Drop packets buffered before the next request (handshake retry). */
  async discard(): Promise<void> {
    this.queue = [];
    try {
      await this.bridge().discard();
    } catch {
      // A detached device is already empty.
    }
  }

  /**
   * Write one request and wait for the matching response.
   *
   * Matching mirrors the WebUSB reader: the first non-matching packet keeps
   * waiting, and a silence of `timeoutMs` rejects with a timeout.
   */
  async request(packet: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    const expected = expectedChannel(packet);
    await this.send(packet);
    const response = await this.readMatching(expected, timeoutMs);
    if (!response) {
      throw new UsbTimeoutError(
        `no response on the expected channel after ${timeoutMs} ms`,
      );
    }
    return response;
  }

  /** Send one write-channel frame without waiting for a response. */
  async send(packet: Uint8Array): Promise<void> {
    const bridge = this.bridge();
    try {
      await bridge.write(encodeBase64(packet));
    } catch (error) {
      throw new PodgoUsbError(
        `USB write failed: ${toError(error).message}`,
      );
    }
  }

  /** Next write-channel response (`0x03ED → 0x1080`), or `null`. */
  async readWrite(timeoutMs: number): Promise<Uint8Array | null> {
    return this.readMatching([...WRITE_RESPONSE], timeoutMs);
  }

  /** Next read-channel response (`0x03EF → 0x1001`), or `null`. */
  async readRead(timeoutMs: number): Promise<Uint8Array | null> {
    return this.readMatching([...READ_RESPONSE], timeoutMs);
  }

  async close(): Promise<void> {
    this.queue = [];
    try {
      await this.bridge().close();
    } catch {
      // Unplugging already detached the device.
    }
  }

  private bridge(): PodgoAndroidUsbBridge {
    const bridge = androidUsbBridge();
    if (!bridge) {
      throw new PodgoUsbError('USB bridge is no longer available');
    }
    return bridge;
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
        const packet = decodeBase64(part);
        if (!isEventChannel(packet)) {
          this.enqueue(packet);
        }
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
