// Transport for the Tauri desktop shell's native libusb bridge.
//
// The Rust side claims the Line 6 vendor interface and exposes the same four
// primitives the Android bridge does, so the POD Go protocol (WASM flows) and
// the gated write paths are unchanged. Binary data crosses the command
// boundary as base64.

import { desktopCore } from '../desktop';
import { QueuedPodgoConnection } from './native';
import {
  PodgoUsbError,
  type PodgoDeviceInfo,
  toError,
} from './podgoUsb';

/** Tauri commands implemented by `apps/desktop/src-tauri/src/usb.rs`. */
interface DesktopUsbCommands {
  open(): Promise<PodgoDeviceInfo>;
  close(): Promise<void>;
  discard(): Promise<void>;
  write(base64: string): Promise<void>;
  read(timeoutMs: number): Promise<string | null>;
}

/**
 * One open desktop session with the same surface as the WebUSB connection.
 *
 * The native reader thread already drops event-channel frames, but the shared
 * matcher still filters them so both native bridges behave identically.
 */
export class PodgoDesktopUsbConnection extends QueuedPodgoConnection {
  private constructor(
    info: PodgoDeviceInfo,
    commands: DesktopUsbCommands,
  ) {
    super(info, () => commands);
  }

  static isAvailable(): boolean {
    return desktopCore() !== null;
  }

  /** Open the first POD Go through libusb (no picker: the app owns access). */
  static async open(): Promise<PodgoDesktopUsbConnection> {
    const core = desktopCore();
    if (!core) {
      throw new PodgoUsbError('USB bridge is not available in this app');
    }
    const commands: DesktopUsbCommands = {
      open: () => core.invoke<PodgoDeviceInfo>('usb_open'),
      close: () => core.invoke<void>('usb_close'),
      discard: () => core.invoke<void>('usb_discard'),
      write: (base64) => core.invoke<void>('usb_write', { data: base64 }),
      read: (timeoutMs) =>
        core.invoke<string | null>('usb_read', { timeoutMs }),
    };
    try {
      const info = await commands.open();
      return new PodgoDesktopUsbConnection(info, commands);
    } catch (error) {
      throw new PodgoUsbError(
        `could not open the POD Go over USB: ${toError(error).message}`,
      );
    }
  }
}
