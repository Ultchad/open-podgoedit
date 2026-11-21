// Platform-agnostic access to the POD Go USB link.
//
// The browser uses WebUSB; the Android shell injects a native USB-host bridge
// (`window.podgoAndroidUsb`), and the Tauri desktop shell exposes Rust libusb
// commands (`window.__TAURI__`). All three implement `PodgoConnection`, so
// the rest of the app never branches on the transport.
import { PodgoAndroidUsbConnection } from './bridge';
import { PodgoDesktopUsbConnection } from './desktop';
import {
  PodgoUsbConnection,
  WebUsbUnavailableError,
  type PodgoConnection,
  type PodgoDeviceInfo,
} from './podgoUsb';

/** True when the current platform can reach the pedal at all. */
export function usbLinkSupported(): boolean {
  return (
    PodgoUsbConnection.isSupported() ||
    PodgoAndroidUsbConnection.isAvailable() ||
    PodgoDesktopUsbConnection.isAvailable()
  );
}

/** True when the native Android bridge is backing the USB link. */
export function runningOnAndroidShell(): boolean {
  return PodgoAndroidUsbConnection.isAvailable();
}

/** True when the Tauri desktop shell is backing the USB link. */
export function runningOnDesktopShell(): boolean {
  return PodgoDesktopUsbConnection.isAvailable();
}

/**
 * Select the device.
 *
 * In a native shell the app owns USB access, so no picker runs and the pedal
 * is opened directly. In the browser this returns the `USBDevice` the user
 * picked, for {@link connectToPickerResult}.
 */
export async function requestPedal(): Promise<
  USBDevice | PodgoAndroidUsbConnection | PodgoDesktopUsbConnection
> {
  if (PodgoAndroidUsbConnection.isAvailable()) {
    return PodgoAndroidUsbConnection.open();
  }
  if (PodgoDesktopUsbConnection.isAvailable()) {
    return PodgoDesktopUsbConnection.open();
  }
  if (!PodgoUsbConnection.isSupported()) {
    throw new WebUsbUnavailableError();
  }
  return PodgoUsbConnection.requestDevice();
}

/** Claim the vendor interface (a native session is already open). */
export async function connectToPickerResult(
  device: USBDevice | PodgoAndroidUsbConnection | PodgoDesktopUsbConnection,
): Promise<PodgoConnection> {
  if (device instanceof PodgoAndroidUsbConnection) {
    return device;
  }
  if (device instanceof PodgoDesktopUsbConnection) {
    return device;
  }
  return PodgoUsbConnection.open(device);
}

export type { PodgoConnection, PodgoDeviceInfo };
