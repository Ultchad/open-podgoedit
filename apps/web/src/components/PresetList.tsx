// Librarian: setlist tabs and the preset list, in the official POD Go Edit
// style (`01A  Name`).
//
// The list works in both modes:
// - offline, User slots open the in-page copy (or create a new preset);
// - connected, slots read their body over WebUSB without recalling it.
//
// Every slot has a right-click menu (or long-press on touch); "Move preset…"
// in that menu swaps with another slot, so no drag gesture is needed. On a
// phone the whole librarian is an off-canvas drawer, opened from the header.

import { Fragment } from 'react';

import { slotLabel } from '../catalog';
import type { SetlistEntry } from '../types';
import { useLongPress } from '../useLongPress';

export interface PresetListProps {
  setlists: Record<0 | 1, SetlistEntry[] | null>;
  /** Setlist tab currently shown. */
  activeSetlist: 0 | 1;
  /** Setlist holding the preset loaded on the pedal or in the editor. */
  loadedSetlist: 0 | 1 | null;
  /** Position of the preset loaded on the pedal or in the editor. */
  loadedSlot: number | null;
  /** True when the pedal is connected and idle. */
  canRead: boolean;
  /**
   * `setlist:slot` keys whose body exists only in the browser (offline copy
   * or unsaved draft). Their name is italic, like an unsaved document.
   */
  browserSlots: ReadonlySet<string>;
  onSetlist: (kind: 0 | 1) => void;
  /** Open one slot (read from the pedal or open the local copy). */
  onOpenSlot: (kind: 0 | 1, entry: SetlistEntry) => void;
  /** Right-click or long-press on a slot. */
  onContextMenu: (
    kind: 0 | 1,
    entry: SetlistEntry,
    x: number,
    y: number,
  ) => void;
  /** Move (swap) one User slot onto another. */
  onMoveSlot: (fromSlot: number, toSlot: number) => void;
  /** Drawer state on a phone (ignored on wider layouts). */
  open?: boolean;
  /** Close the phone drawer. */
  onClose?: () => void;
}

const NAMES: Record<0 | 1, string> = { 0: 'Factory', 1: 'User' };

export default function PresetList({
  setlists,
  activeSetlist,
  loadedSetlist,
  loadedSlot,
  canRead,
  browserSlots,
  onSetlist,
  onOpenSlot,
  onContextMenu,
  onMoveSlot,
  open = false,
  onClose,
}: PresetListProps) {
  const entries = setlists[activeSetlist];
  const user = activeSetlist === 1;

  return (
    <aside
      className={`librarian${open ? ' is-open' : ''}`}
      id="preset-librarian"
      aria-label="Preset librarian"
    >
      <div className="librarian-head">
        <h2>Presets</h2>
        <span className="librarian-count">
          {entries
            ? `${entries.filter((entry) => entry.name).length}/${entries.length}`
            : '—'}
        </span>
        {onClose && (
          <button
            type="button"
            className="librarian-close"
            aria-label="Close preset list"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>

      <div className="setlist-tabs" role="tablist" aria-label="Setlists">
        {([0, 1] as const).map((kind) => (
          <button
            type="button"
            key={kind}
            role="tab"
            aria-selected={activeSetlist === kind}
            className={activeSetlist === kind ? 'is-active' : ''}
            onClick={() => onSetlist(kind)}
          >
            {NAMES[kind]}
            {setlists[kind] ? (
              <span className="tab-count">{setlists[kind]?.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {entries === null ? (
        <p className="librarian-empty">
          {NAMES[activeSetlist]} setlist not loaded yet.
          <br />
          Offline mode fills it on load; connect the pedal to read the real one.
        </p>
      ) : (
        <div
          className="preset-list"
          role="listbox"
          aria-label={`${NAMES[activeSetlist]} presets`}
        >
          {entries.map((entry, position) => {
            const loaded =
              loadedSetlist === activeSetlist && entry.slot === loadedSlot;
            // A subtle rule between banks (01A…01D | 02A…): the pedal groups
            // four slots per bank, so the list mirrors that rhythm.
            const newBank = position > 0 && entry.slot % 4 === 0;
            return (
              <Fragment key={entry.slot}>
                {newBank && (
                  <div className="preset-bank-divider" aria-hidden="true" />
                )}
                <PresetRow
                  kind={activeSetlist}
                  entry={entry}
                  loaded={loaded}
                  user={user}
                  canRead={canRead}
                  browser={browserSlots.has(
                    `${activeSetlist}:${entry.slot}`,
                  )}
                  onOpen={() => onOpenSlot(activeSetlist, entry)}
                  onMenu={(x, y) =>
                    onContextMenu(activeSetlist, entry, x, y)
                  }
                  onMoveSlot={onMoveSlot}
                />
              </Fragment>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function PresetRow({
  kind,
  entry,
  loaded,
  user,
  canRead,
  browser,
  onOpen,
  onMenu,
  onMoveSlot,
}: {
  kind: 0 | 1;
  entry: SetlistEntry;
  loaded: boolean;
  user: boolean;
  canRead: boolean;
  browser: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onMoveSlot: (fromSlot: number, toSlot: number) => void;
}) {
  const empty = !entry.name;
  const { longPressHandlers, consumeClick } = useLongPress(onMenu);

  return (
    <button
      type="button"
      role="option"
      data-slot={entry.slot}
      data-setlist={kind}
      aria-selected={loaded}
      className={[
        'preset-item',
        loaded ? 'is-loaded' : '',
        empty ? 'is-empty' : '',
        browser ? 'is-browser' : '',
        !user && !canRead ? 'is-offline' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => {
        if (consumeClick()) {
          return;
        }
        onOpen();
      }}
      {...longPressHandlers}
      onDragStart={(event) => {
        if (!user || empty) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(
          'application/x-podgo-slot',
          String(entry.slot),
        );
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event) => {
        if (user) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={(event) => {
        if (!user) {
          return;
        }
        const raw = event.dataTransfer.getData('application/x-podgo-slot');
        event.preventDefault();
        const from = Number(raw);
        if (Number.isInteger(from) && from !== entry.slot) {
          onMoveSlot(from, entry.slot);
        }
      }}
      title={
        empty
          ? user
            ? 'Empty User slot — click to start a new preset'
            : 'Empty factory slot'
          : user
            ? `${slotLabel(entry.slot)} ${entry.name}${
                browser ? ' (browser copy, not on the pedal)' : ''
              } — drag to move, right-click or long-press for actions`
            : canRead
              ? `Read ${slotLabel(entry.slot)} from the pedal`
              : 'No pedal connected — factory bodies are not bundled'
      }
    >
      <span className="preset-slot">{slotLabel(entry.slot)}</span>
      <span className="preset-name">
        {entry.name || (user ? 'Empty' : '—')}
      </span>
    </button>
  );
}
