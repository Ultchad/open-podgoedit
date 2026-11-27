// Transport for the Android shell's USB host bridge.
//
// The native app injects `window.podgoAndroidUsb` with the same four
// primitives WebUSB exposes for our vendor interface, so the POD Go protocol
// (WASM flows) is unchanged. A single native reader thread owns the IN
// endpoint and appends packets to one queue; the page pulls from it.
//
// Binary data crosses the bridge as base64 so the JNI string channel stays
// lossless.

import { QueuedPodgoConnection, type NativeUsbBridge } from './native';
import {
  PODGO_PRODUCT_IDS,
  PodgoUsbError,
  type PodgoDeviceInfo,
  toError,
} from './podgoUsb';

/**
 * Methods the Android `WebView` exposes after `addJavascriptInterface`.
 *
 * Each call may block in `WebView`'s JS bridge for as long as the native side
 * waits, so timeouts are kept short and packets are batched.
 */
export interface PodgoAndroidUsbBridge extends NativeUsbBridge {
  /** `true` when the Android app injected the bridge. */
  readonly present?: boolean;
  /**
   * Shell adapter version (see `src/shell.ts`). Older packages omit it, which
   * the startup handshake reports as outdated.
   */
  readonly apiVersion?: number | (() => number);
  /** Open the first POD Go on the USB bus; resolves to `description (0xPID)`. */
  open(): Promise<string>;
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

/**
 * One open Android session with the same surface as the WebUSB connection,
 * so callers never branch on the platform.
 */
export class PodgoAndroidUsbConnection extends QueuedPodgoConnection {
  private constructor(info: PodgoDeviceInfo) {
    super(info, () => {
      const bridge = androidUsbBridge();
      if (!bridge) {
        throw new PodgoUsbError('USB bridge is no longer available');
      }
      return bridge;
    });
  }

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
}
