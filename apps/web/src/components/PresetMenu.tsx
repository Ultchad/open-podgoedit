// Small right-click menu for the librarian and the signal chain. The page owns
// every action and passes a flat list, so the menu stays a dumb renderer (and
// is easy to reuse in the desktop and mobile shells).
//
// Keyboard: focus moves into the menu on open, Arrow keys cycle the enabled
// items, Home/End jump, Escape closes, and focus returns to the trigger.

import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface PresetMenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Tooltip explaining a disabled or destructive item. */
  title?: string;
  onSelect: () => void;
}

export type PresetMenuEntry = PresetMenuItem | 'separator';

interface Props {
  x: number;
  y: number;
  items: PresetMenuEntry[];
  onClose: () => void;
  /** Accessible name, e.g. "Effect actions". */
  label?: string;
}

export default function PresetMenu({ x, y, items, onClose, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const buttons = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          'button:not(:disabled)',
        ) ?? [],
      );

    (buttons()[0] ?? ref.current)?.focus({ preventScroll: true });

    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) {
        closeRef.current();
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
    }
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
        [],
    );
    if (buttons.length === 0) {
      return;
    }
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = index;
    if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = buttons.length - 1;
    } else if (event.key === 'ArrowDown') {
      next = index < 0 ? 0 : (index + 1) % buttons.length;
    } else if (event.key === 'ArrowUp') {
      next =
        index < 0
          ? buttons.length - 1
          : (index - 1 + buttons.length) % buttons.length;
    }
    buttons[next]?.focus();
  }

  // Keep the menu inside the viewport on both axes; the estimated height uses
  // the compact desktop rows and the CSS max-height covers short screens.
  const width = 260;
  const height = Math.min(
    items.length * 36 + 16,
    Math.max(160, window.innerHeight - 16),
  );
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(
    8,
    Math.min(y, window.innerHeight - height - 8),
  );

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onMenuKeyDown}
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
            title={item.title ?? item.hint}
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
