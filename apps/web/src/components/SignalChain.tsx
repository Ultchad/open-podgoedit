// Signal chain strip: ⊙ → 10 processing slots → →, modelled on the POD Go
// Edit / openpodgo panel. Clicking selects a slot for the inspector. On an
// offline preset, dragging a block onto another position reorders the chain
// (a draft; nothing is written to the pedal). Right-click or long-press opens
// the same effect menu as the inspector's ⋯ button.
//
// Blocks are flat category-coloured tiles (the vendor icons are proprietary
// artwork and are not shipped). Bypassed blocks are dimmed, the switch that
// toggles them is written above the tile, and the selected slot gets the
// caret that points at the inspector.

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

import { categoryColor, modelById, processingChain } from '../catalog';
import type { ChainEntry, Selection } from '../types';
import { useLongPress } from '../useLongPress';

interface Props {
  chain: ChainEntry[];
  /** 0-based processing index → switch label (`FS1`…`FS8`, `EXP Toe`). */
  assignments: Map<number, string>;
  selected: Selection;
  onSelect: (selection: Selection) => void;
  /** Reorder handler; absent when the preset cannot be edited here. */
  onMoveBlock?: (from: number, to: number) => void;
  /** Open the effect actions menu for one processing slot. */
  onBlockMenu?: (index: number, x: number, y: number) => void;
}

export default function SignalChain({
  chain,
  assignments,
  selected,
  onSelect,
  onMoveBlock,
  onBlockMenu,
}: Props) {
  const processing = processingChain(chain);
  const flowRef = useRef<HTMLDivElement>(null);

  // Keep the selected tile visible when a selection comes from elsewhere
  // (lifting a stored draft, keyboard move, …) without scrolling the page.
  useEffect(() => {
    if (typeof selected !== 'number') {
      return;
    }
    const panel = flowRef.current?.closest('.chain-panel');
    const tile = flowRef.current?.querySelector<HTMLElement>(
      `[data-block-index="${selected}"]`,
    );
    if (!(panel instanceof HTMLElement) || !tile) {
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    if (tileRect.left < panelRect.left || tileRect.right > panelRect.right) {
      panel.scrollTo({
        left: panel.scrollLeft + tileRect.left - panelRect.left - 12,
        behavior: 'smooth',
      });
    }
  }, [selected]);

  return (
    <div
      ref={flowRef}
      className="signal-flow"
      role="toolbar"
      aria-label="Signal chain"
    >
      <div className="signal-line" aria-hidden="true" />
      <ChainEnd
        kind="input"
        selected={selected === 'input'}
        onSelect={onSelect}
      />
      {processing.map((entry, index) => (
        <BlockTile
          key={entry.slot}
          entry={entry}
          index={index}
          assignment={assignments.get(index)}
          selected={selected === index}
          onSelect={onSelect}
          onMoveBlock={onMoveBlock}
          onBlockMenu={onBlockMenu}
          count={processing.length}
        />
      ))}
      <ChainEnd
        kind="output"
        selected={selected === 'output'}
        onSelect={onSelect}
      />
    </div>
  );
}

function ChainEnd({
  kind,
  selected,
  onSelect,
}: {
  kind: 'input' | 'output';
  selected: boolean;
  onSelect: (selection: Selection) => void;
}) {
  return (
    <button
      type="button"
      className={`chain-end${selected ? ' is-selected' : ''}`}
      title={
        kind === 'input'
          ? 'Input — click to edit the noise gate'
          : 'Output — click to edit pan and level'
      }
      onClick={() => onSelect(kind)}
    >
      <span className="chain-end-glyph" aria-hidden="true">
        {kind === 'input' ? '⊙' : '→'}
      </span>
      <span className="chain-end-name">{kind === 'input' ? 'Input' : 'Output'}</span>
      {selected && <span className="caret" aria-hidden="true" />}
    </button>
  );
}

function BlockTile({
  entry,
  index,
  assignment,
  selected,
  onSelect,
  onMoveBlock,
  onBlockMenu,
  count,
}: {
  entry: ChainEntry;
  index: number;
  assignment: string | undefined;
  selected: boolean;
  onSelect: (selection: Selection) => void;
  onMoveBlock?: (from: number, to: number) => void;
  onBlockMenu?: (index: number, x: number, y: number) => void;
  count: number;
}) {
  const model =
    entry.kind === 'block' || entry.kind === 'looper'
      ? modelById(entry.modelId)
      : null;
  const category = model?.category ?? null;
  const enabled =
    entry.kind === 'block' || entry.kind === 'looper' ? entry.enabled : true;
  const empty = entry.kind === 'empty' || entry.kind === 'unknown';

  const label = empty
    ? ''
    : (model?.display ??
      (entry.kind === 'block'
        ? `Model ${entry.modelId}`
        : entry.kind === 'looper'
          ? 'Looper'
          : ''));
  const subtitle =
    entry.kind === 'block'
      ? `model ${entry.modelId}`
      : entry.kind === 'looper'
        ? 'looper'
        : entry.kind === 'unknown'
          ? `class ${entry.class}`
          : '';

  const style = category
    ? { '--block-color': categoryColor(category) }
    : undefined;
  const movable = Boolean(onMoveBlock) && !empty;
  const { longPressHandlers, consumeClick } = useLongPress(
    (x, y) => onBlockMenu?.(index, x, y),
    { enabled: Boolean(onBlockMenu) },
  );

  return (
    <button
      type="button"
      className={[
        'block-tile',
        empty ? 'is-empty' : '',
        enabled ? '' : 'is-bypassed',
        selected ? 'is-selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style as CSSProperties | undefined}
      data-block-index={index}
      aria-haspopup={onBlockMenu ? 'menu' : undefined}
      title={
        empty
          ? entry.kind === 'empty'
            ? 'Empty slot — right-click or long-press for effect actions'
            : 'Unknown block class'
          : `${model?.name ?? label} — ${subtitle}${
              enabled ? '' : ' (bypassed)'
            }${assignment ? ` · ${assignment}` : ''}${
              movable ? ' · drag to reorder' : ''
            } · right-click or long-press for actions`
      }
      draggable={movable}
      onDragStart={(event) => {
        if (!movable) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData('application/x-podgo-block', String(index));
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event) => {
        if (!onMoveBlock) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        if (!onMoveBlock) {
          return;
        }
        const raw = event.dataTransfer.getData('application/x-podgo-block');
        event.preventDefault();
        const from = Number(raw);
        if (Number.isInteger(from) && from >= 0 && from < count && from !== index) {
          onMoveBlock(from, index);
        }
      }}
      {...longPressHandlers}
      onClick={() => {
        if (consumeClick()) {
          return;
        }
        onSelect(index);
      }}
    >
      <span className="block-assign">{assignment ?? ''}</span>
      <span className="block-face">
        {entry.kind === 'empty' ? (
          <span className="block-plus" aria-hidden="true">
            +
          </span>
        ) : entry.kind === 'unknown' ? (
          <span className="block-label">?</span>
        ) : (
          <span className="block-label">{label}</span>
        )}
      </span>
      <span className="block-foot">
        {empty ? '' : (category ?? 'Other')}
        {entry.kind === 'block' && entry.noSnapshotBypass ? (
          <span title="Bypass is not recalled by snapshots"> · NSB</span>
        ) : null}
      </span>
      {selected && <span className="caret" aria-hidden="true" />}
    </button>
  );
}
