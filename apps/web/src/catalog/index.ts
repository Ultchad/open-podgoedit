// Model catalog: on-wire id → official name, category and parameter ranges.
//
// The data is factual interoperability information derived from a `.pgb`
// backup and the official POD Go Edit resources by the MIT-licensed
// `openpodgo` project (`tools/export_catalog.py` regenerates it). No vendor
// artwork, fonts or code is shipped. See `docs/protocol/model-catalog.md`.
//
// The Rust core only knows on-wire ids and raw values; everything a human
// reads — display names, categories, colours, value labels and units — is
// resolved here, in the page.

import document_ from './catalog.json';
import type {
  CatalogModel,
  CatalogParam,
  ChainEntry,
  ChainParamValue,
  ParamKind,
} from '../types';

interface CatalogDocument {
  source: {
    project: string;
    files: string[];
    backup: string | null;
    generated_by: string;
  };
  categories: Record<string, string>;
  models: Record<string, CatalogModel>;
}

const document = document_ as unknown as CatalogDocument;

/** All models, indexed by on-wire id (`wire_id` of the block). */
export const MODELS: Readonly<Record<string, CatalogModel>> = document.models;

const BY_NAME = new Map<string, CatalogModel>();
for (const model of Object.values(MODELS)) {
  BY_NAME.set(model.name, model);
}

/** Look up a catalog model by its on-wire name (`HD2_AmpGCougar800`). */
export function modelByName(name: string): CatalogModel | null {
  return BY_NAME.get(name) ?? null;
}

/** Official category colours (POD Go Edit) plus the app fallbacks. */
export const CATEGORY_COLORS: Readonly<Record<string, string>> =
  document.categories;

/** Order of the category row, as in the official Model Select. */
export const CATEGORY_ORDER = [
  'Amp',
  'Cab',
  'Dist',
  'Dyn',
  'EQ',
  'Mod',
  'Delay',
  'Reverb',
  'Pitch',
  'Filter',
  'Wah',
  'Vol',
  'Send/Return',
  'Looper',
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

/** Application background, same value as POD Go Edit. */
export const BACKGROUND = '#18191b';
/** Loaded preset in the librarian (amber), as in the official app. */
export const LOADED_AMBER = '#f5a623';

const EMPTY_COLOR = '#606060';
const OTHER_COLOR = '#9C9C9C';

const byCategory = new Map<string, CatalogModel[]>();
for (const model of Object.values(MODELS)) {
  if (!model.category) {
    continue;
  }
  const list = byCategory.get(model.category) ?? [];
  list.push(model);
  byCategory.set(model.category, list);
}
for (const list of byCategory.values()) {
  list.sort((a, b) => a.display.localeCompare(b.display));
}

/** Model for an on-wire id, or `null` when the catalog does not know it. */
export function modelById(id: number | null | undefined): CatalogModel | null {
  if (id === null || id === undefined) {
    return null;
  }
  return MODELS[String(id)] ?? null;
}

/** Models of one UI category, sorted by display name. */
export function modelsInCategory(category: string | null): CatalogModel[] {
  if (!category) {
    return [];
  }
  return byCategory.get(category) ?? [];
}

/** Subcategories present in a category (`Amp` → `Amp`, `Preamp`). */
export function subcategories(category: string | null): string[] {
  const seen: string[] = [];
  for (const model of modelsInCategory(category)) {
    if (model.sub && !seen.includes(model.sub)) {
      seen.push(model.sub);
    }
  }
  const order = SUBCATEGORY_ORDER[category ?? ''] ?? [];
  return seen.sort((a, b) => {
    const left = order.indexOf(a);
    const right = order.indexOf(b);
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right);
  });
}

const SUBCATEGORY_ORDER: Record<string, string[]> = {
  Amp: ['Amp', 'Preamp'],
  Cab: ['Cab', 'Legacy Cab', 'Impulse Response'],
};

/**
 * Categories a block can host.
 *
 * Effects categories can appear in any Effects block. The Preset groups
 * (Amp, Cab, Vol, Wah, Send/Return, Looper) are roles a preset has at most
 * once: they can sit in any slot, but only one block may hold each of them.
 * This mirrors what the manual and the reference implementation enforce
 * (§5), while still letting an empty slot become a Wah or a Looper.
 */
const EFFECT_CATEGORIES: ReadonlySet<string> = new Set([
  'Dist',
  'Dyn',
  'EQ',
  'Mod',
  'Delay',
  'Reverb',
  'Pitch',
  'Filter',
]);

const PRESET_CATEGORIES: ReadonlySet<string> = new Set([
  'Amp',
  'Cab',
  'Vol',
  'Wah',
  'Send/Return',
  'Looper',
]);

const LOCKED_CATEGORIES: ReadonlySet<string> = new Set([
  'Amp',
  'Cab',
  'Vol',
  'Wah',
  'Send/Return',
  'Looper',
]);

/** The dedicated Preset EQ (`HD2_EQ_STATIC_…`) vs an Effects-block EQ. */
function isPresetEq(model: CatalogModel): boolean {
  return model.name.includes('_STATIC_');
}

/**
 * True when `target` can load into the selected slot.
 *
 * `current` is the model already in the block (`null` = empty slot, which
 * behaves like an Effects block). `usedCategories` holds the categories of
 * the other blocks in the preset, so a second Amp, Cab, Wah, … is refused.
 */
export function canSwapModel(
  current: CatalogModel | null,
  target: CatalogModel,
  usedCategories: ReadonlySet<string> = new Set(),
): boolean {
  const category = target.category;
  if (!category) {
    return false;
  }

  // A dedicated Preset EQ is only compatible with another Preset EQ.
  const targetIsPresetEq = category === 'EQ' && isPresetEq(target);
  if (targetIsPresetEq && !(current && current.category === 'EQ' && isPresetEq(current))) {
    return false;
  }

  if (!current) {
    if (PRESET_CATEGORIES.has(category)) {
      return !usedCategories.has(category);
    }
    return EFFECT_CATEGORIES.has(category);
  }

  if (current.category === 'EQ') {
    return (
      category === 'EQ' && isPresetEq(current) === isPresetEq(target)
    );
  }
  if (LOCKED_CATEGORIES.has(current.category ?? '')) {
    // A Preset block keeps its role (the reference implementation does not
    // turn an amp slot into an effect slot).
    return category === current.category;
  }
  if (PRESET_CATEGORIES.has(category)) {
    return !usedCategories.has(category);
  }
  return EFFECT_CATEGORIES.has(category);
}

export function categoryColor(category: string | null | undefined): string {
  if (!category) {
    return EMPTY_COLOR;
  }
  return CATEGORY_COLORS[category] ?? OTHER_COLOR;
}

/** Near-black background tinted with the category colour (inspector header). */
export function tintedBackground(color: string): string {
  const [r, g, b] = rgb(color);
  const [br, bg, bb] = rgb(BACKGROUND);
  const mix = 0.15;
  return rgbHex(
    Math.round(br * (1 - mix) + r * mix),
    Math.round(bg * (1 - mix) + g * mix),
    Math.round(bb * (1 - mix) + b * mix),
  );
}

function rgb(color: string): [number, number, number] {
  const value = color.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : value.padEnd(6, '0').slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Parameter of a model at a positional index, or `null` past the catalog. */
export function paramAt(
  model: CatalogModel | null,
  index: number,
): CatalogParam | null {
  return model?.params[index] ?? null;
}

/** Visible label of a parameter: catalog name without the `@` attribute mark. */
export function paramLabel(param: CatalogParam | null, index: number): string {
  return param ? param.n.replace(/^@/, '') : `P${index + 1}`;
}

/**
 * Scale applied to 0..1 knobs for display.
 *
 * The pedal shows these knobs on a 0–10 scale (raw `0.76` is displayed `7.6`),
 * including catalog parameters whose `display_type` is `percent`: POD Go Edit
 * renders those as `0–100 %`, but the hardware uses 0–10. The observed pedal
 * value is the authority here; do not switch this back to 100.
 */
export const KNOB_DISPLAY_SCALE = 10;

/** True when the parameter is a 0..1 knob shown on the pedal's 0–10 scale. */
export function isKnob(param: CatalogParam | null): boolean {
  return param?.min === 0 && param?.max === 1 && param.k === 'cont';
}

/**
 * Display value, ported from the reference inspector with the pedal's scale:
 * bool → label, labelled discrete → label, 0..1 knob → `×10` with one decimal,
 * everything else → 4 significant digits (or an integer when discrete).
 */
export function formatValue(
  param: CatalogParam | null,
  value: ChainParamValue,
): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  if (!Number.isFinite(numeric)) {
    return '—';
  }

  if (param?.k === 'bool' || typeof value === 'boolean') {
    const labels = param?.labels;
    if (labels && labels.length >= 2) {
      return labels[numeric ? 1 : 0] ?? (numeric ? 'On' : 'Off');
    }
    return numeric ? 'On' : 'Off';
  }

  if (param?.k === 'int') {
    if (param.labels && param.min !== null) {
      const index = Math.round(numeric - param.min);
      const label = param.labels[index];
      if (label !== undefined) {
        return label;
      }
    }
    return Math.round(numeric).toString();
  }

  if (isKnob(param)) {
    return (numeric * KNOB_DISPLAY_SCALE).toFixed(1);
  }
  return compact(numeric);
}

/** Slider end labels, in the same scale as [`formatValue`]. */
export function paramRange(param: CatalogParam | null): [string, string] {
  if (isKnob(param)) {
    return ['0', String(KNOB_DISPLAY_SCALE)];
  }
  return [compact(param?.min ?? 0), compact(param?.max ?? 1)];
}

/** Numeric bounds in the same scale as [`formatValue`] (for inputs). */
export function displayRange(param: CatalogParam | null): [number, number] {
  if (isKnob(param)) {
    return [0, KNOB_DISPLAY_SCALE];
  }
  return [param?.min ?? 0, param?.max ?? 1];
}

/** Convert a value typed in display units back to raw DSP units. */
export function rawValue(param: CatalogParam | null, display: number): number {
  return isKnob(param) ? display / KNOB_DISPLAY_SCALE : display;
}

function compact(value: number): string {
  if (value === 0) {
    return '0';
  }
  return String(Number(value.toPrecision(4)));
}

/** Slider position in `0..1` for a value (0 for a degenerate range). */
export function valueFraction(
  param: CatalogParam | null,
  value: ChainParamValue,
): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (param?.k === 'bool' || typeof value === 'boolean') {
    return numeric ? 1 : 0;
  }
  const min = param?.min ?? 0;
  const max = param?.max ?? 1;
  if (!(max > min)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (numeric - min) / (max - min)));
}

/** Parameter metadata of the input/output stages (fixed order on the wire). */
export type IoKind = 'input' | 'output';

export const IO_PARAMS: Record<IoKind, CatalogParam[]> = {
  input: [
    { n: 'Input Gate', min: 0, max: 1, k: 'bool', labels: ['Off', 'On'] },
    { n: 'Threshold', min: -96, max: 0, k: 'cont' },
    { n: 'Decay', min: 0.01, max: 1, k: 'cont' },
  ],
  output: [
    { n: 'Pan', min: 0, max: 1, k: 'cont' },
    { n: 'Level', min: -120, max: 20, k: 'cont' },
  ],
};

/** Position of a block among the processing slots (`input` is not counted). */
export function processingIndex(chain: ChainEntry[], slot: number): number {
  const input = chain.findIndex((entry) => entry.kind === 'input');
  return slot - (input < 0 ? 0 : input) - 1;
}

/** Processing slots only (no input/output endpoints). */
export function processingChain(chain: ChainEntry[]): ChainEntry[] {
  return chain.filter(
    (entry) => entry.kind !== 'input' && entry.kind !== 'output',
  );
}

/** `01A`, `05C`, …: POD Go numbers banks from 01, four slots per bank. */
export function slotLabel(slot: number): string {
  const bank = Math.floor(slot / 4) + 1;
  const letter = 'ABCD'[slot % 4] ?? 'A';
  return `${bank.toString().padStart(2, '0')}${letter}`;
}

/** Kind of block for badges. */
export function paramKindLabel(kind: ParamKind): string {
  switch (kind) {
    case 'bool':
      return 'switch';
    case 'int':
      return 'discrete';
    case 'cont':
      return 'continuous';
  }
}
