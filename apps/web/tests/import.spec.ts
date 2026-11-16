import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Synthetic POD Go Edit files. They use the observed shapes (L6Preset,
// L6Setlist, AF6L header + zlib members + IDGP directory) but contain only
// invented names, so the repository never ships a personal backup.

interface ToneOptions {
  name: string;
}

function tone({ name }: ToneOptions) {
  const dsp0: Record<string, unknown> = {
    input: {
      '@input': 3,
      '@model': 'P34_AppDSPFlowInput',
      noiseGate: true,
      threshold: -48,
      decay: 0.5,
    },
  };
  dsp0.block0 = {
    '@enabled': true,
    '@model': 'HD2_VolPanVolStereo',
    '@no_snapshot_bypass': false,
    '@position': 0,
    '@type': 0,
    Pedal: 1,
    VolumeTaper: false,
  };
  dsp0.block1 = {
    '@enabled': true,
    '@fs_enabled': true,
    '@fs_index': 2,
    '@fs_label': 'Wah',
    '@model': 'HD2_WahFasselStereo',
    '@no_snapshot_bypass': false,
    '@position': 1,
    '@type': 0,
    FcHigh: 2155,
    FcLow: 455,
    Level: 0,
    Mix: 1,
    Pedal: 0.5,
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
    controller: {
      dsp0: {
        block1: {
          Pedal: { '@controller': 1, '@min': 0, '@max': 1 },
        },
      },
    },
    dsp0,
    global: {
      '@current_snapshot': 0,
      '@model': '@global_params',
      '@pedalstate': 2,
      '@tempo': 120,
    },
    snapshot0: {
      '@name': 'SNAPSHOT 1',
      '@pedalstate': 2,
      '@tempo': 120,
      '@valid': true,
    },
    snapshot1: { '@name': 'SNAPSHOT 2', '@valid': false },
    snapshot2: { '@name': 'SNAPSHOT 3', '@valid': false },
    snapshot3: { '@name': 'SNAPSHOT 4', '@valid': false },
    footswitch: {
      dsp0: {
        block1: {
          '@fs_enabled': true,
          '@fs_index': 2,
          '@fs_label': 'Wah',
        },
      },
    },
    meta: { name },
  };
}

function presetDocument(name: string) {
  return {
    data: {
      device: 2162696,
      device_version: 0x02500000,
      meta: { application: 'POD Go Edit', build_sha: 'v2.50-test', name },
      tone: tone({ name }),
    },
    meta: { original: 0, pbn: 0, premium: 0 },
    schema: 'L6Preset',
    version: 6,
  };
}

function presetBody(name: string) {
  return presetDocument(name).data;
}

function setlistDocument(name: string, presets: unknown[]) {
  return {
    data: { meta: { name }, presets },
    schema: 'L6Setlist',
    version: 2,
  };
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

interface Member {
  tag: string;
  stored: Buffer;
  codec: number;
  original: number;
}

function member(tag: string, document: unknown): Member {
  const plain = Buffer.from(JSON.stringify(document), 'utf8');
  const stored = deflateSync(plain);
  return { tag, stored, codec: 1, original: plain.length };
}

function buildPgb(setlists: { name: string; presets: unknown[] }[]): Buffer {
  const members: Member[] = [
    {
      tag: 'SLNM',
      stored: Buffer.from('Factory\0User\0', 'latin1'),
      codec: 0,
      original: 13,
    },
    member('GLOB', {
      DSP: { AmpOutSource: 1 },
      System: { TempoGlobal: 120 },
      Tuner: { Output: 0, RefFreq: 440 },
    }),
    ...setlists.map((setlist, index) =>
      member(`SL0${index}`, setlistDocument(setlist.name, setlist.presets)),
    ),
  ];

  const headerLength = 48;
  let offset = headerLength;
  const records: {
    tag: string;
    offset: number;
    stored: Member;
  }[] = [];
  for (const item of members) {
    records.push({ tag: item.tag, offset, stored: item });
    offset += item.stored.length;
  }
  const directoryOffset = offset;

  const header = Buffer.alloc(headerLength);
  header.write('AF6L', 0, 'latin1');
  header.writeUInt32LE(1, 4);
  header.writeBigUInt64LE(BigInt(directoryOffset), 8);

  const directorySize = 8 + 24 + records.length * 36 + 4;
  const directory = Buffer.alloc(directorySize);
  directory.write('IDGP', 0, 'latin1');
  directory.writeUInt32LE(24, 4);
  // The 24-byte directory header body is reserved; records start at +32.
  let pos = 32;
  for (const record of records) {
    directory.writeUInt32LE(0, pos);
    const reversed = Buffer.from(record.tag, 'latin1').reverse();
    reversed.copy(directory, pos + 4);
    directory.writeBigUInt64LE(BigInt(record.offset), pos + 8);
    directory.writeBigUInt64LE(BigInt(record.stored.stored.length), pos + 16);
    directory.writeUInt32LE(record.stored.codec, pos + 24);
    directory.writeBigUInt64LE(BigInt(record.stored.original), pos + 28);
    pos += 36;
  }

  return Buffer.concat([
    header,
    ...members.map((item) => item.stored),
    directory,
  ]);
}

test('opens .pgp and .pgb files without device writes', async ({ page }) => {
  const pgp = presetDocument('Test Clean');
  const pgb = buildPgb([
    {
      name: 'Factory',
      presets: [presetBody('Factory Clean'), {}, {}, {}, {}],
    },
    {
      name: 'User',
      presets: [{}, {}, {}, {}, {}, presetBody('User Lead')],
    },
  ]);

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  await page.locator('#import-edit-file').click();
  await expect(page.locator('#import-dialog-title')).toBeVisible();
  await page.locator('#import-file').setInputFiles({
    name: 'Test Clean.pgp',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pgp)),
  });
  await expect(page.locator('#import-preset-name')).toHaveText('Test Clean');
  await expect(page.locator('#import-summary')).toContainText(
    'POD Go (0x210008) / 2.50',
  );
  await expect(page.locator('#import-detail')).toContainText(
    '1 footswitch assignment(s)',
  );
  await page.locator('#import-open').click();

  await expect(page.locator('.preset-title-name')).toHaveText('Test Clean');
  await expect(page.locator('.block-tile')).toHaveCount(10);
  await expect(page.locator('.editor-source')).toContainText('User 01B');
  // Imported presets have no l6-helix body and no pedal is connected, so the
  // raw .bin download and the write guard are absent; the JSON copy is still
  // editable and exports as .pgp.
  await expect(page.locator('#arm-writes')).toHaveCount(0);
  await expect(page.locator('#download-preset')).toBeDisabled();

  await page.locator('#import-edit-file').click();
  await page.locator('#import-file').setInputFiles({
    name: 'backup.pgb',
    mimeType: 'application/octet-stream',
    buffer: pgb,
  });
  await expect(page.locator('.import-setlist-tab')).toHaveCount(2, {
    timeout: 30000,
  });
  await expect(page.locator('.import-setlist-tab').nth(0)).toContainText(
    'Factory (1)',
  );
  await expect(page.locator('.import-setlist-tab').nth(1)).toContainText(
    'User (1)',
  );

  await page.locator('.import-setlist-tab').nth(1).click();
  await page.locator('.import-slot[data-slot="5"]').click();
  await expect(page.locator('#import-detail')).toContainText('User Lead');
  await page.locator('#import-open').click();

  await expect(page.locator('.preset-title-name')).toHaveText('User Lead');
  await expect(page.locator('.editor-source')).toContainText('User 02B');
  await expect(page.locator('#download-preset')).toBeDisabled();
});


test('edits an imported preset offline and exports a .pgp', async ({ page }) => {
  const pgp = presetDocument('Test Clean');
  // An unknown field must survive the round trip untouched.
  (pgp.data.tone.dsp0.block1 as Record<string, unknown>)['@custom_tag'] =
    'keep-me';

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  await page.locator('#import-edit-file').click();
  await page.locator('#import-file').setInputFiles({
    name: 'Test Clean.pgp',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pgp)),
  });
  await expect(page.locator('#import-preset-name')).toHaveText('Test Clean');
  await page.locator('#import-open').click();

  // The preset is an offline copy: export is offered, device writes are not.
  await expect(page.locator('.readonly-chip')).toHaveText('offline preset');
  await expect(page.locator('#export-pgp')).toBeEnabled();
  await expect(page.locator('#arm-writes')).toHaveCount(0);

  // Edit the Wah Mix (catalog index 3, a 0..1 knob shown on the 0-10 scale)
  // through the value field at the end of its slider. The change is a draft
  // until Export.
  await page.locator('.block-tile').nth(1).click();
  await page.locator('#param-value-3').click();
  await expect(page.locator('#param-input-3')).toBeVisible();
  await page.locator('#param-input-3').fill('2.5');
  await page.locator('#param-input-3').press('Enter');
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');
  await expect(page.locator('.report.log')).toContainText('Draft:');

  // Rename the offline copy.
  page.once('dialog', (dialog) => void dialog.accept('Renamed Clean'));
  await page.locator('#rename-preset').click();
  await expect(page.locator('.preset-title-name')).toHaveText('Renamed Clean');

  // Export and inspect the JSON.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-pgp').click(),
  ]);
  expect(download.suggestedFilename()).toBe('Renamed_Clean.pgp');
  const path = await download.path();
  const exported = JSON.parse(readFileSync(path ?? '', 'utf8'));
  expect(exported.schema).toBe('L6Preset');
  expect(exported.version).toBe(6);
  expect(exported.data.meta.name).toBe('Renamed Clean');
  expect(exported.data.device).toBe(2162696);
  expect(exported.data.tone.dsp0.block1.Mix).toBeCloseTo(0.25, 6);
  expect(exported.data.tone.dsp0.block1['@custom_tag']).toBe('keep-me');
  expect(exported.data.tone.dsp0.block1.FcHigh).toBe(2155);
  expect(exported.data.tone.snapshot0['@name']).toBe('SNAPSHOT 1');
  await expect(page.locator('.readonly-chip')).toHaveText('offline preset');

  // The exported file re-opens in this reader with the edited values.
  await page.locator('#import-edit-file').click();
  await page.locator('#import-file').setInputFiles({
    name: 'Renamed Clean.pgp',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.locator('#import-preset-name')).toHaveText('Renamed Clean');
  await page.locator('#import-open').click();
  await page.locator('.block-tile').nth(1).click();
  await page.locator('#param-value-3').click();
  await expect(page.locator('#param-input-3')).toHaveValue('2.5');
  await page.locator('#param-input-3').press('Escape');

  // A preset opened from a .pgb is exported with the observed .pgp envelope.
  const pgb = buildPgb([
    { name: 'Factory', presets: [presetBody('Factory Clean')] },
    { name: 'User', presets: [{}, {}, {}, {}, {}, presetBody('User Lead')] },
  ]);
  await page.locator('#import-edit-file').click();
  await page.locator('#import-file').setInputFiles({
    name: 'backup.pgb',
    mimeType: 'application/octet-stream',
    buffer: pgb,
  });
  await expect(page.locator('.import-setlist-tab')).toHaveCount(2, {
    timeout: 30000,
  });
  await page.locator('.import-setlist-tab').nth(1).click();
  await page.locator('.import-slot[data-slot="5"]').click();
  await expect(page.locator('#import-detail')).toContainText('User Lead');
  await page.locator('#import-open').click();

  const [backupExport] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-pgp').click(),
  ]);
  expect(backupExport.suggestedFilename()).toBe('User_Lead.pgp');
  const backupPath = await backupExport.path();
  const fromBackup = JSON.parse(readFileSync(backupPath ?? '', 'utf8'));
  expect(fromBackup.schema).toBe('L6Preset');
  expect(fromBackup.version).toBe(6);
  expect(fromBackup.meta).toEqual({ original: 0, pbn: 0, premium: 0 });
  expect(fromBackup.data.meta.name).toBe('User Lead');
  expect(fromBackup.data.tone.dsp0.block1.Mix).toBe(1);
});
