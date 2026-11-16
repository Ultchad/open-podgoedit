import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Offline-first WebUI: no pedal is required to browse, edit and export. These
// tests cover the default library, the draft-then-save contract and the
// right-click menu. The fake-WebUSB flows live in `usb.spec.ts`.

test('loads factory names and a default User preset offline', async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // No pedal: say so, and point at the export path.
  const offline = page.locator('#offline-notice');
  await expect(offline).toBeVisible();
  await expect(offline).toContainText('No POD Go connected');
  await expect(offline).toContainText('Export .pgp');

  // The default working preset is a neutral, editable User preset at 01A.
  await expect(page.locator('.preset-title-name')).toHaveText('New Preset');
  await expect(page.locator('.preset-title .preset-slot')).toHaveText('01A');
  await expect(page.locator('.preset-item')).toHaveCount(128);
  const first = page.locator('.preset-item').first();
  await expect(first).toContainText('01A');
  await expect(first).toContainText('New Preset');

  // The default preset has an amp and a cab, rendered from the catalog.
  const blocks = page.locator('.block-tile');
  await expect(blocks).toHaveCount(10);
  await expect(blocks.nth(0)).toContainText('G Cougar 800');
  await expect(blocks.nth(1)).toContainText('4x10 Ampeg HLF');

  // Factory names come from the bundled setlist capture; bodies do not.
  await page.getByRole('tab', { name: /^Factory/ }).click();
  await expect(page.locator('.preset-item')).toHaveCount(128);
  await expect(page.locator('.preset-item').first()).toContainText(
    'US Deluxe Nrm',
  );

  // Developer tools are collapsed by default; the write guard only exists
  // while a pedal is connected, and Save cannot reach a pedal offline.
  await expect(page.locator('#developer-tools')).not.toHaveAttribute('open', '');
  await expect(page.locator('#arm-writes')).toHaveCount(0);
  await expect(page.locator('#save-preset')).toBeDisabled();

  const remote = requests.filter(
    (url) => !url.startsWith('http://127.0.0.1:5173/') && !url.startsWith('data:'),
  );
  expect(remote).toEqual([]);
  expect(errors).toEqual([]);
});

test('edits a draft with the slider and value field, then exports', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // Offline presets are editable straight away: the only guard is for pedal
  // writes, so no checkbox appears.
  await expect(page.locator('#arm-writes')).toHaveCount(0);
  await expect(page.locator('.readonly-chip')).toHaveText('offline preset');
  await expect(page.locator('#param-input-0')).toHaveCount(0);

  // The first block is the amp; drag the Drive bar (keyboard here, same path).
  const slider = page.locator('#param-slider-0');
  await expect(slider).toHaveValue('4');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(page.locator('#param-value-0')).toHaveText('4.1');

  // Clicking the value at the right end opens an inline number field.
  await page.locator('#param-value-0').click();
  const field = page.locator('#param-input-0');
  await expect(field).toBeVisible();
  await field.fill('6.5');
  await field.press('Enter');
  await expect(page.locator('#param-value-0')).toHaveText('6.5');
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');

  // Saving needs a connected pedal with writing enabled: the button is inert.
  await expect(page.locator('#save-preset')).toBeDisabled();

  // Ctrl+S explains the same thing instead of writing.
  await page.keyboard.press('Control+s');
  const notice = page.locator('#save-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('No POD Go connected');
  await expect(notice).toContainText('Export .pgp');

  // Export keeps the whole document and the edited value.
  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('New_Preset.pgp');
  const path = await file.path();
  const doc = JSON.parse(await readFile(path!, 'utf8'));
  expect(doc.schema).toBe('L6Preset');
  expect(doc.data.tone.dsp0.block0.Drive).toBeCloseTo(0.65, 5);
  await expect(page.locator('.readonly-chip')).toHaveText('offline preset');
});

test('keeps an offline draft when switching to another preset', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // Edit the seed preset, then move to an empty User slot.
  await page.locator('#param-value-0').click();
  await page.locator('#param-input-0').fill('6.5');
  await page.locator('#param-input-0').press('Enter');
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');

  await page.locator('.preset-item').nth(1).click();
  await expect(page.locator('.preset-title .preset-slot')).toHaveText('01B');
  await expect(page.locator('.readonly-chip')).toHaveText('offline preset');

  // Going back restores the draft instead of asking to throw it away.
  await page.locator('.preset-item').nth(0).click();
  await expect(page.locator('.preset-title .preset-slot')).toHaveText('01A');
  await expect(page.locator('#param-value-0')).toHaveText('6.5');
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');

  // Exporting is what commits the draft to the local library.
  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  const doc = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(doc.data.tone.dsp0.block0.Drive).toBeCloseTo(0.65, 5);
  await expect(page.locator('.readonly-chip')).toHaveText('offline preset');

  await page.locator('.preset-item').nth(1).click();
  await page.locator('.preset-item').nth(0).click();
  await expect(page.locator('#param-value-0')).toHaveText('6.5');
  await expect(page.locator('.readonly-chip')).toHaveText('offline preset');
});

test('right-click menu copies, pastes, renames and drags presets', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  const items = page.locator('.preset-item');

  // Copy 01A from the context menu.
  await items.nth(0).click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
  // No pedal: the menu still offers local actions, but saving is inert.
  await expect(page.locator('#menu-save')).toBeDisabled();
  await page.locator('#menu-copy').click();

  // Paste it into the next empty slot.
  await items.nth(1).click({ button: 'right' });
  await expect(page.locator('#menu-paste')).toBeEnabled();
  await page.locator('#menu-paste').click();
  await expect(items.nth(1)).toContainText('New Preset');

  // Rename the pasted preset; the prompt is the single confirmation.
  page.once('dialog', (dialog) => void dialog.accept('Lead Tone'));
  await items.nth(1).click({ button: 'right' });
  await page.locator('#menu-rename').click();
  await expect(items.nth(1)).toContainText('Lead Tone');

  // Drag it to slot 3: slots swap, so 01C becomes "Lead Tone".
  await items.nth(1).dragTo(items.nth(2));
  await expect(items.nth(2)).toContainText('Lead Tone');
  await expect(items.nth(1)).toHaveClass(/is-empty/);

  // Factory slots expose a read-only menu.
  await page.getByRole('tab', { name: /^Factory/ }).click();
  await items.nth(0).click({ button: 'right' });
  await expect(page.locator('#menu-rename')).toBeDisabled();
  await expect(page.locator('#menu-import')).toBeDisabled();
  await expect(page.locator('#menu-save')).toBeDisabled();
});

test('swaps an amp and loads an effect into an empty slot offline', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // Amp block is the first processing tile; open the model browser.
  await page.locator('.block-tile').nth(0).click();
  await expect(page.locator('.inspector-model')).toHaveText('G Cougar 800');
  await page.getByRole('tab', { name: 'Models' }).click();
  await page.locator('.model-search').fill('double');
  const tile = page
    .locator('button.model-tile', { hasText: 'US Double Nrm' })
    .first();
  await expect(tile).toBeEnabled();
  await tile.click();
  await expect(page.locator('.inspector-model')).toHaveText('US Double Nrm');
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');

  // An empty slot accepts an effects model.
  await page.locator('.block-tile').nth(2).click();
  await expect(page.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  // An empty slot is an Effects block: amp models are shown but refused.
  await page.locator('.category-row button', { hasText: 'Amp' }).click();
  await expect(
    page.locator('button.model-tile.is-blocked').first(),
  ).toBeDisabled();
  await page.locator('.category-row button', { hasText: 'Dist' }).click();
  await page.locator('.model-search').fill('tube drive');
  await page
    .locator('button.model-tile', { hasText: 'Tube Drive' })
    .first()
    .click();
  await expect(page.locator('.inspector-model')).toHaveText('Tube Drive');

  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  const doc = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(doc.data.tone.dsp0.block0['@model']).toBe('HD2_AmpUSDoubleNrm');
  expect(doc.data.tone.dsp0.block0['@type']).toBe(1);
  expect(doc.data.tone.dsp0.block2['@model']).toBe('HD2_DM4TubeDrive');
  expect(doc.data.tone.dsp0.block2['@type']).toBe(0);
});

test('reorders blocks, adds a Wah and marks browser-only presets', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // Browser-only copies and unsaved drafts are italic, in the title and list.
  await expect(page.locator('.preset-title-name')).toHaveClass(/is-unsaved/);
  await expect(page.locator('.preset-item').first()).toHaveClass(/is-browser/);

  // Input and Output stages have fixed models: no model selector.
  await page.locator('.chain-end').first().click();
  await expect(page.getByRole('tab', { name: 'Models' })).toBeDisabled();
  await page.locator('.chain-end').last().click();
  await expect(page.getByRole('tab', { name: 'Models' })).toBeDisabled();

  // An empty slot accepts a Wah now (one per preset).
  const tiles = page.locator('.block-tile');
  await tiles.nth(2).click();
  await page.locator('.category-row button', { hasText: 'Wah' }).click();
  await page.locator('.model-search').fill('vetta');
  await page.locator('button.model-tile', { hasText: 'Vetta Wah' }).click();
  await expect(page.locator('.inspector-model')).toHaveText('Vetta Wah');

  // Drag the cab past the wah: the chain reorders.
  await tiles.nth(1).dragTo(tiles.nth(2));
  await expect(tiles.nth(1)).toContainText('Vetta Wah');
  await expect(tiles.nth(2)).toContainText('4x10 Ampeg');

  // Drag the amp to the fourth slot; its footswitch assignment follows it.
  await tiles.nth(0).dragTo(tiles.nth(3));
  await expect(tiles.nth(0)).toContainText('Vetta Wah');
  await expect(tiles.nth(3)).toContainText('G Cougar');

  // A second Wah is refused: the tile is disabled.
  await tiles.nth(4).click();
  await page.locator('.category-row button', { hasText: 'Wah' }).click();
  await page.locator('.model-search').fill('vetta');
  await expect(
    page.locator('button.model-tile', { hasText: 'Vetta Wah' }).first(),
  ).toBeDisabled();

  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  const doc = JSON.parse(await readFile((await file.path())!, 'utf8'));
  const dsp0 = doc.data.tone.dsp0;
  expect(dsp0.block0['@model']).toBe('HD2_WahVettaWahStereo');
  expect(dsp0.block0['@position']).toBe(0);
  expect(dsp0.block1['@model']).toBe('HD2_Cab4x10Rhino');
  expect(dsp0.block2['@model']).toBeUndefined();
  expect(dsp0.block2['@position']).toBe(2);
  expect(dsp0.block3['@model']).toBe('HD2_AmpGCougar800');
  expect(dsp0.block3['@position']).toBe(3);
  // The FS1 assignment moved with the amp.
  expect(doc.data.tone.footswitch.dsp0.block3['@fs_label']).toBe('G Cougar 800');
  expect(doc.data.tone.footswitch.dsp0.block0).toBeUndefined();
});

test('rejects a malformed preset in the browser', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  await page.locator('input[type=file]').nth(0).setInputFiles({
    name: 'bad.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a preset'),
  });

  await expect(page.locator('.report.error')).toContainText(
    'invalid container',
  );
});
