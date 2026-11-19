// Preset editor pane: toolbar, signal chain and inspector, in the POD Go Edit
// layout. The values come from the structured view rendered by the Rust core.
// Parameter edits update the working copy only; the page writes them when the
// user saves. Toolbar actions stay deliberately small: rename and export live
// here, everything else is in the header or the right-click menu.

import { useEffect, useMemo, useState } from 'react';
import {
  categoryColor,
  modelById,
  processingChain,
  slotLabel,
} from '../catalog';
import { MAX_SNAPSHOT_NAME_LENGTH } from '../presetName';
import {
  // SNAPSHOT_LED_COLORS,
  snapshotLedColor,
} from '../snapshot';
import type { CatalogModel, PresetStructure, Selection } from '../types';
import BlockInspector from './BlockInspector';
import SignalChain from './SignalChain';
import SnapshotMenu from './SnapshotMenu';

interface Props {
  structure: PresetStructure;
  source: string;
  busy: boolean;
  /** The working copy changed since it was opened or saved. */
  dirty: boolean;
  /** The preset has an offline JSON document that can be exported. */
  offline: boolean;
  /** This preset can be edited in the page right now (drafts only). */
  editable: boolean;
  /** Hint shown above the parameter controls. */
  editHint: string | null;
  onEditParam: (block: number, paramIndex: number, value: number) => void;
  /** Load a model into the selected block (may build an editable copy). */
  onSelectModel?: (index: number | null, model: CatalogModel) => void;
  /** Report the selected chain position so page-level shortcuts know the target. */
  onSelectionChange?: (selection: Selection) => void;
  /** Bounded undo/redo for edits to this preset. */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Create an editable offline copy of a pedal-read preset. */
  onEditCopy?: () => void;
  /** Reorder blocks by drag and drop; absent for read-only presets. */
  onMoveBlock?: (from: number, to: number) => void;
  /** Select one snapshot in an offline draft. */
  onSelectSnapshot?: (index: number) => void;
  /** Rename one snapshot; absent for read-only presets. */
  onRenameSnapshot?: (index: number, name: string) => void;
  /** Change a snapshot's LED palette colour; absent for read-only presets. */
  onSetSnapshotLedColor?: (index: number, color: number) => void;
  /** Assign or remove the Snapshots controller on a parameter. */
  onToggleSnapshotParam?: (
    block: number,
    paramIndex: number,
    assigned: boolean,
  ) => void;
  /** Bypass or enable a block in the active snapshot. */
  onSetBlockEnabled?: (block: number, enabled: boolean) => void;
  canExport: boolean;
  onExport: () => void;
  /** The working copy came from a `.pgb` backup that can be rebuilt. */
  canExportBackup: boolean;
  onExportBackup: () => void;
  canRename: boolean;
  onRename: () => void;
}

const SETLISTS = ['Factory', 'User'] as const;

export default function PresetView({
  structure,
  source,
  busy,
  dirty,
  offline,
  editable,
  editHint,
  onEditParam,
  onSelectModel,
  onSelectionChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onEditCopy,
  onMoveBlock,
  onSelectSnapshot,
  onRenameSnapshot,
  onSetSnapshotLedColor,
  onToggleSnapshotParam,
  onSetBlockEnabled,
  canExport,
  onExport,
  canExportBackup,
  onExportBackup,
  // canRename,
  // onRename,
}: Props) {
  const processing = processingChain(structure.chain);
  const [selected, setSelected] = useState<Selection>(() =>
    firstSelection(processing),
  );
  const [editingSnapshot, setEditingSnapshot] = useState<number | null>(null);
  const [snapshotDraft, setSnapshotDraft] = useState('');
  const [snapshotMenu, setSnapshotMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  const [longPressTimer, setLongPressTimer] = useState<number | null>(null);

  // Reset on a new preset, not on an edit: a parameter write replaces the
  // structure object, and resetting there would jump back to the first slot.
  const presetKey = `${structure.preset.setlist}:${structure.preset.slot}:${structure.preset.name}`;
  useEffect(() => {
    setSelected(firstSelection(processingChain(structure.chain)));
    setEditingSnapshot(null);
    setSnapshotMenu(null);
  }, [presetKey]);

  // The page owns copy/paste shortcuts, so it needs the current selection.
  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);

  const selectedEntry =
    selected === 'input'
      ? (structure.chain.find((entry) => entry.kind === 'input') ?? null)
      : selected === 'output'
        ? (structure.chain.find((entry) => entry.kind === 'output') ?? null)
        : (processing[selected] ?? null);

  // Categories already used by the *other* blocks: a preset has at most one
  // Amp, Cab, Vol, Wah, Send/Return and Looper.
  const usedModelCategories = useMemo(() => {
    const used = new Set<string>();
    const skip = selectedIndex(selected);
    for (const item of structure.chain) {
      if (item.kind !== 'block' && item.kind !== 'looper') {
        continue;
      }
      if (skip !== null && item.slot === skip + 1) {
        continue;
      }
      const category = modelById(item.modelId)?.category;
      if (category) {
        used.add(category);
      }
    }
    return used;
  }, [structure.chain, selected]);

  const assignments = new Map<number, string>();
  for (const fs of structure.footswitches) {
    // Key 8 of a switch target is the 1-based processing slot.
    assignments.set(fs.block - 1, fs.switch);
  }

  const slot = structure.preset.slot;
  const name = structure.preset.name || 'Active preset';
  const setlist =
    structure.preset.setlist === 0 || structure.preset.setlist === 1
      ? SETLISTS[structure.preset.setlist]
      : null;

  const snapshotIndex =
    structure.currentSnapshot !== null &&
    structure.currentSnapshot >= 0 &&
    structure.currentSnapshot < structure.snapshots.length
      ? structure.currentSnapshot
      : 0;
  const activeSnapshot = structure.snapshots[snapshotIndex] ?? null;
  // const activeLed = snapshotLedColor(activeSnapshot?.ledColor ?? 0);
  const snapshotEditable = Boolean(
    onRenameSnapshot || onSelectSnapshot || onSetSnapshotLedColor,
  );
  const menuSnapshot =
    snapshotMenu && structure.snapshots[snapshotMenu.index]
      ? structure.snapshots[snapshotMenu.index]
      : null;

  // Mobile long-press helpers
  const startLongPress = (index: number, event: React.TouchEvent) => {
    if (!snapshotEditable) return;
    const timer = window.setTimeout(() => {
      const touch = event.touches[0];
      setSnapshotMenu({ x: touch.clientX, y: touch.clientY, index });
    }, 500);
    setLongPressTimer(timer as unknown as number);
  };

  const cancelLongPress = () => {
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      setLongPressTimer(null);
    }
  };

  // Base controller assignments and the values the active snapshot recalls for
  // the selected block. The inspector uses both to draw the camera toggle and
  // the bypass button.
  const blockIndex = selectedIndex(selected);
  const snapshotAssignments = new Map<number, number>();
  const snapshotValues = new Set<number>();
  if (blockIndex !== null) {
    for (const controller of structure.controllers) {
      if (controller.block === blockIndex) {
        snapshotAssignments.set(controller.paramIndex, controller.controller);
      }
    }
    for (const value of activeSnapshot?.controllers ?? []) {
      if (value.block === blockIndex) {
        snapshotValues.add(value.paramIndex);
      }
    }
  }

  /** Start editing a snapshot label inline (double-click on the chip). */
  function startSnapshotRename(index: number): void {
    if (!onRenameSnapshot) {
      return;
    }
    setSnapshotDraft(structure.snapshots[index]?.name ?? '');
    setEditingSnapshot(index);
  }

  /** Enter accepts; anything else cancels (blur keeps the old name). */
  function commitSnapshotRename(): void {
    if (editingSnapshot === null) {
      return;
    }
    const index = editingSnapshot;
    setEditingSnapshot(null);
    onRenameSnapshot?.(index, snapshotDraft.trim());
  }

  return (
    <div className="preset-view">
      <div className="editor-toolbar">
        <div className="preset-title">
          <span className="preset-slot">{slot !== null ? slotLabel(slot) : '——'}</span>
          <span
            className={`preset-title-name${
              dirty || offline ? ' is-unsaved' : ''
            }`}
            title={
              offline
                ? 'Browser copy — not stored on the pedal yet'
                : dirty
                  ? 'Unsaved changes — press Save to write them to the pedal'
                  : 'Preset read from the pedal'
            }
          >
            {name}
          </span>
          <span
            className={[
              'readonly-chip',
              dirty ? 'is-dirty' : '',
              offline ? 'is-offline' : '',
              editable ? 'is-editable' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {dirty
              ? 'unsaved changes'
              : offline
                ? 'offline'
                : editable
                  ? 'draft'
                  : 'read-only'}
          </span>
        </div>

        <div className="snapshot-row" aria-label="Snapshots">
          {structure.snapshots.slice(0, 4).map((snapshot, index) => {
            if (editingSnapshot === index) {
              return (
                <input
                  key={`edit-${index}`}
                  className="snapshot snapshot-input"
                  aria-label={`Snapshot ${index + 1} name`}
                  value={snapshotDraft}
                  maxLength={MAX_SNAPSHOT_NAME_LENGTH}
                  autoFocus
                  title={`Snapshot name — up to ${MAX_SNAPSHOT_NAME_LENGTH} characters, Enter to accept`}
                  onChange={(event) => {
                    const next = event.target.value
                      .replace(/[^\x20-\x7e]/g, '')
                      .slice(0, MAX_SNAPSHOT_NAME_LENGTH);
                    setSnapshotDraft(next);
                  }}
                  onBlur={() => setEditingSnapshot(null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitSnapshotRename();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditingSnapshot(null);
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                />
              );
            }
            const fallback = `SNAPSHOT ${index + 1}`;
            const label = snapshot.name || fallback;
            const custom = label.toUpperCase() !== fallback;
            const editableSnapshot = Boolean(
              onSelectSnapshot || onRenameSnapshot,
            );
            const led = snapshotLedColor(snapshot.ledColor);
            return (
              <button
                key={index}
                type="button"
                className={`snapshot${snapshot.valid ? '' : ' is-empty'}${
                  structure.currentSnapshot === index ? ' is-active' : ''
                }`}
                disabled={!editableSnapshot}
                title={
                  editableSnapshot
                    ? `${label} — tap to select, double-tap to rename, long-press for actions`
                    : label
                }
                onClick={() => onSelectSnapshot?.(index)}
                onDoubleClick={() => startSnapshotRename(index)}
                onTouchStart={(e) => startLongPress(index, e)}
                onTouchEnd={cancelLongPress}
                onTouchCancel={cancelLongPress}
                onContextMenu={(event) => {
                  if (!snapshotEditable) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  setSnapshotMenu({
                    x: event.clientX,
                    y: event.clientY,
                    index,
                  });
                }}
              >
                <span
                  className={`snapshot-led${led.color ? '' : ' is-off'}`}
                  style={led.color ? { background: led.color } : undefined}
                  aria-hidden="true"
                />
                {custom ? (
                  <>
                    <span className="snapshot-number">{index + 1}</span>
                    <span className="snapshot-name">{label}</span>
                  </>
                ) : (
                  <span className="snapshot-name">{label}</span>
                )}
              </button>
            );
          })}
          {/* {onSetSnapshotLedColor && (
            <button
              type="button"
              className="snapshot-led-picker"
              title={`Footswitch LED colour of snapshot ${snapshotIndex + 1}`}
              onClick={() => {
                const color = prompt(
                  `LED colour for snapshot ${snapshotIndex + 1}`,
                  activeSnapshot?.ledColor !== undefined
                    ? String(activeSnapshot.ledColor)
                    : '0',
                );
                if (color !== null) {
                  const num = Number(color);
                  if (!Number.isNaN(num) && num >= 0 && num < SNAPSHOT_LED_COLORS.length) {
                    onSetSnapshotLedColor(snapshotIndex, num);
                  }
                }
              }}
            >
              <span
                className={`snapshot-led${activeLed.color ? '' : ' is-off'}`}
                style={
                  activeLed.color ? { background: activeLed.color } : undefined
                }
                aria-hidden="true"
              />
              <span>LED colour</span>
            </button>
          )} */}
        </div>

        <div className="toolbar-right">
          <span className="tempo" title="Preset tempo">
            ♩ {structure.tempo !== null ? formatTempo(structure.tempo) : '—'}
          </span>
          <div className="history-actions" role="group" aria-label="Edit history">
            <button
              id="undo-edit"
              type="button"
              className="toolbar-button"
              disabled={!canUndo || busy}
              title="Undo the last edit (Ctrl/Cmd+Z)"
              aria-label="Undo"
              onClick={onUndo}
            >
              ↶
            </button>
            <button
              id="redo-edit"
              type="button"
              className="toolbar-button"
              disabled={!canRedo || busy}
              title="Redo the last undone edit (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)"
              aria-label="Redo"
              onClick={onRedo}
            >
              ↷
            </button>
          </div>
          {onEditCopy && (
            <button
              id="edit-copy"
              type="button"
              className="toolbar-button"
              disabled={busy}
              title="Create an editable offline copy of this pedal preset (exports as .pgp, not written back to the pedal)"
              onClick={onEditCopy}
            >
              Edit copy
            </button>
          )}
          {/* <button
            id="rename-preset"
            type="button"
            className="toolbar-button"
            disabled={!canRename || busy}
            title={
              canRename
                ? 'Rename this preset (draft until you save or export)'
                : 'Open a preset to rename it'
            }
            onClick={onRename}
          >
            Rename…
          </button> */}
          <button
            id="export-pgp"
            type="button"
            className="toolbar-button is-primary"
            disabled={!canExport || busy}
            title={
              canExport
                ? 'Download this preset as a POD Go Edit .pgp file (works offline)'
                : 'Open an offline preset or import a .pgp/.pgb to export it'
            }
            onClick={onExport}
          >
            Export
          </button>
          {canExportBackup && (
            <button
              id="export-pgb"
              type="button"
              className="toolbar-button"
              disabled={busy}
              title="Download the imported backup with this slot updated (works offline)"
              onClick={onExportBackup}
            >
              Export .pgb
            </button>
          )}
        </div>
      </div>

      <div className="chain-panel">
        <SignalChain
          chain={structure.chain}
          assignments={assignments}
          selected={selected}
          onSelect={setSelected}
          onMoveBlock={onMoveBlock}
        />
      </div>

      <BlockInspector
        entry={selectedEntry}
        index={selectedIndex(selected)}
        editable={editable}
        editHint={editHint}
        onEditParam={onEditParam}
        onSelectModel={
          onSelectModel
            ? (model) => onSelectModel(selectedIndex(selected), model)
            : undefined
        }
        usedModelCategories={usedModelCategories}
        snapshotIndex={snapshotIndex}
        snapshotAssignments={snapshotAssignments}
        snapshotValues={snapshotValues}
        onToggleSnapshotParam={
          onToggleSnapshotParam && blockIndex !== null
            ? (paramIndex, assigned) =>
                onToggleSnapshotParam(blockIndex, paramIndex, assigned)
            : undefined
        }
        onSetBlockEnabled={
          onSetBlockEnabled && blockIndex !== null
            ? (enabled) => onSetBlockEnabled(blockIndex, enabled)
            : undefined
        }
      />

      <div className="editor-foot">
        <span className="editor-source" title={source}>
          {source}
        </span>
        <span>
          {structure.product || 'product ?'} · {structure.firmware || 'firmware ?'}
          {setlist ? ` · active in ${setlist}` : ''}
        </span>
        <span className="assignment-strip">
          {structure.footswitches.map((fs, index) => {
            const target = processing[fs.block - 1];
            const targetName =
              target && (target.kind === 'block' || target.kind === 'looper')
                ? (modelById(target.modelId)?.display ?? 'block')
                : '—';
            return (
              <span
                key={`${fs.group}-${fs.block}-${index}`}
                className="assignment"
                style={{
                  borderColor: categoryColor(
                    target && (target.kind === 'block' || target.kind === 'looper')
                      ? (modelById(target.modelId)?.category ?? null)
                      : null,
                  ),
                }}
                title={fs.label || targetName}
              >
                {fs.switch} → {targetName}
              </span>
            );
          })}
        </span>
      </div>

      {snapshotMenu && menuSnapshot && (
        <SnapshotMenu
          x={snapshotMenu.x}
          y={snapshotMenu.y}
          index={snapshotMenu.index}
          snapshot={menuSnapshot}
          active={structure.currentSnapshot === snapshotMenu.index}
          onRename={() => startSnapshotRename(snapshotMenu.index)}
          onSelect={() => onSelectSnapshot?.(snapshotMenu.index)}
          onClearName={() => onRenameSnapshot?.(snapshotMenu.index, '')}
          onSetLedColor={(color) =>
            onSetSnapshotLedColor?.(snapshotMenu.index, color)
          }
          onClose={() => setSnapshotMenu(null)}
        />
      )}
    </div>
  );
}

function firstSelection(processing: ReturnType<typeof processingChain>): Selection {
  const index = processing.findIndex((entry) => entry.kind !== 'empty');
  return index >= 0 ? index : 0;
}

function selectedIndex(selection: Selection): number | null {
  return typeof selection === 'number' ? selection : null;
}

function formatTempo(tempo: number): string {
  return Number(tempo.toFixed(2)).toString();
}
