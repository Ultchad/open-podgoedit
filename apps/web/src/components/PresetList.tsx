// Librarian: setlist tabs and the preset list, in the official POD Go Edit
// style (`01A  Name`).
//
// The list works in both modes:
// - offline, User slots open the in-page copy (or create a new preset);
// - connected, slots read their body over WebUSB without recalling it.
//
// Every slot has a right-click menu, and User presets can be dragged onto
// another slot to move them in the local setlist.

import { slotLabel } from '../catalog';
import type { SetlistEntry } from '../types';

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
}: PresetListProps) {
  const entries = setlists[activeSetlist];
  const user = activeSetlist === 1;

  return (
    <aside className="librarian" aria-label="Preset librarian">
      <div className="librarian-head">
        <h2>Presets</h2>
        <span className="librarian-count">
          {entries
            ? `${entries.filter((entry) => entry.name).length}/${entries.length}`
            : '—'}
        </span>
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
          {entries.map((entry) => {
            const loaded =
              loadedSetlist === activeSetlist && entry.slot === loadedSlot;
            const empty = !entry.name;
            const browser = browserSlots.has(
              `${activeSetlist}:${entry.slot}`,
            );
            return (
              <button
                type="button"
                key={entry.slot}
                role="option"
                data-slot={entry.slot}
                aria-selected={loaded}
                draggable={user && !empty}
                className={[
                  'preset-item',
                  loaded ? 'is-loaded' : '',
                  empty ? 'is-empty' : '',
                  browser ? 'is-browser' : '',
                  !user && !canRead ? 'is-offline' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onOpenSlot(activeSetlist, entry)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onContextMenu(
                    activeSetlist,
                    entry,
                    event.clientX,
                    event.clientY,
                  );
                }}
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
                  const raw = event.dataTransfer.getData(
                    'application/x-podgo-slot',
                  );
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
                        } — drag to move, right-click for actions`
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
          })}
        </div>
      )}
    </aside>
  );
}
