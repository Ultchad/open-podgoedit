// WebUSB transport for the POD Go vendor interface.
//
// This module performs discovery, claiming and bulk transfer only. It does not
// build or parse protocol frames: `ReadFlow` and `ParamWriteFlow` (WASM) own the
// protocol. Sending is explicit: `request` waits for the mirrored reply, while
// `send`/`readWrite` drive the write channel (used only after the user arms
// writes and confirms a change).

/** Line 6 USB vendor id. */
export const LINE6_VENDOR_ID = 0x0e41;
/** POD Go and POD Go Wireless product ids. */
export const PODGO_PRODUCT_IDS = [0x4247, 0x424b] as const;

const BULK_IN_BUFFER = 512;
const MAX_QUEUED_PACKETS = 64;
/** Event-channel frame: `0x03F0 → 0x1002`, never a response to a read. */
const EVENT_SRC = [0xf0, 0x03] as const;
const EVENT_DST = [0x02, 0x10] as const;
/** Response pair of the write channel: `0x03ED → 0x1080`. */
export const WRITE_RESPONSE = [0xed, 0x03, 0x80, 0x10] as const;
/** Response pair of the read channel: `0x03EF → 0x1001`. */
export const READ_RESPONSE = [0xef, 0x03, 0x01, 0x10] as const;

export class WebUsbUnavailableError extends Error {
  constructor() {
    super(
      "WebUSB n'est pas disponible dans ce navigateur. Utilise Chrome ou Edge, en HTTP local ou HTTPS.",
    );
    this.name = 'WebUsbUnavailableError';
  }
}

export class PodgoUsbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PodgoUsbError';
  }
}

/** A read timed out without a frame on the expected channel. */
export class UsbTimeoutError extends PodgoUsbError {
  constructor(message: string) {
    super(message);
    this.name = 'UsbTimeoutError';
  }
}

/**
 * The transport surface WASM flows need, independent of the platform.
 *
 * `PodgoUsbConnection` (WebUSB) and `PodgoAndroidUsbConnection` (native USB
 * host bridge) both implement it.
 */
export interface PodgoConnection {
  /** The pedal this link is open to, for diagnostics. */
  readonly info: PodgoDeviceInfo;
  discard(): void | Promise<void>;
  request(packet: Uint8Array, timeoutMs: number): Promise<Uint8Array>;
  send(packet: Uint8Array): Promise<void>;
  readWrite(timeoutMs: number): Promise<Uint8Array | null>;
  readRead(timeoutMs: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export interface PodgoDeviceInfo {
  productId: number;
  productName: string;
  interfaceNumber: number;
  endpointOut: number;
  endpointIn: number;
}

interface BulkPair {
  interfaceNumber: number;
  alternateSetting: number;
  endpointOut: number;
  endpointIn: number;
  vendorSpecific: boolean;
}

interface PendingRead {
  expected: number[] | null;
  resolve: (packet: Uint8Array) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/** Lower-case hex with a `0x` prefix, padded to `width` digits. */
export function hex(value: number, width = 4): string {
  return `0x${value.toString(16).padStart(width, '0')}`;
}

/** Expected response source/destination for one request. */
export function expectedChannel(packet: Uint8Array): number[] | null {
  if (packet.length < 8) {
    return null;
  }
  return [packet[6], packet[7], packet[4], packet[5]];
}

/** True when `packet` carries the mirrored pair in `expected`. */
export function channelMatches(
  packet: Uint8Array,
  expected: number[] | null,
): boolean {
  if (!expected || packet.length < 8) {
    return true;
  }
  return (
    packet[4] === expected[0] &&
    packet[5] === expected[1] &&
    packet[6] === expected[2] &&
    packet[7] === expected[3]
  );
}

/** True for the event-channel frames the pedal pushes asynchronously. */
export function isEventChannel(packet: Uint8Array): boolean {
  return (
    packet.length >= 8 &&
    packet[4] === EVENT_SRC[0] &&
    packet[5] === EVENT_SRC[1] &&
    packet[6] === EVENT_DST[0] &&
    packet[7] === EVENT_DST[1]
  );
}

function findBulkPair(configuration: USBConfiguration): BulkPair | null {
  const candidates: BulkPair[] = [];
  for (const iface of configuration.interfaces) {
    for (const alternate of iface.alternates) {
      const out = alternate.endpoints.find(
        (endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk',
      );
      const input = alternate.endpoints.find(
        (endpoint) => endpoint.direction === 'in' && endpoint.type === 'bulk',
      );
      if (!out || !input) {
        continue;
      }
      candidates.push({
        interfaceNumber: iface.interfaceNumber,
        alternateSetting: alternate.alternateSetting,
        endpointOut: out.endpointNumber,
        endpointIn: input.endpointNumber,
        vendorSpecific: alternate.interfaceClass === 0xff,
      });
    }
  }

  const vendorSpecific = candidates.filter((candidate) => candidate.vendorSpecific);
  const pool = vendorSpecific.length > 0 ? vendorSpecific : candidates;
  return (
    pool.find((candidate) => candidate.interfaceNumber === 0) ?? pool[0] ?? null
  );
}

/**
 * An open, claimed POD Go connection.
 *
 * A single reader loop owns the IN endpoint. Requests are serialized and
 * matched against the mirrored source/destination pair, so keepalives and
 * other channels are ignored instead of being mistaken for the response.
 */
export class PodgoUsbConnection implements PodgoConnection {
  private readonly queue: Uint8Array[] = [];
  private pending: PendingRead | null = null;
  private reading = true;
  private closed = false;
  private closedReason: Error | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly device: USBDevice,
    readonly info: PodgoDeviceInfo,
  ) {}

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && navigator.usb !== undefined;
  }

  static async requestDevice(): Promise<USBDevice> {
    const usb = navigator.usb;
    if (!usb) {
      throw new WebUsbUnavailableError();
    }
    return usb.requestDevice({
      filters: PODGO_PRODUCT_IDS.map((productId) => ({
        vendorId: LINE6_VENDOR_ID,
        productId,
      })),
    });
  }

  static async open(device: USBDevice): Promise<PodgoUsbConnection> {
    try {
      await device.open();
      if (!device.configuration) {
        const configuration =
          device.configurations.find(
            (candidate) => candidate.configurationValue === 1,
          ) ?? device.configurations[0];
        if (!configuration) {
          throw new PodgoUsbError(
            'aucune configuration USB exposée par le POD Go',
          );
        }
        await device.selectConfiguration(configuration.configurationValue);
      }

      const configuration = device.configuration;
      if (!configuration) {
        throw new PodgoUsbError(
          "la configuration USB n'est pas disponible après l'ouverture",
        );
      }
      const pair = findBulkPair(configuration);
      if (!pair) {
        throw new PodgoUsbError(
          'interface vendeur introuvable : aucun couple bulk IN/OUT sur le POD Go',
        );
      }

      await device.claimInterface(pair.interfaceNumber);
      if (pair.alternateSetting !== 0) {
        try {
          await device.selectAlternateInterface(
            pair.interfaceNumber,
            pair.alternateSetting,
          );
        } catch {
          // Alternate 0 is normally the only one; keep the claimed interface.
        }
      }
      for (const endpoint of [pair.endpointOut, pair.endpointIn]) {
        try {
          await device.clearHalt(endpoint);
        } catch {
          // clearHalt often rejects when the endpoint is not halted.
        }
      }

      const productId = device.productId;
      const info: PodgoDeviceInfo = {
        productId,
        productName:
          device.productName ??
          (productId === 0x424b ? 'POD Go Wireless' : 'POD Go'),
        interfaceNumber: pair.interfaceNumber,
        endpointOut: pair.endpointOut,
        endpointIn: pair.endpointIn,
      };
      return new PodgoUsbConnection(device, info);
    } catch (error) {
      try {
        await device.close();
      } catch {
        // Nothing else to do if the device never opened.
      }
      if (error instanceof PodgoUsbError) {
        throw error;
      }
      throw new PodgoUsbError(
        `ouverture USB impossible: ${toError(error).message}`,
      );
    }
  }

  /** Drop packets queued before the next request (handshake retry). */
  discard(): void {
    this.queue.length = 0;
  }

  /**
   * Write one request and wait for the matching response.
   *
   * The timeout rejects the waiter only; the reader loop keeps draining the
   * endpoint so a late packet cannot corrupt the next transfer.
   */
  request(packet: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    return this.withLock(async () => {
      if (!this.reading) {
        throw this.closedReason ?? new PodgoUsbError('connexion USB fermée');
      }
      const expected = expectedChannel(packet);
      const response = this.waitFor(expected, timeoutMs);
      try {
        const result = await this.device.transferOut(
          this.info.endpointOut,
          new Uint8Array(packet),
        );
        if (result.status !== 'ok') {
          this.cancelPending(
            new PodgoUsbError(`écriture USB refusée (${result.status})`),
          );
        }
      } catch (error) {
        this.cancelPending(
          new PodgoUsbError(
            `écriture USB impossible: ${toError(error).message}`,
          ),
        );
      }
      return response;
    });
  }

  /**
   * Send one write-channel frame without waiting for a response.
   *
   * The device answers a write command with several frames, so the caller
   * drains them with {@link readWrite} instead of matching a single reply.
   */
  send(packet: Uint8Array): Promise<void> {
    return this.withLock(async () => {
      if (!this.reading) {
        throw this.closedReason ?? new PodgoUsbError('connexion USB fermée');
      }
      this.startReader();
      const result = await this.device.transferOut(
        this.info.endpointOut,
        new Uint8Array(packet),
      );
      if (result.status !== 'ok') {
        throw new PodgoUsbError(`écriture USB refusée (${result.status})`);
      }
    });
  }

  /**
   * Wait for the next write-channel response, or `null` on timeout.
   *
   * Only frames mirrored from `0x03ED` to `0x1080` are returned; read-channel
   * leftovers and event notifications stay in the queue.
   */
  async readWrite(timeoutMs: number): Promise<Uint8Array | null> {
    try {
      return await this.withLock(() => this.waitFor([...WRITE_RESPONSE], timeoutMs));
    } catch (error) {
      if (error instanceof UsbTimeoutError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Wait for the next read-channel response, or `null` on timeout.
   *
   * Restore streams op-5 messages on the read channel (`0x1001 → 0x03EF`), so
   * the read flow and the restore flow share this reader. Event notifications
   * and write-channel frames stay queued for their own consumers.
   */
  async readRead(timeoutMs: number): Promise<Uint8Array | null> {
    try {
      return await this.withLock(() => this.waitFor([...READ_RESPONSE], timeoutMs));
    } catch (error) {
      if (error instanceof UsbTimeoutError) {
        return null;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.reading = false;
    if (this.pending) {
      this.cancelPending(new PodgoUsbError('connexion USB fermée'));
    }
    try {
      await this.device.releaseInterface(this.info.interfaceNumber);
    } catch {
      // The interface may already be released by a disconnect.
    }
    try {
      await this.device.close();
    } catch {
      // Closing an unplugged device can reject; it is already unusable.
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

  private waitFor(
    expected: number[] | null,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    if (this.pending) {
      return Promise.reject(
        new PodgoUsbError('une lecture USB est déjà en attente'),
      );
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const pending: PendingRead = {
        expected,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pending === pending) {
            this.pending = null;
          }
          reject(
            new UsbTimeoutError(
              `aucune réponse sur le canal attendu après ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs),
      };
      this.pending = pending;
      this.flushQueue();
      this.startReader();
    });
  }

  private cancelPending(reason: Error): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(reason);
  }

  private settle(pending: PendingRead, packet: Uint8Array): void {
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(packet);
  }

  private flushQueue(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const index = this.queue.findIndex((packet) =>
      channelMatches(packet, pending.expected),
    );
    if (index >= 0) {
      const [packet] = this.queue.splice(index, 1);
      this.settle(pending, packet);
    }
  }

  private deliver(packet: Uint8Array): void {
    const pending = this.pending;
    if (pending && channelMatches(packet, pending.expected)) {
      this.settle(pending, packet);
      return;
    }
    this.queue.push(packet);
    if (this.queue.length > MAX_QUEUED_PACKETS) {
      // Keep the response: drop the oldest event frame rather than the oldest
      // packet, so a burst of events cannot evict the reply.
      const eventIndex = this.queue.findIndex(isEventChannel);
      this.queue.splice(eventIndex >= 0 ? eventIndex : 0, 1);
    }
  }

  private startReader(): void {
    if (this.reader) {
      return;
    }
    this.reader = this.readLoop();
  }

  private reader: Promise<void> | null = null;

  private async readLoop(): Promise<void> {
    while (this.reading) {
      let result: USBInTransferResult;
      try {
        result = await this.device.transferIn(
          this.info.endpointIn,
          BULK_IN_BUFFER,
        );
      } catch (error) {
        this.fail(error);
        return;
      }
      if (!this.reading) {
        return;
      }
      if (result.status === 'stall') {
        try {
          await this.device.clearHalt(this.info.endpointIn);
        } catch {
          // Keep trying; a persistent stall will surface as a timeout.
        }
        continue;
      }
      if (result.status !== 'ok') {
        this.fail(
          new PodgoUsbError(`lecture USB impossible (${result.status})`),
        );
        return;
      }
      if (!result.data || result.data.byteLength === 0) {
        continue;
      }
      const view = result.data;
      this.deliver(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice(),
      );
    }
  }

  private fail(error: unknown): void {
    if (!this.reading) {
      return;
    }
    this.reading = false;
    this.closedReason = toError(error);
    this.cancelPending(this.closedReason);
  }
}

/** True when the user dismissed the WebUSB device picker. */
export function isUserCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

/**
 * Format an endpoint address with its direction bit.
 *
 * WebUSB reports `endpointNumber` without the direction bit, so a bulk IN
 * endpoint is `1` rather than `0x81`. Rebuilding the address keeps the display
 * aligned with `lsusb` and the USB specification.
 */
function endpointAddress(number: number, direction: 'in' | 'out'): string {
  const address = direction === 'in' ? number | 0x80 : number;
  return hex(address, 2);
}

export function describeDevice(info: PodgoDeviceInfo): string {
  return `${info.productName} — ${hex(LINE6_VENDOR_ID)}:${hex(info.productId)} · interface ${
    info.interfaceNumber
  } · OUT ${endpointAddress(info.endpointOut, 'out')} / IN ${endpointAddress(
    info.endpointIn,
    'in',
  )}`;
}
