// Full backup and restore dialog.
//
// The dialog collects the file and shows what it would overwrite; every device
// action stays in `App`. Restore is destructive, so it has exactly one gate:
// the user clicks the explicit **Restore N preset(s)** button after the file and
// its destination diff are on screen. `App` then asks one final `window.confirm`
// with the preset count before streaming.
//
// A full backup is offered but **not** required: it is a safety copy the user
// can take in one click, not a precondition. The destination diff stays
// informational — it never blocks on an unread setlist.

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { verifyBackup } from '../wasmClient';
import type { BackupVerify, SetlistEntry } from '../types';
import type { SetlistKind } from '../usb/setlist';

const SETLIST_NAMES: Record<number, string> = { 0: 'Factory', 1: 'User' };
const MAX_DIFF_SLOTS = 6;

interface Props {
  open: boolean;
  connected: boolean;
  writeArmed: boolean;
  /** Another USB operation (read, save) is running. */
  busy: boolean;
  setlists: Record<SetlistKind, SetlistEntry[] | null>;
  /** Last full backup downloaded this session, if any (display only). */
  freshBackup: BackupVerify | null;
  backupBusy: boolean;
  backupError: string | null;
  restoreBusy: boolean;
  restoreError: string | null;
  onClose: () => void;
  onCreateBackup: () => void;
  onRestore: (bytes: Uint8Array, summary: BackupVerify) => void;
}

interface DiffRow {
  setlist: number;
  /** Entries in the file for this setlist. */
  inBackup: number;
  /** Slots the pedal currently holds, or `null` when unread. */
  current: number | null;
  /** Backup slots whose body/name differs from the pedal. */
  replaced: number;
  /** Backup slots that land on a currently empty slot. */
  filling: number;
  /** Current non-empty slots absent from the file (left untouched). */
  kept: number;
  /** Up to a few affected slots, for display. */
  samples: number[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diffRow(
  summary: BackupVerify,
  setlist: number,
  entries: SetlistEntry[] | null,
): DiffRow {
  const inFile = summary.entries.filter((entry) => entry.setlist === setlist);
  if (!entries) {
    return {
      setlist,
      inBackup: inFile.length,
      current: null,
      replaced: 0,
      filling: 0,
      kept: 0,
      samples: [],
    };
  }
  const currentBySlot = new Map(entries.map((entry) => [entry.slot, entry]));
  const fileSlots = new Set(inFile.map((entry) => entry.slot));
  let replaced = 0;
  let filling = 0;
  let kept = 0;
  const samples: number[] = [];
  for (const entry of inFile) {
    const current = currentBySlot.get(entry.slot);
    if (!current || !current.name) {
      filling += 1;
      if (samples.length < MAX_DIFF_SLOTS) {
        samples.push(entry.slot);
      }
    } else if (current.name !== entry.name) {
      replaced += 1;
      if (samples.length < MAX_DIFF_SLOTS) {
        samples.push(entry.slot);
      }
    }
  }
  for (const entry of entries) {
    if (!fileSlots.has(entry.slot) && entry.name) {
      kept += 1;
    }
  }
  return {
    setlist,
    inBackup: inFile.length,
    current: entries.length,
    replaced,
    filling,
    kept,
    samples: samples.sort((a, b) => a - b),
  };
}

export default function BackupRestoreDialog({
  open,
  connected,
  writeArmed,
  busy,
  setlists,
  freshBackup,
  backupBusy,
  backupError,
  restoreBusy,
  restoreError,
  onClose,
  onCreateBackup,
  onRestore,
}: Props) {
  const [selected, setSelected] = useState<{
    name: string;
    bytes: Uint8Array;
    summary: BackupVerify;
  } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // A new opening starts from a clean slate; the last backup lives in App.
  useEffect(() => {
    if (!open) {
      return;
    }
    setSelected(null);
    setFileError(null);
  }, [open]);

  if (!open) {
    return null;
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const summary = verifyBackup(bytes);
      setSelected({ name: file.name, bytes, summary });
      setFileError(null);
    } catch (error) {
      setSelected(null);
      setFileError(messageOf(error));
    }
  }

  const rows = selected
    ? [0, 1].map((setlist) =>
        diffRow(selected.summary, setlist, setlists[setlist as SetlistKind]),
      )
    : [];
  const totalEntries = selected ? selected.summary.entries.length : 0;
  const canRestore =
    connected &&
    writeArmed &&
    !busy &&
    !backupBusy &&
    !restoreBusy &&
    selected !== null;

  // One short line explains a disabled button; no checklist, no typed word.
  const missing: string[] = [];
  if (!connected) {
    missing.push('connect the pedal');
  }
  if (!writeArmed) {
    missing.push('enable editing');
  }
  if (selected === null) {
    missing.push('open a .pgbak file');
  }
  if (busy || backupBusy || restoreBusy) {
    missing.push('wait for the current operation');
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal backup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-dialog-title"
      >
        <div className="modal-head">
          <h2 id="backup-dialog-title">Full backup and restore</h2>
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
          A full backup reads both setlists and every non-empty slot, and stores
          each raw <code>l6-helix</code> body verbatim. Restore streams those
          bodies back with operation 5. <strong>Restore is destructive.</strong>{' '}
          It has not been validated on hardware yet.
        </p>

        <div className="save-backup">
          <div className="save-backup-head">
            <h3>Safety copy (recommended, not required)</h3>
            <button
              id="backup-create"
              type="button"
              disabled={!connected || busy || backupBusy || restoreBusy}
              onClick={onCreateBackup}
            >
              {backupBusy ? 'Backing up…' : 'Download full backup'}
            </button>
          </div>
          {backupError && <p className="save-error">{backupError}</p>}
          {freshBackup ? (
            <dl className="save-backup-info">
              <dt>Presets</dt>
              <dd>{freshBackup.entries.length}</dd>
              <dt>Product / firmware</dt>
              <dd>
                {freshBackup.product || '—'} / {freshBackup.firmware || '—'}
              </dd>
              <dt>SHA-256</dt>
              <dd>
                <code id="backup-fresh-digest">{freshBackup.digest}</code>
              </dd>
              <dt>File</dt>
              <dd>Downloaded as a .pgbak file.</dd>
            </dl>
          ) : (
            <p className="save-backup-info">
              Optional: download the pedal&apos;s current state first. Restore
              does not wait for it.
            </p>
          )}
        </div>

        <div className="save-backup">
          <div className="save-backup-head">
            <h3>Backup file to restore</h3>
            <label className="file">
              <span>Open a .pgbak…</span>
              <input
                id="restore-file"
                type="file"
                accept=".pgbak,application/octet-stream"
                onChange={(event) => void onFile(event)}
              />
            </label>
          </div>
          {fileError && <p className="save-error">{fileError}</p>}
          {selected ? (
            <>
              <dl className="save-backup-info">
                <dt>File</dt>
                <dd>{selected.name}</dd>
                <dt>Presets</dt>
                <dd>{totalEntries}</dd>
                <dt>Product / firmware</dt>
                <dd>
                  {selected.summary.product || '—'} /{' '}
                  {selected.summary.firmware || '—'}
                </dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{selected.summary.digest}</code>
                </dd>
              </dl>

              <h3 className="backup-diff-title">Destination diff</h3>
              <ul className="backup-diff" id="restore-diff">
                {rows.map((row) => (
                  <li key={row.setlist}>
                    <strong>{SETLIST_NAMES[row.setlist]}</strong>:{' '}
                    {row.inBackup} preset(s) to write
                    {row.current === null ? (
                      <> · setlist not read, diff unavailable</>
                    ) : (
                      <>
                        {' '}
                        · {row.replaced} replaced · {row.filling} into empty
                        slot(s) · {row.kept} current slot(s) left untouched
                        {row.samples.length > 0
                          ? ` · slots ${row.samples.join(', ')}${
                              row.replaced + row.filling > row.samples.length
                                ? '…'
                                : ''
                            }`
                          : ''}
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="save-backup-info">
                Current contents of the target slots are overwritten; slots
                absent from the file are left as they are. One confirmation
                follows.
              </p>
            </>
          ) : (
            <p className="save-backup-info">
              Open a verified <code>.pgbak</code> file to see what it would
              overwrite.
            </p>
          )}
        </div>

        {restoreError && <p className="save-error">{restoreError}</p>}

        {!canRestore && missing.length > 0 && (
          <p className="save-hint" id="restore-blockers">
            To enable restore: {missing.join(', ')}.
          </p>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={restoreBusy}>
            Close
          </button>
          <button
            id="restore-confirm"
            type="button"
            className="save-confirm"
            disabled={!canRestore}
            title={canRestore ? 'Restore and confirm' : missing.join(', ')}
            onClick={() => {
              if (selected) {
                onRestore(selected.bytes, selected.summary);
              }
            }}
          >
            {restoreBusy
              ? 'Restoring…'
              : selected
                ? `Restore ${totalEntries} preset(s)`
                : 'Restore'}
          </button>
        </div>
      </div>
    </div>
  );
}
