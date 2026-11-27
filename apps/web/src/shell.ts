// The shell contract: one web bundle is the UI for every platform.
//
// The browser, the Android WebView app and the Tauri desktop app all run this
// exact bundle. A shell only adds a native adapter: a USB transport and, where
// a `blob:` download is not enough, a file-save bridge. Everything else — the
// editor, the preset library, the `.pgb` codec, snapshots and every write gate
// — stays in this bundle.
//
// `SHELL_API_VERSION` is the version of that adapter surface. Each shell
// reports the version it implements, so an old app package cannot silently run
// against newer UI expectations. Bump it only when the adapter surface changes
// in a way a shell must implement; then update all three in the same commit:
//
//   apps/web/src/shell.ts                    SHELL_API_VERSION
//   apps/android/.../PodgoUsbBridge.kt       API_VERSION
//   apps/desktop/src-tauri/src/lib.rs        SHELL_API_VERSION
//
// `scripts/verify-shell-consumers.mjs` (run in CI) fails if they drift.
import { androidUsbBridge } from './usb/bridge';
import { desktopCore } from './desktop';
import { usbLinkSupported } from './usb';

/** Version of the shell adapter contract this bundle expects. */
export const SHELL_API_VERSION = 1;

/** Where this bundle is running. The UI itself is identical everywhere. */
export type ShellKind = 'browser' | 'android' | 'desktop';

/** What the current shell can do, regardless of whether the pedal is attached. */
export interface ShellCapabilities {
  kind: ShellKind;
  /** Some transport can reach the pedal (not that one is connected). */
  pedal: boolean;
  /** Exports go through the shell (Downloads folder / save dialog). */
  nativeSave: boolean;
  /** The browser may offer an install prompt (PWA). */
  installable: boolean;
}

/** Result of the one startup handshake between the bundle and its shell. */
export interface ShellBridgeStatus {
  capabilities: ShellCapabilities;
  /** Version the shell reported, or `null` when it reports none. */
  reportedVersion: number | null;
  /**
   * True when a native shell is present but does not implement this bundle's
   * adapter version. The editor still runs, but the shell needs updating.
   */
  outdated: boolean;
}

/** Detect the shell and the capabilities it exposes. */
export function shellCapabilities(): ShellCapabilities {
  if (androidUsbBridge()) {
    return {
      kind: 'android',
      pedal: true,
      nativeSave: true,
      installable: false,
    };
  }
  if (desktopCore()) {
    return {
      kind: 'desktop',
      pedal: true,
      nativeSave: true,
      installable: false,
    };
  }
  return {
    kind: 'browser',
    pedal: usbLinkSupported(),
    nativeSave: false,
    installable:
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator,
  };
}

/**
 * The Android bridge reports its contract version synchronously: either as a
 * property or as a `@JavascriptInterface` method.
 */
function androidReportedVersion(): number | null {
  const bridge = androidUsbBridge();
  if (!bridge) {
    return null;
  }
  const raw = bridge.apiVersion;
  const value = typeof raw === 'function' ? raw() : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The desktop shell answers through a Tauri command. */
async function desktopReportedVersion(): Promise<number | null> {
  const core = desktopCore();
  if (!core) {
    return null;
  }
  try {
    const value = await core.invoke<number>('shell_api_version');
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    // An older desktop package has no such command; treat it as unreported.
    return null;
  }
}

/**
 * Run the startup handshake.
 *
 * A browser is always current because its bundle and adapter ship together. A
 * native shell reports `SHELL_API_VERSION`; a mismatch means the app package
 * and its bundled UI were built from different contract versions.
 */
export async function checkShellBridge(): Promise<ShellBridgeStatus> {
  const capabilities = shellCapabilities();
  if (capabilities.kind === 'browser') {
    return { capabilities, reportedVersion: null, outdated: false };
  }
  const reportedVersion =
    capabilities.kind === 'android'
      ? androidReportedVersion()
      : await desktopReportedVersion();
  return {
    capabilities,
    reportedVersion,
    outdated: reportedVersion !== SHELL_API_VERSION,
  };
}
