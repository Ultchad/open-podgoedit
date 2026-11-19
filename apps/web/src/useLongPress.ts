// Touch/pen long-press helper shared by the signal chain and the librarian.
//
// A long press opens the same actions menu as a right-click. Mouse presses are
// ignored: desktop users get the real context menu. The hook also exposes a
// click guard so the click that follows a long press does not also activate
// the tile or row underneath.

import { useCallback, useEffect, useRef } from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

interface Options {
  /** Hold time in milliseconds. */
  delay?: number;
  /** Movement that cancels the press, in pixels. */
  moveTolerance?: number;
  enabled?: boolean;
}

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function useLongPress(
  onLongPress: (x: number, y: number) => void,
  { delay = 500, moveTolerance = 10, enabled = true }: Options = {},
): { longPressHandlers: LongPressHandlers; consumeClick: () => boolean } {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const firedAt = useRef(0);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Only touch and pen long-press; the mouse uses onContextMenu.
      if (!enabled || event.pointerType === 'mouse') {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        firedAt.current = Date.now();
        const point = origin.current;
        if (point) {
          callback.current(point.x, point.y);
        }
      }, delay);
    },
    [delay, enabled],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const point = origin.current;
      if (!point) {
        return;
      }
      const dx = event.clientX - point.x;
      const dy = event.clientY - point.y;
      if (Math.hypot(dx, dy) > moveTolerance) {
        clear();
      }
    },
    [clear, moveTolerance],
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }
      // Touch browsers can also emit contextmenu after a long press; keep the
      // page's own menu instead of the browser's text/callout menu.
      event.preventDefault();
      callback.current(event.clientX, event.clientY);
    },
    [enabled],
  );

  /** True once for the click that follows a long press. */
  const consumeClick = useCallback(() => {
    const wasLongPress =
      fired.current && Date.now() - firedAt.current < 900;
    fired.current = false;
    return wasLongPress;
  }, []);

  return {
    longPressHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onContextMenu,
    },
    consumeClick,
  };
}
