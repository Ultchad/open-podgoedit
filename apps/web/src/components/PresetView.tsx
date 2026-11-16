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
import type { CatalogModel, PresetStructure, Selection } from '../types';
import BlockInspector from './BlockInspector';
import SignalChain from './SignalChain';

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
  /** Load a model into the selected block; absent for read-only presets. */
  onSelectModel?: (index: number | null, model: CatalogModel) => void;
  /** Reorder blocks by drag and drop; absent for read-only presets. */
  onMoveBlock?: (from: number, to: number) => void;
  canExport: boolean;
  onExport: () => void;
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
  onMoveBlock,
  canExport,
  onExport,
  canRename,
  onRename,
}: Props) {
  const processing = processingChain(structure.chain);
  const [selected, setSelected] = useState<Selection>(() =>
    firstSelection(processing),
  );

  // Reset on a new preset, not on an edit: a parameter write replaces the
  // structure object, and resetting there would jump back to the first slot.
  const presetKey = `${structure.preset.setlist}:${structure.preset.slot}:${structure.preset.name}`;
  useEffect(() => {
    setSelected(firstSelection(processingChain(structure.chain)));
  }, [presetKey]);

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
                ? 'offline preset'
                : editable
                  ? 'draft'
                  : 'read-only'}
          </span>
        </div>

        <div className="snapshot-row" aria-label="Snapshots">
          {structure.snapshots.slice(0, 4).map((snapshot, index) => (
            <span
              key={index}
              className={`snapshot${
                snapshot.name && snapshot.valid ? '' : ' is-empty'
              }${structure.currentSnapshot === index ? ' is-active' : ''}`}
              title={snapshot.name || `Snapshot ${index + 1}`}
            >
              {index + 1}
              {snapshot.name ? ` ${snapshot.name}` : ''}
            </span>
          ))}
        </div>

        <div className="toolbar-right">
          <span className="tempo" title="Preset tempo">
            ♩ {structure.tempo !== null ? formatTempo(structure.tempo) : '—'}
          </span>
          <button
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
          </button>
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
            Export .pgp
          </button>
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
