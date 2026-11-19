// Read-only import of POD Go Edit's own files.
//
// `.pgp` is a single-preset JSON export; `.pgb` is the AF6L backup container.
// The dialog only reads and previews: an imported preset has no `l6-helix`
// body, so the page cannot write it to the pedal or rebuild an export.
//
// Privacy: the file stays in this tab. It is not uploaded, cached or persisted,
// and closing the dialog drops the parsed copy.

import { useEffect, useMemo, useRef, useState } from 'react';
import { slotLabel } from '../catalog';
import {
  decodeFirmware,
  parsePodgoEditFile,
  presetCount,
  productLabel,
  SLOT_COUNT,
  toneToStructure,
  type EditFile,
  type EditBackup,
  type EditPreset,
  type EditSetlist,
} from '../podgoEdit';
import type { PresetStructure } from '../types';
import { useDialog } from '../useDialog';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Hand the chosen preset to the page. A `.pgb` entry carries its source slot
   * so it can land where the backup had it; a `.pgp` has no setlist.
   */
  onOpenPreset: (
    preset: EditPreset,
    label: string,
    source: { setlist: number; slot: number } | null,
    backup: EditBackup | null,
  ) => void;
}

function firstPresetSlot(setlist: EditSetlist | undefined): number | null {
  if (!setlist) {
    return null;
  }
  const index = setlist.presets.findIndex((preset) => preset !== null);
  return index < 0 ? null : index;
}

function blockCount(structure: PresetStructure): number {
  return structure.chain.filter(
    (entry) =>
      entry.kind === 'block' ||
      entry.kind === 'looper' ||
      entry.kind === 'unknown',
  ).length;
}

function selectedLabel(
  file: EditFile,
  preset: EditPreset | null,
): string {
  if (!preset) {
    return '';
  }
  if (file.kind === 'pgp') {
    return `POD Go Edit .pgp${
      preset.buildSha ? ` (${preset.buildSha})` : ''
    } — offline copy`;
  }
  const setlist = file.setlists[preset.setlist ?? 0];
  const slot = preset.slot ?? 0;
  return `POD Go Edit .pgb — ${setlist?.name ?? 'setlist'} ${slotLabel(
    slot,
  )} — offline copy`;
}

export default function PodgoEditImportDialog({
  open,
  onClose,
  onOpenPreset,
}: Props) {
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<EditFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [setlistIndex, setSetlistIndex] = useState(0);
  const [slot, setSlot] = useState<number | null>(null);
  const token = useRef(0);
  const { dialogRef, onBackdropClick } = useDialog(open, onClose);

  useEffect(() => {
    if (!open) {
      token.current += 1;
      setFileName('');
      setFile(null);
      setError(null);
      setLoading(false);
      setSetlistIndex(0);
      setSlot(null);
    }
  }, [open]);

  const selected = useMemo<EditPreset | null>(() => {
    if (!file) {
      return null;
    }
    if (file.kind === 'pgp') {
      return file.preset;
    }
    const setlist = file.setlists[setlistIndex];
    if (!setlist || slot === null) {
      return null;
    }
    return setlist.presets[slot] ?? null;
  }, [file, setlistIndex, slot]);

  const structure = useMemo<PresetStructure | null>(() => {
    if (!selected) {
      return null;
    }
    try {
      return toneToStructure(selected);
    } catch {
      return null;
    }
  }, [selected]);

  async function readFile(chosen: File): Promise<void> {
    const current = token.current + 1;
    token.current = current;
    setLoading(true);
    setError(null);
    setFile(null);
    setFileName(chosen.name);
    try {
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      const parsed = await parsePodgoEditFile(bytes);
      if (token.current !== current) {
        return;
      }
      setFile(parsed);
      if (parsed.kind === 'pgp') {
        setSlot(null);
      } else {
        setSetlistIndex(0);
        setSlot(firstPresetSlot(parsed.setlists[0]));
      }
    } catch (failure) {
      if (token.current !== current) {
        return;
      }
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token.current === current) {
        setLoading(false);
      }
    }
  }

  if (!open) {
    return null;
  }

  const activeSetlist =
    file?.kind === 'pgb' ? file.setlists[setlistIndex] : undefined;
  const totalPresets =
    file?.kind === 'pgb'
      ? file.setlists.reduce((sum, setlist) => sum + presetCount(setlist), 0)
      : 0;

  return (
    <div className="modal-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
      >
        <div className="modal-head">
          <h2 id="import-dialog-title">Import POD Go Edit files</h2>
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
          Open a <code>.pgp</code> preset export or a <code>.pgb</code> full
          backup. The file is read in this tab only: nothing is uploaded,
          written back or saved. An imported preset becomes an{' '}
          <strong>offline copy</strong> you can edit and export as{' '}
          <code>.pgp</code>, or rebuild the backup as <code>.pgb</code>; this
          build cannot write its JSON back to the pedal. This is an unofficial
          tool: use it at your own risk and keep a backup.
        </p>

        <label className="file import-file">
          <span>Choose a .pgp or .pgb file…</span>
          <input
            id="import-file"
            type="file"
            accept=".pgp,.pgb,application/json,application/octet-stream"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) {
                void readFile(chosen);
              }
            }}
          />
        </label>

        {fileName && (
          <p className="save-backup-info" id="import-file-name">
            <strong>{fileName}</strong>
          </p>
        )}
        {loading && <p className="progress">Reading the file…</p>}
        {error && (
          <pre className="report error compact" id="import-error">
            {error}
          </pre>
        )}

        {file && (
          <div id="import-summary">
            <dl className="save-backup-info">
              <dt>Format</dt>
              <dd>{file.kind === 'pgp' ? '.pgp preset' : '.pgb backup'}</dd>
              {file.kind === 'pgp' ? (
                <>
                  <dt>Preset</dt>
                  <dd id="import-preset-name">{file.preset.name || 'unnamed'}</dd>
                  <dt>Product / firmware</dt>
                  <dd>
                    {structure?.product || '—'} / {structure?.firmware || '—'}
                  </dd>
                  <dt>Blocks</dt>
                  <dd>{structure ? blockCount(structure) : 0}</dd>
                </>
              ) : (
                <>
                  <dt>Presets</dt>
                  <dd>{totalPresets}</dd>
                  {file.deviceVersion !== null && (
                    <>
                      <dt>Product / firmware</dt>
                      <dd>
                        {productLabel(file.device)} /{' '}
                        {decodeFirmware(file.deviceVersion)}
                      </dd>
                    </>
                  )}
                  <dt>Setlists</dt>
                  <dd>
                    {file.setlists
                      .map((setlist) => setlist.name)
                      .join(', ') || '—'}
                  </dd>
                  <dt>IR members</dt>
                  <dd>{file.irCount}</dd>
                </>
              )}
            </dl>

            {file.kind === 'pgb' && (
              <>
                <div className="import-setlists" role="tablist">
                  {file.setlists.map((setlist, index) => (
                    <button
                      key={`${setlist.name}-${index}`}
                      type="button"
                      role="tab"
                      aria-selected={index === setlistIndex}
                      className={`import-setlist-tab${
                        index === setlistIndex ? ' is-active' : ''
                      }`}
                      onClick={() => {
                        setSetlistIndex(index);
                        setSlot(firstPresetSlot(setlist));
                      }}
                    >
                      {setlist.name} ({presetCount(setlist)})
                    </button>
                  ))}
                </div>

                <div className="import-slots" id="import-slots">
                  {Array.from({ length: SLOT_COUNT }, (_, index) => {
                    const preset = activeSetlist?.presets[index] ?? null;
                    return (
                      <button
                        key={index}
                        type="button"
                        className={`import-slot${
                          index === slot ? ' is-selected' : ''
                        }${preset ? '' : ' is-empty'}`}
                        data-slot={index}
                        title={preset?.name || 'Empty slot'}
                        disabled={!preset}
                        onClick={() => setSlot(index)}
                      >
                        <span className="import-slot-label">
                          {slotLabel(index)}
                        </span>
                        <span className="import-slot-name">
                          {preset?.name || 'empty'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {selected && structure && (
              <div className="import-detail" id="import-detail">
                <strong>{selected.name || 'unnamed'}</strong>
                {file.kind === 'pgb' && selected.slot !== null && (
                  <span> · {slotLabel(selected.slot)}</span>
                )}
                <span>
                  {' '}
                  · {blockCount(structure)} block(s) ·{' '}
                  {structure.footswitches.length} footswitch assignment(s) ·{' '}
                  {structure.controllers.length} controller(s)
                </span>
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button
            id="import-open"
            type="button"
            className="save-confirm"
            disabled={!selected}
            onClick={() => {
              if (selected && file) {
                onOpenPreset(
                  selected,
                  selectedLabel(file, selected),
                  file.kind === 'pgb' && slot !== null
                    ? { setlist: setlistIndex, slot }
                    : null,
                  file.kind === 'pgb' ? file : null,
                );
              }
            }}
          >
            Open in editor
          </button>
        </div>
      </div>
    </div>
  );
}
