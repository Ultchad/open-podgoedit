// Right-click menu for one snapshot chip.
//
// The page still owns the draft helpers; this component only renders the
// actions for the snapshot under the pointer. It is deliberately separate from
// `PresetMenu` because the LED palette is a compact swatch grid rather than a
// list of twelve rows.

import { useEffect, useRef } from 'react';
import { SNAPSHOT_LED_COLORS, snapshotLedColor } from '../snapshot';
import type { SnapshotState } from '../types';

interface Props {
  x: number;
  y: number;
  /** 0-based snapshot index. */
  index: number;
  snapshot: SnapshotState;
  active: boolean;
  onRename: () => void;
  onSelect: () => void;
  onClearName: () => void;
  onSetLedColor: (color: number) => void;
  onClose: () => void;
}

export default function SnapshotMenu({
  x,
  y,
  index,
  snapshot,
  active,
  onRename,
  onSelect,
  onClearName,
  onSetLedColor,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 250);
  const top = Math.min(y, Math.max(8, window.innerHeight - 250));
  const label = snapshot.name || `SNAPSHOT ${index + 1}`;
  const led = snapshotLedColor(snapshot.ledColor);

  function run(action: () => void) {
    onClose();
    action();
  }

  return (
    <div
      ref={ref}
      className="context-menu snapshot-menu"
      role="menu"
      aria-label={`Snapshot ${index + 1} actions`}
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="snapshot-menu-title">{label}</p>
      <button
        id="snapshot-menu-rename"
        type="button"
        role="menuitem"
        onClick={() => run(onRename)}
      >
        Rename snapshot…
      </button>
      <button
        id="snapshot-menu-activate"
        type="button"
        role="menuitem"
        disabled={active}
        title={active ? 'Already the loaded snapshot' : undefined}
        onClick={() => run(onSelect)}
      >
        Use as active snapshot
      </button>
      <button
        id="snapshot-menu-clear-name"
        type="button"
        role="menuitem"
        disabled={!snapshot.name}
        onClick={() => run(onClearName)}
      >
        Clear custom name
      </button>
      <hr />
      <p className="snapshot-menu-label">
        Footswitch LED — {led.label}
      </p>
      <div
        className="snapshot-palette"
        role="group"
        aria-label="Snapshot LED colour"
      >
        {SNAPSHOT_LED_COLORS.map((entry) => (
          <button
            key={entry.index}
            type="button"
            role="menuitemradio"
            aria-checked={entry.index === snapshot.ledColor}
            aria-label={entry.label}
            title={entry.label}
            className={`snapshot-swatch${
              entry.index === snapshot.ledColor ? ' is-active' : ''
            }`}
            onClick={() => run(() => onSetLedColor(entry.index))}
          >
            <span
              className={`snapshot-led${entry.color ? '' : ' is-off'}`}
              style={entry.color ? { background: entry.color } : undefined}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
