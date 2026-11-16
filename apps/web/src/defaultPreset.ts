// A small, synthetic preset used to start working without a pedal.
//
// It follows the documented `L6Preset` v6 shape (`docs/protocol/presets.md`
// §5) with an amp and a cab block. The parameter keys and values come from the
// catalog, so the page renders the same controls the pedal exposes. Nothing
// here is a copy of a vendor preset: it is a neutral starting point named
// "New Preset", safe to export and edit.
//
// A preset read from a `.pgp` or from the pedal keeps every unknown field. This
// template only has to be valid enough for POD Go Edit and for the page's own
// reader; the body-write path to the pedal remains unimplemented.

import { modelByName } from './catalog';
import { presetFromDocument } from './podgoEdit';
import type { EditPreset } from './podgoEdit';
import type { CatalogModel } from './types';

const AMP = 'HD2_AmpGCougar800';
const CAB = 'HD2_Cab4x10Rhino';

/** Values chosen for a clean, audible starting point (0..1 knobs). */
const AMP_VALUES: Record<string, number> = {
  Drive: 0.4,
  Bass: 0.5,
  LowMid: 0.5,
  HighMid: 0.5,
  Treble: 0.5,
  ChVol: 0.7,
  Master: 0.5,
  Boost: 0,
};

const CAB_VALUES: Record<string, number> = {
  Distance: 1,
  LowCut: 80,
  HighCut: 8000,
  EarlyReflections: 0,
  Level: 0,
};

function params(model: CatalogModel | null, values: Record<string, number>) {
  const out: Record<string, unknown> = {};
  if (!model) {
    return out;
  }
  for (const param of model.params) {
    if (param.k === 'bool') {
      out[param.n] = false;
    } else if (param.k === 'int') {
      out[param.n] = param.min ?? 0;
    } else {
      out[param.n] = values[param.n] ?? param.min ?? 0;
    }
  }
  return out;
}

function block(
  modelName: string,
  position: number,
  values: Record<string, number>,
  switchIndex: number | null,
): Record<string, unknown> {
  const model = modelByName(modelName);
  const entry: Record<string, unknown> = {
    '@enabled': true,
    '@model': modelName,
    '@no_snapshot_bypass': false,
    '@position': position,
    '@type': model?.type ?? 0,
    ...params(model, values),
  };
  if (switchIndex !== null) {
    entry['@fs_enabled'] = true;
    entry['@fs_index'] = switchIndex;
    entry['@fs_label'] = model?.short ?? 'Amp';
  }
  return entry;
}

/** Build the JSON document POD Go Edit writes for a preset. */
export function createDefaultPresetDocument(
  name = 'New Preset',
): Record<string, unknown> {
  const dsp0: Record<string, unknown> = {
    input: {
      '@input': 3,
      '@model': 'P34_AppDSPFlowInput',
      noiseGate: true,
      threshold: -48,
      decay: 0.5,
    },
    block0: block(AMP, 0, AMP_VALUES, 1),
    block1: block(CAB, 1, CAB_VALUES, null),
  };
  for (let index = 2; index < 10; index += 1) {
    dsp0[`block${index}`] = { '@position': index };
  }
  dsp0.output = {
    '@model': 'P34_AppDSPFlowOutput',
    '@output': 1,
    gain: 0,
    pan: 0.5,
  };

  return {
    data: {
      device: 2162696,
      device_version: 0x02500000,
      meta: {
        application: 'Open POD Go Edit',
        build_sha: 'offline',
        name,
      },
      tone: {
        controller: { dsp0: {} },
        dsp0,
        footswitch: {
          dsp0: {
            block0: {
              '@fs_enabled': true,
              '@fs_index': 1,
              '@fs_label': modelByName(AMP)?.short ?? 'Amp',
            },
          },
        },
        global: {
          '@current_snapshot': 0,
          '@model': '@global_params',
          '@pedalstate': 2,
          '@tempo': 120,
        },
        meta: { name },
        snapshot0: {
          '@name': 'SNAPSHOT 1',
          '@pedalstate': 2,
          '@tempo': 120,
          '@valid': true,
        },
        snapshot1: { '@name': 'SNAPSHOT 2', '@valid': false },
        snapshot2: { '@name': 'SNAPSHOT 3', '@valid': false },
        snapshot3: { '@name': 'SNAPSHOT 4', '@valid': false },
      },
    },
    meta: { original: 0, pbn: 0, premium: 0 },
    schema: 'L6Preset',
    version: 6,
  };
}

/** The default preset as an editable preset (used to seed the User list). */
export function createDefaultPreset(name = 'New Preset'): EditPreset {
  return presetFromDocument(createDefaultPresetDocument(name), 1, 0);
}
