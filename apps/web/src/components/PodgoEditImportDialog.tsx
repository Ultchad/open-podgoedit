// Read-only import of POD Go Edit's own files, and selective export of backups.
//
// `.pgp` is a single-preset JSON export; `.pgb` is the AF6L backup container.
// A `.pgb` carries up to two setlists (Factory `SL00`, User `SL01`), impulse
// responses (`I000`…, RIFF/WAVE) and globals (`GLOB`), so both directions let
// the user pick which of those groups to touch. Untouched members keep their
// exact bytes on export.
//
// Privacy: the file stays in this tab. It is not uploaded, cached or persisted,
// and closing the dialog drops the parsed copy.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { readChosenFile } from '../androidFiles';
import { slotLabel } from '../catalog';
import {
  backupContent,
  decodeFirmware,
  parsePodgoEditFile,
  presetCount,
  productLabel,
  setlistInSelection,
  SLOT_COUNT,
  toneToStructure,
  type BackupContentSelection,
  type BackupSlotSelection,
  type EditFile,
  type EditBackup,
  type EditPreset,
  type EditSetlist,
} from '../podgoEdit';
import type { PresetStructure } from '../types';
import { useDialog } from '../useDialog';

type Mode = 'import' | 'export';

const ALL_CONTENT: BackupContentSelection = {
  factory: true,
  user: true,
  irs: true,
  globals: true,
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** True when a slot's right-click menu opened the dialog for one preset. */
  singleSlot: boolean;
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
  /** Import every non-empty preset of the selected setlists as offline copies. */
  onImportBackup: (
    backup: EditBackup,
    selection: BackupContentSelection,
    slots?: BackupSlotSelection[],
  ) => void | Promise<void>;
  /**
   * Download the `.pgb` subset, or a single `.pgp` when `singlePreset` is set
   * and only one user slot is selected.
   */
  onExportBackup: (
    backup: EditBackup,
    selection: BackupContentSelection,
    slots?: BackupSlotSelection[],
    singlePreset?: EditPreset | null,
  ) => Promise<void>;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedLabel(file: EditFile, preset: EditPreset | null): string {
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
  singleSlot,
  onOpenPreset,
  onImportBackup,
  onExportBackup,
}: Props) {
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<EditFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>('import');
  const [content, setContent] = useState<BackupContentSelection>(ALL_CONTENT);
  const [slotSets, setSlotSets] = useState<Map<string, Set<number>>>(new Map());
  const [setlistIndex, setSetlistIndex] = useState(0);
  const [slot, setSlot] = useState<number | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const token = useRef(0);
  const { dialogRef, onBackdropClick } = useDialog(open, onClose);

  useEffect(() => {
    if (!open) {
      token.current += 1;
      setFileName('');
      setFile(null);
      setError(null);
      setLoading(false);
      setMode('import');
      setContent(ALL_CONTENT);
      setSlotSets(new Map());
      setSetlistIndex(0);
      setSlot(null);
      setActionBusy(false);
      setActionError(null);
      setExportBusy(false);
      setExportError(null);
    }
  }, [open]);

  const summary = useMemo(
    () => (file?.kind === 'pgb' ? backupContent(file) : null),
    [file],
  );

  // Only the selected setlists are offered. `setlistIndex` keeps the original
  // index so opening a preset still records where it came from.
  const visibleIndexes = useMemo(() => {
    if (file?.kind !== 'pgb') {
      return [];
    }
    return file.setlists
      .map((setlist, index) =>
        setlistInSelection(setlist, content) ? index : -1,
      )
      .filter((index) => index >= 0);
  }, [file, content]);

  const currentIndex = visibleIndexes.includes(setlistIndex)
    ? setlistIndex
    : (visibleIndexes[0] ?? -1);
  const activeSetlist =
    file?.kind === 'pgb' && currentIndex >= 0
      ? file.setlists[currentIndex]
      : undefined;

  const selected = useMemo<EditPreset | null>(() => {
    if (!file) {
      return null;
    }
    if (file.kind === 'pgp') {
      return file.preset;
    }
    if (!activeSetlist || slot === null) {
      return null;
    }
    return activeSetlist.presets[slot] ?? null;
  }, [file, activeSetlist, slot]);

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

  /** Presets a bulk import would add (respecting any fine-grained slot ticks). */
  const importCount = useMemo(() => {
    if (file?.kind !== 'pgb') {
      return 0;
    }
    return file.setlists
      .filter((setlist) => setlistInSelection(setlist, content))
      .reduce((sum, setlist) => {
        const restricted = slotSets.get(setlist.memberTag ?? '');
        const anyRestricted =
          restricted !== undefined && restricted.size > 0;
        return (
          sum +
          setlist.presets.reduce(
            (count, preset, slot) =>
              count +
              (preset !== null &&
              (!anyRestricted || restricted!.has(slot))
                ? 1
                : 0),
            0,
          )
        );
      }, 0);
  }, [file, content, slotSets]);

  const nothingSelected =
    !content.factory && !content.user && !content.irs && !content.globals;

  async function readFile(chosen: File): Promise<void> {
    const current = token.current + 1;
    token.current = current;
    setLoading(true);
    setError(null);
    setFile(null);
    setFileName(chosen.name);
    setActionError(null);
    setExportError(null);
    setMode('import');
    setContent(ALL_CONTENT);
    setSlotSets(new Map());
    try {
      const bytes = await readChosenFile(chosen);
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
      setError(messageOf(failure));
    } finally {
      if (token.current === current) {
        setLoading(false);
      }
    }
  }

  function toggleContent(
    key: keyof BackupContentSelection,
    value: boolean,
  ): void {
    const next = { ...content, [key]: value };
    setContent(next);
    if (file?.kind !== 'pgb') {
      return;
    }
    const current = file.setlists[setlistIndex];
    if (!current || setlistInSelection(current, next)) {
      return;
    }
    const index = file.setlists.findIndex((setlist) =>
      setlistInSelection(setlist, next),
    );
    if (index >= 0) {
      setSetlistIndex(index);
      setSlot(firstPresetSlot(file.setlists[index]));
    } else {
      setSetlistIndex(0);
      setSlot(null);
    }
  }

  /** Toggle one slot in a setlist's fine-grained selection. */
  function toggleSlot(tag: string, slot: number): void {
    const next = new Map(slotSets);
    const current = new Set(next.get(tag) ?? []);
    if (current.has(slot)) {
      current.delete(slot);
    } else {
      current.add(slot);
    }
    next.set(tag, current);
    setSlotSets(next);
  }

  /** Build the slot list to hand to import/export, from any non-empty sets. */
  function slotSelection(): BackupSlotSelection[] {
    const out: BackupSlotSelection[] = [];
    for (const [tag, slots] of slotSets) {
      if (slots.size > 0) {
        out.push({ tag, slots });
      }
    }
    return out;
  }

  function slotIsSelected(slot: number): boolean {
    const selected = slotSets.get(activeSetlist?.memberTag ?? '');
    return selected === undefined || selected.size === 0 || selected.has(slot);
  }

  async function importLibrary(): Promise<void> {
    if (file?.kind !== 'pgb' || actionBusy) {
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      await onImportBackup(file, content, slotSelection());
      onClose();
    } catch (failure) {
      setActionError(messageOf(failure));
    } finally {
      setActionBusy(false);
    }
  }

  async function exportBackup(): Promise<void> {
    if (file?.kind !== 'pgb' || exportBusy) {
      return;
    }
    setExportBusy(true);
    setExportError(null);
    try {
      // Always build the .pgb subset; the separate "Export .pgp" button handles
      // a single ticked User preset.
      await onExportBackup(file, content, slotSelection(), null);
      onClose();
    } catch (failure) {
      setExportError(messageOf(failure));
    } finally {
      setExportBusy(false);
    }
  }

  async function exportSinglePgp(): Promise<void> {
    if (file?.kind !== 'pgb' || exportBusy) {
      return;
    }
    const preset = singlePresetSource();
    if (!preset) {
      return;
    }
    setExportBusy(true);
    setExportError(null);
    try {
      await onExportBackup(file, content, slotSelection(), preset);
      onClose();
    } catch (failure) {
      setExportError(messageOf(failure));
    } finally {
      setExportBusy(false);
    }
  }

  /**
   * Detect a single-preset export: one user setlist is selected, exactly one of
   * its presets is ticked, and no other group is selected.
   */
  function singlePresetSource(): EditPreset | null {
    if (file?.kind !== 'pgb' || !content.user || content.factory || content.irs || content.globals) {
      return null;
    }
    const userSet = file.setlists.find(
      (setlist) => setlist.memberTag === 'SL01',
    );
    if (!userSet) {
      return null;
    }
    const selected = slotSets.get('SL01');
    if (!selected || selected.size !== 1) {
      return null;
    }
    const slot = [...selected][0];
    return userSet.presets[slot] ?? null;
  }

  if (!open) {
    return null;
  }

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
          <h2 id="import-dialog-title">Import / Export POD Go files</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="import-modes" role="tablist" aria-label="Direction">
          <button
            id="ie-mode-import"
            type="button"
            role="tab"
            aria-selected={mode === 'import'}
            className={`import-mode${mode === 'import' ? ' is-active' : ''}`}
            onClick={() => setMode('import')}
          >
            Import
          </button>
          <button
            id="ie-mode-export"
            type="button"
            role="tab"
            aria-selected={mode === 'export'}
            className={`import-mode${mode === 'export' ? ' is-active' : ''}`}
            onClick={() => setMode('export')}
          >
            Export
          </button>
        </div>

        <p className="modal-hint">
          {mode === 'import' ? (
            <>
              Open a <code>.pgp</code> preset export or a <code>.pgb</code> full
              backup. Choose which parts to bring in, then open one preset or
              add the selected setlists to the offline library. The file is
              read in this tab only: nothing is uploaded, written back or
              saved. This build cannot write imported JSON to the pedal.
            </>
          ) : (
            <>
              Rebuild the chosen parts of a <code>.pgb</code> backup and download
              it. Selected members keep their exact bytes; unselected parts are
              dropped. The file is built in this tab and never uploaded.
            </>
          )}{' '}
          This is an unofficial tool: use it at your own risk and keep a backup.
        </p>

        <label className="file import-file">
          <span>Choose a .pgp or .pgb file…</span>
          <input
            id="import-file"
            type="file"
            accept=".pgp,.pgb,application/json,application/octet-stream"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
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
                  <dd id="import-preset-name">
                    {file.preset.name || 'unnamed'}
                  </dd>
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

            {file.kind === 'pgb' && summary && (
              <fieldset className="import-content">
                <legend>
                  {mode === 'import' ? 'What to import' : 'What to export'}
                </legend>
                <label>
                  <input
                    id="ie-content-factory"
                    type="checkbox"
                    checked={content.factory}
                    onChange={(event) =>
                      toggleContent('factory', event.target.checked)
                    }
                  />
                  Factory presets ({summary.factory})
                </label>
                <label>
                  <input
                    id="ie-content-user"
                    type="checkbox"
                    checked={content.user}
                    onChange={(event) =>
                      toggleContent('user', event.target.checked)
                    }
                  />
                  User presets ({summary.user})
                </label>
                <label>
                  <input
                    id="ie-content-irs"
                    type="checkbox"
                    checked={content.irs}
                    onChange={(event) =>
                      toggleContent('irs', event.target.checked)
                    }
                  />
                  Impulse responses ({summary.irs})
                </label>
                <label>
                  <input
                    id="ie-content-globals"
                    type="checkbox"
                    checked={content.globals}
                    onChange={(event) =>
                      toggleContent('globals', event.target.checked)
                    }
                  />
                  Globals
                </label>
              </fieldset>
            )}

            {file.kind === 'pgb' && summary && summary.irs > 0 && (
              <p className="modal-hint import-ir-note">
                Impulse responses have no editor in this build. They are kept in
                the file and copied byte for byte on export; importing them only
                keeps them available for a later export.
              </p>
            )}

            {(mode === 'import' || mode === 'export') && file.kind === 'pgb' && (
              <>
                <div className="import-setlists" role="tablist">
                  {visibleIndexes.map((index) => {
                    const setlist = file.setlists[index];
                    return (
                      <button
                        key={`${setlist.name}-${index}`}
                        type="button"
                        role="tab"
                        aria-selected={index === currentIndex}
                        className={`import-setlist-tab${
                          index === currentIndex ? ' is-active' : ''
                        }`}
                        onClick={() => {
                          setSetlistIndex(index);
                          setSlot(firstPresetSlot(setlist));
                        }}
                      >
                        {setlist.name} ({presetCount(setlist)})
                      </button>
                    );
                  })}
                </div>

                {activeSetlist ? (
                  <>
                    <p className="modal-hint import-slot-tip">
                      {mode === 'export'
                        ? 'Tick the presets to export; leaving them all ticked keeps the whole setlist.'
                        : 'Tick the presets to import, or leave them all ticked for the whole setlist.'}
                    </p>
                    <div className="import-slots" id="import-slots">
                    {Array.from({ length: SLOT_COUNT }, (_, index) => {
                      const preset = activeSetlist.presets[index] ?? null;
                      const tag = activeSetlist.memberTag ?? '';
                      const ticked =
                        preset !== null && slotIsSelected(index);
                      const selectedNow = mode === 'import' && index === slot;
                      return (
                        <button
                          key={index}
                          type="button"
                          className={`import-slot${
                            ticked ? ' is-ticked' : ''
                          }${selectedNow ? ' is-selected' : ''}${
                            preset ? '' : ' is-empty'
                          }`}
                          data-slot={index}
                          title={preset?.name || 'Empty slot'}
                          disabled={!preset}
                          onClick={() => {
                            // In both modes a click ticks the slot into the
                            // fine-grained selection; in import mode it also
                            // selects it for "Open in editor".
                            toggleSlot(tag, index);
                            if (mode === 'import') {
                              setSlot(index);
                            }
                          }}
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
                ) : (
                  <p className="modal-hint" id="import-no-setlist">
                    Select Factory or User presets to browse slots.
                  </p>
                )}
              </>
            )}

            {mode === 'import' && selected && structure && (
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

            {mode === 'export' && file.kind === 'pgp' && (
              <p className="modal-hint" id="export-pgp-hint">
                A single <code>.pgp</code> preset is exported with the{' '}
                <strong>Export</strong> button in the editor. Selective backup
                export needs a <code>.pgb</code> file.
              </p>
            )}
            {mode === 'export' && file.kind === 'pgb' && (
              <p className="modal-hint" id="export-backup-hint">
                {nothingSelected
                  ? 'Choose at least one part to export.'
                  : 'The downloaded backup contains only the parts checked above.'}{' '}
                Tick the preset slots you want; unticked presets are emptied.
                Tick exactly one User preset to also get a single *.pgp* export.
                Unsaved edits in the editor are not included; use{' '}
                <strong>Export .pgb</strong> there to write the working slot.
              </p>
            )}
          </div>
        )}

        {actionError && (
          <pre className="report error compact" id="import-action-error">
            {actionError}
          </pre>
        )}
        {exportError && (
          <pre className="report error compact" id="export-file-error">
            {exportError}
          </pre>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          {mode === 'import' ? (
            <>
              {!singleSlot && (
                <button
                  id="import-library"
                  type="button"
                  className="toolbar-button"
                  disabled={
                    file?.kind !== 'pgb' || importCount === 0 || actionBusy
                  }
                  onClick={() => void importLibrary()}
                  title="Add every non-empty preset of the checked setlists to the offline library"
                >
                  {actionBusy
                    ? 'Importing…'
                    : `Import ${importCount} preset(s)`}
                </button>
              )}
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
                        ? { setlist: currentIndex, slot }
                        : null,
                      file.kind === 'pgb' ? file : null,
                    );
                  }
                }}
              >
                Open in editor
              </button>
            </>
          ) : (
            <>
              <button
                id="export-backup-file"
                type="button"
                className="save-confirm"
                disabled={
                  file?.kind !== 'pgb' || exportBusy || nothingSelected
                }
                onClick={() => void exportBackup()}
              >
                {exportBusy ? 'Exporting…' : 'Export .pgb'}
              </button>
              {singlePresetSource() && (
                <button
                  id="export-single-pgp"
                  type="button"
                  className="toolbar-button"
                  disabled={exportBusy}
                  onClick={() => void exportSinglePgp()}
                  title="Download just the one ticked user preset as a .pgp file"
                >
                  Export .pgp
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
