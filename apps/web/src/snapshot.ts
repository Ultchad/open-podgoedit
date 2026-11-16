// Snapshot helpers shared by the toolbar and the inspector.
//
// POD Go uses a fixed LED palette rather than free RGB: the on-wire value is
// an index, in this order (`Auto`, `White`, `Red`, … `Off`). The order matches
// the footswitch LED palette documented by the manual and the MIT-licensed
// openpodgo reference implementation; the hex values below are only the
// web UI's own swatches, not vendor artwork.

export interface SnapshotLedColor {
  index: number;
  label: string;
  /** CSS colour for the swatch; `null` means "no LED". */
  color: string | null;
}

export const SNAPSHOT_LED_COLORS: readonly SnapshotLedColor[] = [
  { index: 0, label: 'Auto', color: '#e6e6e6' },
  { index: 1, label: 'White', color: '#ffffff' },
  { index: 2, label: 'Red', color: '#e5484d' },
  { index: 3, label: 'Dark Orange', color: '#c2410c' },
  { index: 4, label: 'Light Orange', color: '#fb923c' },
  { index: 5, label: 'Yellow', color: '#facc15' },
  { index: 6, label: 'Green', color: '#22c55e' },
  { index: 7, label: 'Turquoise', color: '#2dd4bf' },
  { index: 8, label: 'Blue', color: '#3b82f6' },
  { index: 9, label: 'Violet', color: '#8b5cf6' },
  { index: 10, label: 'Pink', color: '#ec4899' },
  { index: 11, label: 'Off', color: null },
];

/** Palette entry for an on-wire index, falling back to Auto. */
export function snapshotLedColor(index: number | null | undefined): SnapshotLedColor {
  return (
    SNAPSHOT_LED_COLORS.find((entry) => entry.index === index) ??
    SNAPSHOT_LED_COLORS[0]
  );
}
