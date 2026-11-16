// Preset name rules shared by the library actions and the save dialog.
//
// The pedal stores a NUL-terminated display name in its setlist entry. Evidence
// from the save capture (`reverse/exports/podgo-preset-save.pcapng`) shows a
// plain ASCII string terminated by NUL; this build keeps the same 16-byte cap
// and refuses control bytes so the setlist cannot be corrupted.

export const MAX_PRESET_NAME_BYTES = 16;

/** Return an error message, or `null` when the name is acceptable. */
export function validatePresetName(name: string): string | null {
  if (name.length === 0) {
    return 'Enter a preset name.';
  }
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      return 'Use printable ASCII only (no accents, tabs or control bytes).';
    }
  }
  // The protocol writes UTF-8, so count bytes, not code points.
  if (new TextEncoder().encode(name).length > MAX_PRESET_NAME_BYTES) {
    return `The name must fit in ${MAX_PRESET_NAME_BYTES} bytes.`;
  }
  return null;
}
