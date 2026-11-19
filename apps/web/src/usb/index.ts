// Platform-agnostic access to the POD Go USB link.
//
// The browser uses WebUSB; the Android shell injects a native USB-host bridge
// (`window.podgoAndroidUsb`). Both implement `PodgoConnection`, so the rest of
// the app never branches on the transport.
import { PodgoAndroidUsbConnection } from './bridge';
import {
  PodgoUsbConnection,
  WebUsbUnavailableError,
  type PodgoConnection,
  type PodgoDeviceInfo,
} from './podgoUsb';

/** True when the current platform can reach the pedal at all. */
export function usbLinkSupported(): boolean {
  return (
    PodgoUsbConnection.isSupported() || PodgoAndroidUsbConnection.isAvailable()
  );
}

/** True when the native Android bridge is backing the USB link. */
export function runningOnAndroidShell(): boolean {
  return PodgoAndroidUsbConnection.isAvailable();
}

/**
 * Select the device.
 *
 * In the Android shell the app owns the USB permission, so no picker runs and
 * the pedal is opened directly. In the browser this returns the `USBDevice`
 * the user picked, for {@link connectToPickerResult}.
 */
export async function requestPedal(): Promise<
  USBDevice | PodgoAndroidUsbConnection
> {
  if (PodgoAndroidUsbConnection.isAvailable()) {
    return PodgoAndroidUsbConnection.open();
  }
  if (!PodgoUsbConnection.isSupported()) {
    throw new WebUsbUnavailableError();
  }
  return PodgoUsbConnection.requestDevice();
}

/** Claim the vendor interface (a native session is already open). */
export async function connectToPickerResult(
  device: USBDevice | PodgoAndroidUsbConnection,
): Promise<PodgoConnection> {
  if (device instanceof PodgoAndroidUsbConnection) {
    return device;
  }
  return PodgoUsbConnection.open(device);
}

export type { PodgoConnection, PodgoDeviceInfo };
