// Preset library actions: copy, paste, move and rename.
//
// The page owns the model and the device; this dialog only collects the
// destination and calls back. Two separate steps are offered on purpose:
//
// 1. **Apply locally** changes the in-memory setlists only. Nothing leaves the
//    browser, and a later read from the pedal replaces the change.
// 2. **Write to pedal** performs the only evidenced operations: operation 71
//    for renaming the active User preset, and one operation-5 body write for a
//    pasted or moved body. Both are destructive and have one gate: the explicit
//    write button, followed by one `window.confirm` in `App`. A full backup is
//    offered next door but is not required.
//
// There is no evidenced "delete slot" operation, so a move cannot clear its
// source on the pedal. The dialog says so instead of pretending otherwise.

import { useEffect, useState } from 'react';
import { slotLabel } from '../catalog';
import { MAX_PRESET_NAME_BYTES, validatePresetName } from '../presetName';
import type { PresetStructure, SetlistEntry } from '../types';
import { useDialog } from '../useDialog';

const SETLIST_NAMES: Record<number, string> = { 0: 'Factory', 1: 'User' };
const SLOT_COUNT = 128;

export interface ClipboardEntry {
  name: string;
  setlist: 0 | 1;
  slot: number;
}

export interface PendingEdit {
  key: string;
  setlist: 0 | 1;
  slot: number;
  name: string;
  kind: 'rename' | 'paste' | 'move' | 'clear';
}

export type PasteMode = 'paste' | 'move';

interface Props {
  open: boolean;
  /** Another device operation is running. */
  busy: boolean;
  connected: boolean;
  /** Deprecated: writes are live whenever a pedal is connected. */
  writeArmed?: boolean;
  activePresetLoaded: boolean;
  structure: PresetStructure | null;
  setlists: Record<0 | 1, SetlistEntry[] | null>;
  clipboard: ClipboardEntry | null;
  pending: PendingEdit[];
  actionBusy: boolean;
  actionError: string | null;
  onClose: () => void;
  onCopy: () => void;
  onClearClipboard: () => void;
  onRenameLocal: (name: string) => void;
  onPasteLocal: (
    setlist: 0 | 1,
    slot: number,
    name: string,
    mode: PasteMode,
  ) => void;
  onRenameWrite: (name: string) => void;
  onPasteWrite: (slot: number, name: string, mode: PasteMode) => void;
}

function defaultDestination(
  setlists: Record<0 | 1, SetlistEntry[] | null>,
): number {
  const entries = setlists[1];
  if (!entries) {
    return 0;
  }
  const found = entries.find((entry) => !entry.name);
  return found ? found.slot : 0;
}

export default function PresetActionsDialog({
  open,
  busy,
  connected,
  // `writeArmed` is deprecated and intentionally unused.
  activePresetLoaded,
  structure,
  setlists,
  clipboard,
  pending,
  actionBusy,
  actionError,
  onClose,
  onCopy,
  onClearClipboard,
  onRenameLocal,
  onPasteLocal,
  onRenameWrite,
  onPasteWrite,
}: Props) {
  const [destSetlist, setDestSetlist] = useState<0 | 1>(1);
  const [destSlot, setDestSlot] = useState(() => defaultDestination(setlists));
  const [destName, setDestName] = useState('');
  const [rename, setRename] = useState('');
  const [renameTouched, setRenameTouched] = useState(false);
  const { dialogRef, onBackdropClick } = useDialog(open, onClose);

  const sourceSetlist =
    structure && (structure.preset.setlist === 0 || structure.preset.setlist === 1)
      ? (structure.preset.setlist as 0 | 1)
      : null;
  const sourceSlot = structure?.preset.slot ?? null;
  const sourceName = structure?.preset.name ?? '';
  const sourceLabel =
    sourceSetlist !== null && sourceSlot !== null
      ? `${SETLIST_NAMES[sourceSetlist]} ${slotLabel(sourceSlot)}`
      : '—';

  useEffect(() => {
    if (!open) {
      return;
    }
    setDestSetlist(1);
    setDestSlot(defaultDestination(setlists));
    setDestName(clipboard?.name ?? '');
    setDestSlotToFree(clipboard);
    setRename(sourceName);
    setRenameTouched(false);
    // Reset only when the dialog opens, not on every model update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the rename field in sync with the loaded preset until the user edits
  // it, so switching slots does not carry the previous name over.
  useEffect(() => {
    if (!renameTouched) {
      setRename(sourceName);
    }
  }, [sourceName, renameTouched]);

  // `clipboard` may arrive after the dialog opened (Copy button inside it).
  useEffect(() => {
    if (clipboard) {
      setDestName(clipboard.name);
    }
  }, [clipboard]);

  function setDestSlotToFree(entry: ClipboardEntry | null): void {
    if (!entry) {
      return;
    }
    const entries = setlists[1];
    const free = entries?.find((item) => !item.name);
    setDestSlot(free ? free.slot : entry.slot);
  }

  if (!open) {
    return null;
  }

  const nameError = validatePresetName(destName);
  const renameError = validatePresetName(rename);
  const destEntries = setlists[destSetlist] ?? [];
  const destCurrent = destEntries[destSlot]?.name ?? '';
  const unsaved = pending.length > 0;
  const canWriteRename =
    connected &&
    activePresetLoaded &&
    sourceSetlist === 1 &&
    !busy &&
    !actionBusy &&
    renameError === null &&
    rename !== sourceName;
  const canWritePaste =
    connected &&
    clipboard !== null &&
    nameError === null &&
    !busy &&
    !actionBusy;

  const writeBlockers: string[] = [];
  if (!connected) {
    writeBlockers.push('connect the pedal');
  }

  return (
    <div className="modal-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal preset-actions"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-actions-title"
      >
        <div className="modal-head">
          <h2 id="preset-actions-title">Preset actions</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <p className="modal-hint">
          Loaded preset: <strong>{sourceName || 'unnamed'}</strong> ({sourceLabel}).
          “Apply locally” only changes this page; “Write to pedal” sends the
          change. There is no evidenced way to clear a slot, so a move writes
          the destination but leaves the source on the pedal.
        </p>

        {actionError && <p className="save-error">{actionError}</p>}
        {writeBlockers.length > 0 && (
          <p className="save-hint" id="actions-blockers">
            Writing to the pedal needs: {writeBlockers.join(' and ')}.
          </p>
        )}
        <p className="save-backup-info">
          A full backup before you write is recommended but optional (
          <em>Full backup / restore</em>). Each write button asks one
          confirmation.
        </p>

        {/* --- copy ------------------------------------------------------- */}
        <div className="save-backup">
          <div className="save-backup-head">
            <h3>1. Copy</h3>
            <button
              id="copy-preset"
              type="button"
              disabled={structure === null || actionBusy}
              onClick={onCopy}
            >
              Copy loaded preset
            </button>
          </div>
          {clipboard ? (
            <dl className="save-backup-info" id="clipboard-info">
              <dt>Clipboard</dt>
              <dd>
                {clipboard.name || 'unnamed'} ({SETLIST_NAMES[clipboard.setlist]}{' '}
                {slotLabel(clipboard.slot)})
              </dd>
            </dl>
          ) : (
            <p className="save-backup-info">Clipboard empty.</p>
          )}
          {clipboard && (
            <button
              type="button"
              className="link-button"
              onClick={onClearClipboard}
            >
              Clear clipboard
            </button>
          )}
        </div>

        {/* --- paste / move ----------------------------------------------- */}
        <div className="save-backup">
          <div className="save-backup-head">
            <h3>2. Paste or move the clipboard</h3>
          </div>
          <label className="field">
            <span>Destination setlist</span>
            <select
              id="paste-setlist"
              value={destSetlist}
              onChange={(event) =>
                setDestSetlist(event.target.value === '0' ? 0 : 1)
              }
            >
              <option value="1">User</option>
              <option value="0">Factory (local only)</option>
            </select>
          </label>
          <label className="field">
            <span>Destination slot</span>
            <select
              id="paste-slot"
              value={destSlot}
              onChange={(event) => setDestSlot(Number(event.target.value))}
            >
              {Array.from({ length: SLOT_COUNT }, (_, slot) => (
                <option key={slot} value={slot}>
                  {slotLabel(slot)}
                  {destEntries[slot]?.name
                    ? ` — ${destEntries[slot]?.name}`
                    : ' — empty'}
                </option>
              ))}
            </select>
          </label>
          <p className="save-backup-info">
            Destination currently: {destCurrent || 'empty'}
          </p>
          <label className="field">
            <span>Name at the destination</span>
            <input
              id="paste-name"
              type="text"
              maxLength={MAX_PRESET_NAME_BYTES}
              value={destName}
              onChange={(event) => setDestName(event.target.value)}
              placeholder="Preset name"
            />
          </label>
          {nameError && <p className="save-error">{nameError}</p>}

          <div className="modal-actions inline">
            <button
              id="paste-local"
              type="button"
              disabled={clipboard === null || nameError !== null || actionBusy}
              onClick={() => {
                if (clipboard) {
                  onPasteLocal(destSetlist, destSlot, destName, 'paste');
                }
              }}
            >
              Apply paste locally
            </button>
            <button
              id="move-local"
              type="button"
              disabled={clipboard === null || nameError !== null || actionBusy}
              onClick={() => {
                if (clipboard) {
                  onPasteLocal(destSetlist, destSlot, destName, 'move');
                }
              }}
            >
              Apply move locally
            </button>
            <button
              id="paste-write"
              type="button"
              className="save-confirm"
              disabled={!canWritePaste || destSetlist !== 1}
              title={
                destSetlist !== 1
                  ? 'Only the User setlist can be written.'
                  : canWritePaste
                    ? 'Write the body with operation 5'
                    : 'The write gates are not met.'
              }
              onClick={() => {
                if (clipboard) {
                  onPasteWrite(destSlot, destName, 'paste');
                }
              }}
            >
              Write paste to pedal
            </button>
          </div>
          <p className="save-backup-info">
            Move writes the same body to the destination; the source slot is
            left untouched on the pedal.
          </p>
        </div>

        {/* --- rename ------------------------------------------------------ */}
        <div className="save-backup">
          <div className="save-backup-head">
            <h3>3. Rename the loaded preset</h3>
          </div>
          <label className="field">
            <span>New name</span>
            <input
              id="rename-name"
              type="text"
              maxLength={MAX_PRESET_NAME_BYTES}
              value={rename}
              onChange={(event) => {
                setRename(event.target.value);
                setRenameTouched(true);
              }}
            />
          </label>
          {renameError && <p className="save-error">{renameError}</p>}
          <p className="save-backup-info">
            On the pedal, only the <strong>active User preset</strong> can be
            renamed, with operation 71 (the save command). Another slot can be
            renamed locally, but not on the pedal yet.
          </p>
          <div className="modal-actions inline">
            <button
              id="rename-local"
              type="button"
              disabled={
                structure === null || renameError !== null || actionBusy
              }
              onClick={() => onRenameLocal(rename)}
            >
              Apply rename locally
            </button>
            <button
              id="rename-write"
              type="button"
              className="save-confirm"
              disabled={!canWriteRename}
              title={
                canWriteRename
                  ? 'Rename the active User preset with operation 71'
                  : 'Rename on the pedal is limited to the active User preset.'
              }
              onClick={() => onRenameWrite(rename)}
            >
              Write rename to pedal
            </button>
          </div>
        </div>

        {/* --- pending ----------------------------------------------------- */}
        <div className="save-backup">
          <div className="save-backup-head">
            <h3>Local changes</h3>
            <span className="librarian-count">{pending.length}</span>
          </div>
          {unsaved ? (
            <>
              <ul className="pending-list" id="pending-edits">
                {pending.map((edit) => (
                  <li key={edit.key}>
                    {SETLIST_NAMES[edit.setlist]} {slotLabel(edit.slot)}:{' '}
                    {edit.kind === 'clear'
                      ? 'cleared locally (not written)'
                      : `${edit.kind} → ${edit.name || 'unnamed'}`}
                  </li>
                ))}
              </ul>
              <p className="save-backup-info">
                These changes exist only in this page. A setlist read, a reload
                or a written operation replaces them.
              </p>
            </>
          ) : (
            <p className="save-backup-info">No local change.</p>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={actionBusy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
