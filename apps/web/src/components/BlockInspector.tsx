// Inspector for the selected slot, modelled on POD Go Edit: header tinted with
// the category colour, then either the parameter rows (read-only bars with the
// values the pedal displays) or a read-only model browser.
//
// Continuous effect parameters are edited in place: drag the bar under the
// name, or click the value at its right end to type one. A change updates the
// page's working copy only; nothing is written until the user presses Save
// (Ctrl+S). An offline preset keeps the change in its JSON document and can be
// exported as `.pgp` at any time.
//
// The `Models` tab mirrors the official Model Select grid (category row,
// sub-tabs, search). On an offline preset a click loads the model into the
// selected block as a draft (JSON only, exportable as `.pgp`); on a preset
// read from the pedal it stays read-only, because writing a model needs the
// chain-body path this build does not ship.

import { useEffect, useMemo, useState } from 'react';
import {
  CATEGORY_ORDER,
  IO_PARAMS,
  canSwapModel,
  categoryColor,
  displayRange,
  formatValue,
  isKnob,
  KNOB_DISPLAY_SCALE,
  modelById,
  modelsInCategory,
  paramAt,
  paramLabel,
  paramRange,
  rawValue,
  subcategories,
  tintedBackground,
  valueFraction,
  type IoKind,
} from '../catalog';
import type {
  CatalogModel,
  CatalogParam,
  ChainEntry,
  ChainParamValue,
} from '../types';
import { SNAPSHOT_CONTROLLER } from '../podgoEdit';

type Mode = 'params' | 'models';

interface Props {
  entry: ChainEntry | null;
  /** 0-based processing index, or `null` for the input/output stages. */
  index: number | null;
  /** This preset can be edited in the page right now. */
  editable: boolean;
  /** Short explanation above the parameter list (`null` = no hint). */
  editHint: string | null;
  onEditParam: (block: number, paramIndex: number, value: number) => void;
  /** Load a model into the selected block (may build an editable copy). */
  onSelectModel?: (model: CatalogModel) => void;
  /** Categories already used by the other blocks (single-role models). */
  usedModelCategories: ReadonlySet<string>;
  /** Active snapshot (0-based) for the snapshots label. */
  snapshotIndex: number;
  /** Base controller number per parameter index for this block. */
  snapshotAssignments: ReadonlyMap<number, number>;
  /** Parameter indexes that have a stored value in the active snapshot. */
  snapshotValues: ReadonlySet<number>;
  /** Assign or remove the Snapshots controller on a parameter. */
  onToggleSnapshotParam?: (paramIndex: number, assigned: boolean) => void;
  /** Bypass or enable this block in the active snapshot. */
  onSetBlockEnabled?: (enabled: boolean) => void;
  /** The page can create an editable copy, so the toggle stays visible. */
  canSetBlockEnabled?: boolean;
  /** Open the effect actions menu at a viewport position. */
  onOpenBlockMenu?: (x: number, y: number) => void;
}

export default function BlockInspector({
  entry,
  index,
  editable,
  editHint,
  onEditParam,
  onSelectModel,
  usedModelCategories,
  snapshotIndex,
  snapshotAssignments,
  snapshotValues,
  onToggleSnapshotParam,
  onSetBlockEnabled,
  canSetBlockEnabled = false,
  onOpenBlockMenu,
}: Props) {
  const [mode, setMode] = useState<Mode>('params');

  const io: IoKind | null =
    entry?.kind === 'input'
      ? 'input'
      : entry?.kind === 'output'
        ? 'output'
        : null;
  const model =
    entry?.kind === 'block' || entry?.kind === 'looper'
      ? modelById(entry.modelId)
      : null;

  const category = io ? null : (model?.category ?? null);
  const color = categoryColor(category);
  const display = io
    ? io === 'input'
      ? 'Input'
      : 'Output'
    : entry?.kind === 'block'
      ? (model?.display ?? `Model ${entry.modelId}`)
      : entry?.kind === 'looper'
        ? 'Looper'
        : entry?.kind === 'empty'
          ? 'Empty slot'
          : entry?.kind === 'unknown'
            ? `Unknown block (class ${entry.class})`
            : 'Nothing selected';
  const enabled =
    entry?.kind === 'block' || entry?.kind === 'looper' ? entry.enabled : true;
  const empty = !entry || entry.kind === 'empty' || entry.kind === 'unknown';

  // A chain with no blocks selects an empty slot: the official app opens the
  // Model Select in that case, so do the same.
  useEffect(() => {
    setMode(empty ? 'models' : 'params');
  }, [entry, empty]);

  return (
    <section className="inspector" aria-label="Block inspector">
      <header
        className="inspector-head"
        style={{ background: tintedBackground(color) }}
      >
        <div className="inspector-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'params'}
            className={mode === 'params' ? 'is-active' : ''}
            disabled={empty}
            onClick={() => setMode('params')}
          >
            Params
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'models'}
            className={mode === 'models' ? 'is-active' : ''}
            disabled={io !== null}
            title={
              io !== null
                ? 'Input and Output stages have fixed models'
                : undefined
            }
            onClick={() => setMode('models')}
          >
            Models
          </button>
        </div>
        <span className="inspector-category" style={{ color }}>
          {io ? (io === 'input' ? 'Input' : 'Output') : (category ?? 'Other')}
        </span>
        <span className={`inspector-model${enabled ? '' : ' is-bypassed'}`}>
          {display}
        </span>
        {model?.sub && <span className="inspector-sub">{model.sub}</span>}
        {entry?.kind === 'block' &&
          (onSetBlockEnabled && (editable || canSetBlockEnabled) ? (
            <button
              type="button"
              className={`inspector-state is-toggle${
                enabled ? '' : ' is-bypassed'
              }`}
              aria-pressed={!enabled}
              title={`${enabled ? 'Bypass' : 'Enable'} this block in snapshot ${
                snapshotIndex + 1
              } (draft, not written)`}
              onClick={() => onSetBlockEnabled(!enabled)}
            >
              {enabled ? 'active' : 'bypassed'}
            </button>
          ) : (
            <span className={`inspector-state${enabled ? '' : ' is-bypassed'}`}>
              {enabled ? 'active' : 'bypassed'}
            </span>
          ))}
        {onOpenBlockMenu && index !== null && (
          <button
            type="button"
            className="inspector-more"
            aria-haspopup="menu"
            aria-label="Effect actions"
            title="Effect actions — copy, paste, move, bypass"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenBlockMenu(rect.right - 8, rect.bottom + 6);
            }}
          >
            ⋯
          </button>
        )}
        {index !== null && entry?.kind === 'block' && (
          <span className="inspector-slot">slot {index + 1}</span>
        )}
      </header>

      {mode === 'models' || empty ? (
        <ModelBrowser
          current={model}
          onSelect={io ? undefined : onSelectModel}
          usedCategories={usedModelCategories}
        />
      ) : (
        <ParamList
          entry={entry}
          io={io}
          color={color}
          model={model}
          editable={editable}
          editHint={editHint}
          onEditParam={onEditParam}
          snapshotAssignments={snapshotAssignments}
          snapshotValues={snapshotValues}
          onToggleSnapshotParam={onToggleSnapshotParam}
        />
      )}
    </section>
  );
}

function ParamList({
  entry,
  io,
  color,
  model,
  editable,
  editHint,
  onEditParam,
  snapshotAssignments,
  snapshotValues,
  onToggleSnapshotParam,
}: {
  entry: ChainEntry;
  io: IoKind | null;
  color: string;
  model: CatalogModel | null;
  editable: boolean;
  editHint: string | null;
  onEditParam: (block: number, paramIndex: number, value: number) => void;
  snapshotAssignments: ReadonlyMap<number, number>;
  snapshotValues: ReadonlySet<number>;
  onToggleSnapshotParam?: (paramIndex: number, assigned: boolean) => void;
}) {
  const values: ChainParamValue[] =
    'params' in entry ? (entry.params as ChainParamValue[]) : [];
  const params: (CatalogParam | null)[] = io
    ? IO_PARAMS[io]
    : values.map((_, index) => paramAt(model, index));

  const mismatch =
    !io && model !== null && model.params.length !== values.length;

  // Only effect blocks are edited here. Input/output stages and the looper are
  // shown as read-only values.
  const writable = editable && entry.kind === 'block';

  return (
    <div className="param-list">
      {mismatch && (
        <p className="param-warning">
          Catalog lists {model.params.length} parameters, firmware stores{' '}
          {values.length}. Showing raw positions.
        </p>
      )}
      {writable && editHint && <p className="param-warning">{editHint}</p>}
      {values.length === 0 && <p className="inspector-empty">No parameters.</p>}
      {params.map((param, index) => (
        <ParamRow
          key={index}
          entry={entry}
          param={param}
          index={index}
          value={values[index] ?? null}
          color={color}
          editable={writable && param?.k === 'cont'}
          controller={snapshotAssignments.get(index)}
          snapshotStored={snapshotValues.has(index)}
          onEditParam={onEditParam}
          onToggleSnapshot={
            onToggleSnapshotParam && param?.k === 'cont'
              ? (assigned) => onToggleSnapshotParam(index, assigned)
              : undefined
          }
        />
      ))}
    </div>
  );
}

function ParamRow({
  entry,
  param,
  index,
  value,
  color,
  editable,
  controller,
  snapshotStored,
  onEditParam,
  onToggleSnapshot,
}: {
  entry: ChainEntry;
  param: CatalogParam | null;
  index: number;
  value: ChainParamValue;
  color: string;
  editable: boolean;
  /** Base controller number, when this parameter is assigned. */
  controller: number | undefined;
  /** The active snapshot stores a value for this parameter. */
  snapshotStored: boolean;
  onEditParam: (block: number, paramIndex: number, value: number) => void;
  onToggleSnapshot?: (assigned: boolean) => void;
}) {
  const fraction = valueFraction(param, value);
  const [rangeMin, rangeMax] = paramRange(param);
  const [low, high] = displayRange(param);
  const current =
    typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? low);
  const currentDisplay = isKnob(param)
    ? current * KNOB_DISPLAY_SCALE
    : Math.min(high, Math.max(low, current));
  const [draft, setDraft] = useState(() => formatDraft(currentDisplay, param));
  const [typing, setTyping] = useState(false);

  // Re-sync on a new value from the pedal or a new parameter. A plain effect
  // would run after every render and overwrite what the user is typing.
  useEffect(() => {
    setDraft(formatDraft(currentDisplay, param));
  }, [currentDisplay, param]);

  // 0.1 on the pedal's 0–10 knobs; finer for parameters that live in real
  // units (ms, Hz, dB). 200 steps keeps the drag usable either way.
  const sliderStep = isKnob(param)
    ? 0.1
    : Math.max((high - low) / 200, 0.001);

  function commit(display: number) {
    const clamped = Math.min(high, Math.max(low, display));
    const raw = rawValue(param, clamped);
    if (raw === value) {
      return;
    }
    onEditParam(entry.slot, index, raw);
  }

  function commitDraft() {
    setTyping(false);
    const numeric = Number(draft);
    if (!Number.isFinite(numeric)) {
      setDraft(formatDraft(currentDisplay, param));
      return;
    }
    commit(numeric);
  }

  function cancelDraft() {
    setTyping(false);
    setDraft(formatDraft(currentDisplay, param));
  }

  const snapshotControlled = controller === SNAPSHOT_CONTROLLER;
  const otherController =
    controller !== undefined && controller !== SNAPSHOT_CONTROLLER;
  const otherControllerLabel =
    controller === 1
      ? 'EXP 1'
      : controller === 2
        ? 'EXP 2'
        : `controller ${String(controller)}`;
  const snapshotTitle = otherController
    ? `${otherControllerLabel} controls this parameter. Clear that assignment in POD Go Edit before using the Snapshots controller.`
    : snapshotControlled
      ? `Snapshots control this parameter${
          snapshotStored ? ' and this snapshot stores a value' : ''
        } — click to remove it from all snapshots (draft)`
      : 'Store a different value for this parameter in each snapshot (draft, exported with .pgp)';

  return (
    <div className="param-row">
      <div className="param-line">
        <span className="param-name">
          {onToggleSnapshot && (
            <button
              type="button"
              className={`snapshot-assign${
                snapshotControlled ? ' is-on' : ''
              }${otherController ? ' is-blocked' : ''}`}
              aria-pressed={snapshotControlled}
              aria-label={`Snapshots controller for ${paramLabel(param, index)}`}
              title={snapshotTitle}
              disabled={otherController}
              onClick={() => onToggleSnapshot(!snapshotControlled)}
            >
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  fill="currentColor"
                  d="M6.5 2 5.6 3.4H3.2A1.7 1.7 0 0 0 1.5 5v6.9a1.7 1.7 0 0 0 1.7 1.6h9.6a1.7 1.7 0 0 0 1.7-1.6V5a1.7 1.7 0 0 0-1.7-1.6h-2.4L9.5 2h-3Zm1.5 3a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6Zm0 1.4a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8Z"
                />
              </svg>
            </button>
          )}
          {paramLabel(param, index)}
          {param?.k === 'int' && param.labels ? (
            <span className="param-tag">enum</span>
          ) : null}
        </span>
        {editable && typing ? (
          <input
            id={`param-input-${index}`}
            className="param-value-input"
            type="number"
            inputMode="decimal"
            min={low}
            max={high}
            step={sliderStep}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelDraft();
              }
            }}
          />
        ) : editable ? (
          <button
            id={`param-value-${index}`}
            type="button"
            className="param-value is-editable"
            title={`${formatValue(param, value)} — click to type a value`}
            onClick={() => setTyping(true)}
          >
            {formatValue(param, value)}
          </button>
        ) : (
          <span className="param-value" title={`raw ${String(value)}`}>
            {formatValue(param, value)}
          </span>
        )}
      </div>
      <div className={`param-track${editable ? ' is-editable' : ''}`}>
        <div
          className="param-fill"
          style={{ width: `${fraction * 100}%`, background: color }}
        />
        {editable && (
          <input
            id={`param-slider-${index}`}
            className="param-slider"
            type="range"
            aria-label={`${paramLabel(param, index)} value`}
            min={low}
            max={high}
            step={sliderStep}
            value={currentDisplay}
            onChange={(event) => commit(Number(event.target.value))}
          />
        )}
      </div>
      <div className="param-range">
        <span>{rangeMin}</span>
        <span>{rangeMax}</span>
      </div>
    </div>
  );
}

/** Input text for a value, without padding zeros that annoy a number input. */
function formatDraft(value: number, param: CatalogParam | null): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  return isKnob(param)
    ? String(Number(value.toFixed(1)))
    : String(Number(value.toPrecision(6)));
}

function ModelBrowser({
  current,
  onSelect,
  usedCategories,
}: {
  current: CatalogModel | null;
  onSelect?: (model: CatalogModel) => void;
  usedCategories: ReadonlySet<string>;
}) {
  // An empty slot is an Effects block, so start there rather than on Amp.
  const [category, setCategory] = useState<string | null>(
    current?.category ?? 'Dist',
  );
  const [sub, setSub] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setCategory(current?.category ?? 'Dist');
    setSub(null);
  }, [current]);

  const subs = useMemo(() => subcategories(category), [category]);
  const models = useMemo(() => {
    const text = query.trim().toLowerCase();
    return modelsInCategory(category)
      .filter((model) => (sub ? model.sub === sub : true))
      .filter(
        (model) =>
          !text ||
          model.display.toLowerCase().includes(text) ||
          model.short.toLowerCase().includes(text) ||
          model.name.toLowerCase().includes(text),
      );
  }, [category, sub, query]);

  return (
    <div className="model-browser">
      <div className="model-controls">
        <div className="category-row" role="tablist">
          {CATEGORY_ORDER.map((name) => (
            <button
              type="button"
              key={name}
              role="tab"
              aria-selected={category === name}
              className={category === name ? 'is-active' : ''}
              style={{ color: categoryColor(name) }}
              onClick={() => {
                setCategory(name);
                setSub(null);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="model-search"
          placeholder="Search…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {subs.length >= 2 && (
        <div className="subcategory-row" role="tablist">
          {['All', ...subs].map((name) => {
            const value = name === 'All' ? null : name;
            const active = value === sub;
            return (
              <button
                type="button"
                key={name}
                role="tab"
                aria-selected={active}
                className={active ? 'is-active' : ''}
                onClick={() => setSub(value)}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}

      <p className="model-hint">
        {onSelect
          ? `${models.length} models · click one to load it into the selected block (offline draft; exports as .pgp)`
          : `${models.length} models · changing a model needs an editable preset.`}
      </p>

      <div className="model-grid">
        {models.map((model) => {
          const active = current?.name === model.name;
          const allowed = onSelect
            ? canSwapModel(current, model, usedCategories)
            : false;
          const title =
            `${model.name} — ${model.category ?? ''}` +
            `${model.sub ? ` / ${model.sub}` : ''}` +
            (onSelect && !allowed
              ? ' (not compatible with this slot)'
              : '');
          const body = (
            <>
              <span
                className="model-dot"
                style={{ background: categoryColor(model.category) }}
                aria-hidden="true"
              />
              <span className="model-name">{model.short}</span>
              {active && <span className="model-current">current</span>}
            </>
          );
          if (!onSelect) {
            return (
              <div
                key={model.name}
                className={`model-tile${active ? ' is-current' : ''}`}
                title={title}
              >
                {body}
              </div>
            );
          }
          return (
            <button
              key={model.name}
              type="button"
              className={`model-tile is-selectable${
                active ? ' is-current' : ''
              }${allowed ? '' : ' is-blocked'}`}
              title={title}
              disabled={!allowed}
              onClick={() => onSelect(model)}
            >
              {body}
            </button>
          );
        })}
      </div>
    </div>
  );
}
