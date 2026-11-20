// Reading a user-chosen file, on the web and in the Android shell.
//
// Android's WebView does open a file picker from `<input type="file">`, but
// cached document providers can hand back a `File` whose `arrayBuffer()`
// rejects. The native shell exposes `window.podgoAndroidFiles.read(name)` to
// read the picked name lazily; everywhere else the browser `File` is used.
import type { ChangeEvent } from 'react';

export interface ChosenFile {
  readonly name: string;
}

declare global {
  interface Window {
    /** Native helpers injected by the Android shell. */
    podgoAndroidFiles?: {
      /** Write `base64` as `name`; resolves to the stored path. */
      save(name: string, base64: string): Promise<string>;
      /**
       * Read back the last picked file.
       *
       * Rejects when the picker result was already consumed, so callers can
       * report a clear "pick the file again" error.
       */
      read(name: string): Promise<string>;
    };
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Bytes of a chosen file.
 *
 * `read` is the bridge for the Android shell; the browser path never needs it.
 */
export async function readChosenFile(
  chosen: File | ChosenFile,
  read?: (name: string) => Promise<string>,
): Promise<Uint8Array> {
  if (chosen instanceof File) {
    try {
      return new Uint8Array(await chosen.arrayBuffer());
    } catch (error) {
      if (!read) {
        throw error;
      }
      // Some Android providers only stream once; fall back to the shell copy.
      return base64ToBytes(await read(chosen.name));
    }
  }
  if (!read) {
    throw new Error('This platform cannot read the selected file.');
  }
  return base64ToBytes(await read(chosen.name));
}

/** Bytes of the first file in an `<input type="file">` event. */
export async function readInputFile(
  event: ChangeEvent<HTMLInputElement>,
): Promise<{ bytes: Uint8Array; name: string } | null> {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) {
    return null;
  }
  const bytes = await readChosenFile(file, window.podgoAndroidFiles?.read);
  return { bytes, name: file.name };
}
