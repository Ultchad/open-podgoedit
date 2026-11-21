// Desktop shell detection and the file-save bridge.
//
// The Tauri build exposes its command bridge on `window.__TAURI__.core`
// because `tauri.conf.json` enables `withGlobalTauri`. Keeping the detection
// here means the editor only asks "am I in the desktop shell?" and never
// imports a Tauri JavaScript package.
//
// The native side writes exports through a save dialog; a `blob:` link cannot
// be saved from every WebView, so the browser fallback is never used there.

/** The subset of Tauri's global bridge this app uses. */
export interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** Native helpers injected by the desktop shell. */
export interface DesktopFilesBridge {
  /** Ask where to save `base64` as `name`; resolves to the path, or null. */
  save(name: string, base64: string): Promise<string | null>;
}

declare global {
  interface Window {
    /** Tauri's global bridge, present only in the desktop shell. */
    __TAURI__?: { core?: TauriCore };
    /** Native file save installed by `installDesktopFiles`. */
    podgoDesktopFiles?: DesktopFilesBridge;
  }
}

/** Tauri's invoke bridge, or `null` in a browser or the Android shell. */
export function desktopCore(): TauriCore | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const core = window.__TAURI__?.core;
  return core && typeof core.invoke === 'function' ? core : null;
}

/** True when the page runs inside the Tauri desktop shell. */
export function isDesktopShell(): boolean {
  return desktopCore() !== null;
}

/**
 * Expose `window.podgoDesktopFiles` for the export paths in `App.tsx`.
 *
 * Called once from `main.tsx`, before React renders.
 */
export function installDesktopFiles(): void {
  const core = desktopCore();
  if (!core) {
    return;
  }
  window.podgoDesktopFiles = {
    save: (name, base64) =>
      core.invoke<string | null>('save_file', { name, base64 }),
  };
}
