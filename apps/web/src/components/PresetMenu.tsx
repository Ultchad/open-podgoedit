// Small right-click menu for the librarian. The page owns every action and
// passes a flat list, so the menu stays a dumb renderer (and is easy to reuse
// in the desktop and mobile shells).

import { useEffect, useRef } from 'react';

export interface PresetMenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export type PresetMenuEntry = PresetMenuItem | 'separator';

interface Props {
  x: number;
  y: number;
  items: PresetMenuEntry[];
  onClose: () => void;
}

export default function PresetMenu({ x, y, items, onClose }: Props) {
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

  const height = items.length * 34 + 16;
  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.min(y, Math.max(8, window.innerHeight - height));

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === 'separator' ? (
          <hr key={`sep-${index}`} />
        ) : (
          <button
            key={item.id}
            id={item.id}
            type="button"
            role="menuitem"
            className={item.danger ? 'is-danger' : ''}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <small>{item.hint}</small>}
          </button>
        ),
      )}
    </div>
  );
}
