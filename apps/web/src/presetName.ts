// Preset name rules shared by the library actions and the save dialog.
//
// The pedal stores a NUL-terminated display name in its setlist entry. Evidence
// from the save capture (`reverse/exports/podgo-preset-save.pcapng`) shows a
// plain ASCII string terminated by NUL; this build keeps the same 16-byte cap
// and refuses control bytes so the setlist cannot be corrupted.

export const MAX_PRESET_NAME_BYTES = 16;

/**
 * Snapshot labels are shorter than preset names: the POD Go Owner's Manual
 * (v2.50, "Customizing a Snapshot Footswitch's Label & LED Color") says the
 * Rename Snapshot screen accepts **up to 10 characters**.
 */
export const MAX_SNAPSHOT_NAME_LENGTH = 10;

/**
 * Return an error message, or `null` when a snapshot name is acceptable.
 *
 * An empty name is allowed: it clears the custom label, and the editor falls
 * back to `SNAPSHOT n`.
 */
export function validateSnapshotName(name: string): string | null {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      return 'Use printable ASCII only (no accents, tabs or control bytes).';
    }
  }
  if (name.length > MAX_SNAPSHOT_NAME_LENGTH) {
    return `The snapshot name must fit in ${MAX_SNAPSHOT_NAME_LENGTH} characters.`;
  }
  return null;
}

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
