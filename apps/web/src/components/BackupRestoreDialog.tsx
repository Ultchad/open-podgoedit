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
import { readChosenFile } from '../androidFiles';
import { slotLabel } from '../catalog';
import { subsetBackup, verifyBackup } from '../wasmClient';
import type { BackupVerify, SetlistEntry } from '../types';
import type { BackupTarget } from '../usb/backup';
import type { SetlistKind } from '../usb/setlist';
import { useDialog } from '../useDialog';

const SETLIST_NAMES: Record<number, string> = { 0: 'Factory', 1: 'User' };
const MAX_DIFF_SLOTS = 6;

type BackupScope = 'full' | 'factory' | 'user' | 'custom';

function slotKey(setlist: number, slot: number): string {
  return `${setlist}:${slot}`;
}

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
  /** `null` = both setlists; otherwise only these slots. */
  onCreateBackup: (targets: BackupTarget[] | null) => void;
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
  const [scope, setScope] = useState<BackupScope>('full');
  const [pickSetlist, setPickSetlist] = useState<SetlistKind>(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [restorePicked, setRestorePicked] = useState<Set<string>>(new Set());
  const { dialogRef, onBackdropClick } = useDialog(open, onClose);

  // A new opening starts from a clean slate; the last backup lives in App.
  useEffect(() => {
    if (!open) {
      return;
    }
    setSelected(null);
    setFileError(null);
    setScope('full');
    setPickSetlist(1);
    setPicked(new Set());
    setRestorePicked(new Set());
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
      const bytes = await readChosenFile(file, window.podgoAndroidFiles?.read);
      const summary = verifyBackup(bytes);
      setSelected({ name: file.name, bytes, summary });
      setRestorePicked(
        new Set(
          summary.entries.map((entry) => slotKey(entry.setlist, entry.slot)),
        ),
      );
      setFileError(null);
    } catch (error) {
      setSelected(null);
      setRestorePicked(new Set());
      setFileError(messageOf(error));
    }
  }

  const setlistTargets = (kind: SetlistKind): BackupTarget[] =>
    (setlists[kind] ?? [])
      .filter((entry) => entry.name)
      .map((entry) => ({ setlist: kind, slot: entry.slot }));

  const backupTargets = (): BackupTarget[] | null => {
    if (scope === 'full') {
      return null;
    }
    if (scope === 'factory') {
      return setlistTargets(0);
    }
    if (scope === 'user') {
      return setlistTargets(1);
    }
    return [...picked]
      .map((key) => {
        const [setlist, slot] = key.split(':').map(Number);
        return { setlist: setlist as SetlistKind, slot };
      })
      .sort((a, b) => a.setlist - b.setlist || a.slot - b.slot);
  };
  const scopeTargets = backupTargets();
  const canCreateBackup =
    connected &&
    !busy &&
    !backupBusy &&
    !restoreBusy &&
    (scope === 'full' || (scopeTargets?.length ?? 0) > 0);

  // Only the checked entries are shown in the diff and streamed on restore.
  const selectedEntries = selected
    ? selected.summary.entries.filter((entry) =>
        restorePicked.has(slotKey(entry.setlist, entry.slot)),
      )
    : [];
  const activeSummary: BackupVerify | null = selected
    ? { ...selected.summary, entries: selectedEntries }
    : null;
  const rows = activeSummary
    ? [0, 1].map((setlist) =>
        diffRow(activeSummary, setlist, setlists[setlist as SetlistKind]),
      )
    : [];
  const totalEntries = selectedEntries.length;
  const canRestore =
    connected &&
    writeArmed &&
    !busy &&
    !backupBusy &&
    !restoreBusy &&
    selected !== null &&
    totalEntries > 0;

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
  } else if (totalEntries === 0) {
    missing.push('select at least one preset');
  }
  if (busy || backupBusy || restoreBusy) {
    missing.push('wait for the current operation');
  }

  return (
    <div className="modal-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        tabIndex={-1}
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
          A backup reads the slots you choose (or every non-empty slot) and
          stores each raw <code>l6-helix</code> body verbatim. Restore streams
          the selected bodies back with operation 5. <strong>Restore is
          destructive.</strong> It has not been validated on hardware yet.
        </p>

        <div className="save-backup">
          <div className="save-backup-head">
            <h3>Safety copy (recommended, not required)</h3>
            <button
              id="backup-create"
              type="button"
              disabled={!canCreateBackup}
              onClick={() => onCreateBackup(backupTargets())}
            >
              {backupBusy
                ? 'Backing up…'
                : scope === 'full'
                  ? 'Download full backup'
                  : `Download ${scopeTargets?.length ?? 0} preset(s)`}
            </button>
          </div>

          <div
            className="backup-scope"
            role="radiogroup"
            aria-label="Backup scope"
          >
            {(
              [
                ['full', 'Both setlists'],
                ['factory', 'Factory setlist'],
                ['user', 'User setlist'],
                ['custom', 'Choose slots…'],
              ] as [BackupScope, string][]
            ).map(([value, label]) => (
              <label key={value} className="backup-scope-option">
                <input
                  id={`backup-scope-${value}`}
                  type="radio"
                  name="backup-scope"
                  value={value}
                  checked={scope === value}
                  disabled={backupBusy || restoreBusy}
                  onChange={() => setScope(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {scope === 'custom' && (
            <div className="backup-picker" id="backup-picker">
              <div className="setlist-tabs backup-picker-tabs" role="tablist">
                {([0, 1] as const).map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    role="tab"
                    aria-selected={pickSetlist === kind}
                    className={pickSetlist === kind ? 'is-active' : ''}
                    onClick={() => setPickSetlist(kind)}
                  >
                    {SETLIST_NAMES[kind]}
                  </button>
                ))}
              </div>
              {setlists[pickSetlist] ? (
                (setlists[pickSetlist] ?? []).some((entry) => entry.name) ? (
                  <ul className="backup-pick-list">
                    {(setlists[pickSetlist] ?? [])
                      .filter((entry) => entry.name)
                      .map((entry) => {
                        const key = slotKey(pickSetlist, entry.slot);
                        return (
                          <li key={entry.slot}>
                            <label>
                              <input
                                type="checkbox"
                                data-backup-slot={key}
                                checked={picked.has(key)}
                                disabled={backupBusy || restoreBusy}
                                onChange={() =>
                                  setPicked((current) => {
                                    const next = new Set(current);
                                    if (next.has(key)) {
                                      next.delete(key);
                                    } else {
                                      next.add(key);
                                    }
                                    return next;
                                  })
                                }
                              />
                              <span className="preset-slot">
                                {slotLabel(entry.slot)}
                              </span>
                              <span className="preset-name">{entry.name}</span>
                            </label>
                          </li>
                        );
                      })}
                  </ul>
                ) : (
                  <p className="save-backup-info">
                    This setlist has no non-empty slot.
                  </p>
                )
              ) : (
                <p className="save-backup-info">
                  Setlist not read yet; connect or read it first.
                </p>
              )}
              <p className="save-backup-info" id="backup-picked-count">
                {picked.size} slot(s) selected.
              </p>
            </div>
          )}

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
                <dd>
                  {totalEntries} of {selected.summary.entries.length} selected
                </dd>
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

              <div className="backup-selection" id="restore-selection">
                <div className="save-backup-head">
                  <h3>Presets to restore</h3>
                  <div className="backup-selection-actions">
                    <button
                      id="restore-select-all"
                      type="button"
                      disabled={restoreBusy}
                      onClick={() =>
                        setRestorePicked(
                          new Set(
                            selected.summary.entries.map((entry) =>
                              slotKey(entry.setlist, entry.slot),
                            ),
                          ),
                        )
                      }
                    >
                      All
                    </button>
                    <button
                      id="restore-select-none"
                      type="button"
                      disabled={restoreBusy}
                      onClick={() => setRestorePicked(new Set())}
                    >
                      None
                    </button>
                  </div>
                </div>
                <ul className="backup-pick-list">
                  {selected.summary.entries.map((entry) => {
                    const key = slotKey(entry.setlist, entry.slot);
                    return (
                      <li key={key}>
                        <label>
                          <input
                            type="checkbox"
                            data-restore-entry={key}
                            checked={restorePicked.has(key)}
                            disabled={restoreBusy}
                            onChange={() =>
                              setRestorePicked((current) => {
                                const next = new Set(current);
                                if (next.has(key)) {
                                  next.delete(key);
                                } else {
                                  next.add(key);
                                }
                                return next;
                              })
                            }
                          />
                          <span className="preset-slot">
                            {SETLIST_NAMES[entry.setlist]}{' '}
                            {slotLabel(entry.slot)}
                          </span>
                          <span className="preset-name">
                            {entry.name || 'unnamed'}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>

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
                Selected slots are overwritten; unchecked entries and slots
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
              if (!selected || selectedEntries.length === 0) {
                return;
              }
              try {
                if (selectedEntries.length === selected.summary.entries.length) {
                  onRestore(selected.bytes, selected.summary);
                  return;
                }
                const pairs = new Uint8Array(selectedEntries.length * 2);
                selectedEntries.forEach((entry, index) => {
                  pairs[index * 2] = entry.setlist;
                  pairs[index * 2 + 1] = entry.slot;
                });
                const bytes = subsetBackup(selected.bytes, pairs);
                onRestore(bytes, verifyBackup(bytes));
              } catch (error) {
                setFileError(messageOf(error));
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
