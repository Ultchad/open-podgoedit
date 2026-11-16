// Save-to-slot dialog (operation 71).
//
// The dialog only collects the destination and the name; every device action
// stays in `App`. Before the save can be confirmed, the page reads the
// destination slot and keeps a byte-exact backup with its SHA-256 digest. The
// user must acknowledge the backup explicitly.

import { useEffect, useState } from 'react';
import { slotLabel } from '../catalog';

const MAX_NAME_BYTES = 16;
const MAX_SLOTS = 128;

/** Backup taken from the destination slot before a save. */
export interface SaveBackup {
  slot: number;
  /** Name the destination had when it was read (empty for a free slot). */
  name: string;
  /** Preset body size in bytes; `0` for an empty slot. */
  size: number;
  /** Lower-case SHA-256 of the body, or `null` for an empty slot. */
  sha256: string | null;
  /** True when the slot held no preset body. */
  empty: boolean;
}

interface Props {
  open: boolean;
  /** The device (or a save) is busy. */
  busy: boolean;
  /** Pre-selected destination slot. */
  defaultSlot: number | null;
  /** Pre-filled preset name. */
  defaultName: string;
  /** Backup for the slot currently selected, if one has been read. */
  backup: SaveBackup | null;
  backupBusy: boolean;
  backupError: string | null;
  onClose: () => void;
  onPrepareBackup: (slot: number) => void;
  onSave: (slot: number, name: string) => void;
}

function isPrintableAscii(value: string): boolean {
  return [...value].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e;
  });
}

function validateName(name: string): string | null {
  if (name.length === 0) {
    return 'Enter a preset name.';
  }
  if (name.length > MAX_NAME_BYTES) {
    return `At most ${MAX_NAME_BYTES} characters.`;
  }
  if (!isPrintableAscii(name)) {
    return 'Use printable ASCII characters only.';
  }
  return null;
}

export default function SavePresetDialog({
  open,
  busy,
  defaultSlot,
  defaultName,
  backup,
  backupBusy,
  backupError,
  onClose,
  onPrepareBackup,
  onSave,
}: Props) {
  const [slotText, setSlotText] = useState('0');
  const [name, setName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  // A new opening starts from the current preset's slot and name.
  useEffect(() => {
    if (!open) {
      return;
    }
    setSlotText(String(defaultSlot ?? 0));
    setName(defaultName.slice(0, MAX_NAME_BYTES));
    setAcknowledged(false);
  }, [open, defaultSlot, defaultName]);

  // The acknowledgement is tied to one exact destination and name.
  useEffect(() => {
    setAcknowledged(false);
  }, [slotText, name]);

  if (!open) {
    return null;
  }

  const slot = Number(slotText);
  const slotValid =
    Number.isInteger(slot) && slot >= 0 && slot < MAX_SLOTS;
  const nameError = validateName(name);
  const matchingBackup = backup && backup.slot === slot ? backup : null;
  const canSave =
    slotValid &&
    nameError === null &&
    matchingBackup !== null &&
    acknowledged &&
    !busy &&
    !backupBusy;

  return (
    <div className="modal-backdrop">
      <div
        className="modal save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-dialog-title"
      >
        <div className="modal-head">
          <h2 id="save-dialog-title">Save preset to a User slot</h2>
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
          Operation 71 stores the <strong>active preset</strong> under a new
          slot and name. It does not upload the preset body. Read the
          destination slot first: its current contents are downloaded as a
          backup before the pedal is touched.
        </p>

        <div className="save-fields">
          <label htmlFor="save-slot">
            <span>User slot (0–127)</span>
            <input
              id="save-slot"
              type="number"
              min={0}
              max={MAX_SLOTS - 1}
              step={1}
              value={slotText}
              onChange={(event) => setSlotText(event.target.value)}
            />
            <span className="save-slot-label">
              {slotValid ? slotLabel(slot) : 'Invalid slot'}
            </span>
          </label>

          <label htmlFor="save-name">
            <span>Preset name (max {MAX_NAME_BYTES})</span>
            <input
              id="save-name"
              type="text"
              maxLength={MAX_NAME_BYTES}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>
        {nameError && <p className="save-error">{nameError}</p>}

        <div className="save-backup">
          <div className="save-backup-head">
            <h3>Destination backup</h3>
            <button
              id="save-backup"
              type="button"
              disabled={!slotValid || busy || backupBusy}
              onClick={() => onPrepareBackup(slot)}
            >
              {backupBusy
                ? 'Reading…'
                : matchingBackup
                  ? 'Read again'
                  : 'Read destination slot'}
            </button>
          </div>

          {backupError && <p className="save-error">{backupError}</p>}

          {matchingBackup ? (
            matchingBackup.empty ? (
              <p className="save-backup-info">
                Slot {slotLabel(matchingBackup.slot)} is empty: there is no
                preset body to back up.
              </p>
            ) : (
              <dl className="save-backup-info">
                <dt>Existing preset</dt>
                <dd>{matchingBackup.name || '(unnamed)'}</dd>
                <dt>Backup</dt>
                <dd>{matchingBackup.size} B, downloaded</dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{matchingBackup.sha256}</code>
                </dd>
              </dl>
            )
          ) : (
            <p className="save-backup-info">
              No backup yet. Read slot {slotValid ? slotLabel(slot) : '—'} to
              download its current contents.
            </p>
          )}

          <label className="save-ack">
            <input
              id="save-ack"
              type="checkbox"
              checked={acknowledged}
              disabled={!matchingBackup}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I have the destination backup and want to overwrite slot{' '}
              {slotValid ? slotLabel(slot) : '—'} with “{name || '…'}”.
            </span>
          </label>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            id="save-confirm"
            type="button"
            className="save-confirm"
            disabled={!canSave}
            onClick={() => onSave(slot, name)}
          >
            {busy ? 'Saving…' : 'Save to pedal'}
          </button>
        </div>
      </div>
    </div>
  );
}
