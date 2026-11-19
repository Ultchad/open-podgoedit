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
  await expect(page.locator('.readonly-chip')).toHaveText('offline');
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
  await expect(page.locator('.readonly-chip')).toHaveText('offline');
});

test('undoes and redoes parameter edits with the keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // One draft edit: Drive 4.0 → 4.1.
  const slider = page.locator('#param-slider-0');
  await expect(slider).toHaveValue('4');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(page.locator('#param-value-0')).toHaveText('4.1');
  await expect(page.locator('#undo-edit')).toBeEnabled();

  // Ctrl/Cmd+Z restores the previous value; Shift+Z (and Ctrl+Y) redo it.
  await page.keyboard.press('Control+z');
  await expect(page.locator('#param-value-0')).toHaveText('4.0');
  await expect(page.locator('#save-notice')).toContainText('Undid the parameter edit');
  await expect(page.locator('#redo-edit')).toBeEnabled();

  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('#param-value-0')).toHaveText('4.1');
  await expect(page.locator('#save-notice')).toContainText('Redid the parameter edit');

  await page.keyboard.press('Control+z');
  await expect(page.locator('#param-value-0')).toHaveText('4.0');
  await page.keyboard.press('Control+y');
  await expect(page.locator('#param-value-0')).toHaveText('4.1');

  // The toolbar buttons use the same bounded history.
  await page.locator('#undo-edit').click();
  await expect(page.locator('#param-value-0')).toHaveText('4.0');
  await page.locator('#redo-edit').click();
  await expect(page.locator('#param-value-0')).toHaveText('4.1');

  // Undo must also restore the offline document, not only the rendered
  // structure: export after undoing the last edit writes the old value.
  await page.keyboard.press('Control+z');
  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  const doc = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(doc.data.tone.dsp0.block0.Drive).toBeCloseTo(0.4, 5);
});

test('copies an effect between presets with Ctrl+C and Ctrl+V', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // Put an effect in the first preset's third slot and tweak one value.
  await page.locator('.block-tile').nth(2).click();
  await page.locator('.category-row button', { hasText: 'Dist' }).click();
  await page.locator('.model-search').fill('tube drive');
  await page
    .locator('button.model-tile', { hasText: 'Tube Drive' })
    .first()
    .click();
  await expect(page.locator('.inspector-model')).toHaveText('Tube Drive');
  await page.locator('#param-slider-0').focus();
  await page.locator('#param-slider-0').press('ArrowRight');
  const copiedValue = await page.locator('#param-value-0').textContent();
  expect(copiedValue).not.toBe('0');

  // Copy the effect, leave it in the in-tab clipboard, open another preset.
  await page.keyboard.press('Control+c');
  await expect(page.locator('#save-notice')).toContainText('Copied Tube Drive');

  await page.locator('.preset-item').nth(1).click();
  await expect(page.locator('.preset-title .preset-slot')).toHaveText('01B');
  await page.locator('.block-tile').nth(2).click();
  await expect(page.locator('.inspector-model')).toHaveText('Empty slot');

  // Paste into the empty slot of the other preset.
  await page.keyboard.press('Control+v');
  await expect(page.locator('.inspector-model')).toHaveText('Tube Drive');
  await expect(page.locator('#param-value-0')).toHaveText(copiedValue!);
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');

  // Undo removes the pasted effect but keeps the offline preset open.
  await page.keyboard.press('Control+z');
  await expect(page.locator('.inspector-model')).toHaveText('Empty slot');
  await expect(page.locator('.readonly-chip')).toHaveText('offline');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.inspector-model')).toHaveText('Tube Drive');

  // The exported document carries the copied model and value.
  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  const doc = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(doc.data.tone.dsp0.block2['@model']).toBe('HD2_DM4TubeDrive');
});

test('opens effect actions from right-click, long-press and the inspector', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  const menu = page.locator('.context-menu[aria-label="Effect actions"]');
  const tiles = page.locator('.block-tile');

  // Right-click the amp: copy is available, moving left is not.
  await tiles.nth(0).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(page.locator('#block-menu-copy')).toBeEnabled();
  await expect(page.locator('#block-menu-paste')).toBeDisabled();
  await expect(page.locator('#block-menu-move-left')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // A touch long-press opens the same menu.
  const box = await tiles.nth(0).boundingBox();
  expect(box).not.toBeNull();
  await tiles.nth(0).dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: (box?.x ?? 0) + 20,
    clientY: (box?.y ?? 0) + 20,
  });
  await page.waitForTimeout(600);
  await expect(menu).toBeVisible();
  await tiles.nth(0).dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    button: 0,
  });
  await page.keyboard.press('Escape');

  // The inspector ⋯ button opens it too, focuses the first item, and Escape
  // returns focus to the button.
  await page.locator('.inspector-more').click();
  await expect(menu).toBeVisible();
  await expect(page.locator('#block-menu-copy')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#block-menu-move-right')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.inspector-more')).toBeFocused();
});

test('copies and pastes an effect through the block menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // Put a Dist effect in the first preset.
  await page.locator('.block-tile').nth(2).click();
  await page.locator('.category-row button', { hasText: 'Dist' }).click();
  await page.locator('.model-search').fill('tube drive');
  await page
    .locator('button.model-tile', { hasText: 'Tube Drive' })
    .first()
    .click();
  await expect(page.locator('.inspector-model')).toHaveText('Tube Drive');

  // Copy it from the effect menu.
  await page.locator('.block-tile').nth(2).click({ button: 'right' });
  await expect(page.locator('#block-menu-copy')).toBeEnabled();
  await page.locator('#block-menu-copy').click();
  await expect(page.locator('#save-notice')).toContainText('Copied Tube Drive');

  // Paste it into an empty slot of another preset from the same menu.
  await page.locator('.preset-item').nth(1).click();
  await expect(page.locator('.preset-title .preset-slot')).toHaveText('01B');
  await page.locator('.block-tile').nth(2).click({ button: 'right' });
  await expect(page.locator('#block-menu-paste')).toBeEnabled();
  await page.locator('#block-menu-paste').click();
  await expect(page.locator('.inspector-model')).toHaveText('Tube Drive');
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');
});

test.describe('phone layout', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('opens the preset drawer, closes it on pick, and uses finger targets', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

    await expect(page.locator('#toggle-presets')).toBeVisible();
    await page.locator('#toggle-presets').click();
    await expect(page.locator('#preset-librarian')).toHaveClass(/is-open/);

    const presetBox = await page.locator('.preset-item').first().boundingBox();
    expect(presetBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await page.locator('.preset-item').nth(1).click();
    await expect(page.locator('.preset-title .preset-slot')).toHaveText('01B');
    await expect(page.locator('#preset-librarian')).not.toHaveClass(/is-open/);

    for (const selector of ['#toggle-presets', '#connect', '#new-preset']) {
      const target = await page.locator(selector).boundingBox();
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const tileBox = await page.locator('.block-tile').first().boundingBox();
    expect(tileBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(tileBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('closes a dialog with Escape and the backdrop', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

    await page.locator('#import-edit-file').click();
    await expect(page.locator('.import-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.import-dialog')).toHaveCount(0);

    await page.locator('#import-edit-file').click();
    await expect(page.locator('.import-dialog')).toBeVisible();
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.import-dialog')).toHaveCount(0);
  });
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
  await expect(page.locator('.readonly-chip')).toHaveText('offline');

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
  await expect(page.locator('.readonly-chip')).toHaveText('offline');

  await page.locator('.preset-item').nth(1).click();
  await page.locator('.preset-item').nth(0).click();
  await expect(page.locator('#param-value-0')).toHaveText('6.5');
  await expect(page.locator('.readonly-chip')).toHaveText('offline');
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

  // Move it to slot 3 from the context menu, typed as the pedal's label
  // (01C): slots swap, so 01C becomes "Lead Tone" and 01B becomes empty.
  page.once('dialog', (dialog) => void dialog.accept('01C'));
  await items.nth(1).click({ button: 'right' });
  await page.locator('#menu-move').click();
  await expect(items.nth(2)).toContainText('Lead Tone');
  await expect(items.nth(1)).toHaveClass(/is-empty/);

  // A plain number is still accepted (1-based), and a bad label is refused.
  page.once('dialog', (dialog) => void dialog.accept('nope'));
  await items.nth(2).click({ button: 'right' });
  await page.locator('#menu-move').click();
  await expect(page.locator('#save-notice')).toContainText('is not a slot');
  await expect(items.nth(2)).toContainText('Lead Tone');

  // A plain number (3 = 01C), a bare label (2B = 02B) and mixed case all
  // resolve; an out-of-range or malformed label is refused.
  page.once('dialog', (dialog) => void dialog.accept('3'));
  await items.nth(2).click({ button: 'right' });
  await page.locator('#menu-move').click();
  await expect(items.nth(2)).toContainText('Lead Tone');
  page.once('dialog', (dialog) => void dialog.accept('2b'));
  await items.nth(2).click({ button: 'right' });
  await page.locator('#menu-move').click();
  await expect(items.nth(5)).toContainText('Lead Tone');
  page.once('dialog', (dialog) => void dialog.accept('33A'));
  await items.nth(5).click({ button: 'right' });
  await page.locator('#menu-move').click();
  await expect(page.locator('#save-notice')).toContainText('is not a slot');
  await expect(items.nth(5)).toContainText('Lead Tone');

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

test('links to GitHub and edits snapshot bypass, values and LED colours', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // The repository link sits next to the WASM badge.
  const github = page.locator('header .github-link');
  await expect(github).toBeVisible();
  await expect(github).toHaveAttribute(
    'href',
    'https://github.com/Ultchad/open-podgoedit',
  );

  const chips = page.locator('.snapshot');
  await expect(chips).toHaveCount(4);
  const ampCamera = page.locator('.snapshot-assign').first();

  // Nothing is snapshot-controlled yet; the camera toggle assigns it.
  await expect(ampCamera).toHaveAttribute('aria-pressed', 'false');
  await ampCamera.click();
  await expect(ampCamera).toHaveAttribute('aria-pressed', 'true');

  // Bypass the amp in snapshot 1 (the loaded snapshot).
  const bypass = page.locator('.inspector-state.is-toggle');
  await expect(bypass).toHaveText('active');
  await bypass.click();
  await expect(bypass).toHaveText('bypassed');

  // Snapshot 1 stores Drive = 7.5.
  await page.locator('#param-value-0').click();
  const drive = page.locator('#param-input-0');
  await drive.fill('7.5');
  await drive.press('Enter');
  await expect(page.locator('#param-value-0')).toHaveText('7.5');

  // Snapshot 2 keeps the amp active and stores Drive = 2, plus a blue LED.
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveClass(/is-active/);
  await expect(page.locator('#param-value-0')).toHaveText('4.0');
  await expect(page.locator('.inspector-state.is-toggle')).toHaveText('active');
  await page.locator('#param-value-0').click();
  const secondDrive = page.locator('#param-input-0');
  await secondDrive.fill('2');
  await secondDrive.press('Enter');
  await expect(page.locator('#param-value-0')).toHaveText('2.0');
  // The LED colour now lives in the snapshot right-click menu.
  await chips.nth(1).click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Snapshot 2 actions' })
    .getByRole('menuitemradio', { name: 'Blue' })
    .click();

  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  const doc = JSON.parse(await readFile((await file.path())!, 'utf8'));
  const tone = doc.data.tone;

  // The Snapshots controller is controller number 10 (ITM for POD Go).
  expect(tone.controller.dsp0.block0.Drive['@controller']).toBe(10);
  // Each snapshot carries its own Drive value.
  expect(
    tone.snapshot0.controllers.dsp0.block0.Drive['@value'],
  ).toBeCloseTo(0.75, 5);
  expect(
    tone.snapshot1.controllers.dsp0.block0.Drive['@value'],
  ).toBeCloseTo(0.2, 5);
  // Bypass is per snapshot; snapshot 2 was seeded from the previous state.
  expect(tone.snapshot0.blocks.dsp0.block0).toBe(false);
  expect(tone.snapshot1.blocks.dsp0.block0).toBe(true);
  // The LED palette index is stored as an index, not an RGB value.
  expect(tone.snapshot1['@ledcolor']).toBe(8);
  // Snapshot 1 keeps the default Auto entry (absent in the seeded document).
  expect(tone.snapshot0['@ledcolor'] ?? 0).toBe(0);

  // Removing the Snapshots controller clears the base entry and every value.
  await ampCamera.click();
  await expect(ampCamera).toHaveAttribute('aria-pressed', 'false');
  const removedDownload = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const removed = JSON.parse(
    await readFile((await (await removedDownload).path())!, 'utf8'),
  );
  expect(removed.data.tone.controller.dsp0.block0?.Drive).toBeUndefined();
  expect(
    removed.data.tone.snapshot0.controllers.dsp0.block0?.Drive,
  ).toBeUndefined();
});

test('marks EXP-controlled parameters as not assignable to snapshots', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  await page.getByRole('button', { name: 'Import…' }).click();
  await page
    .locator('#import-file')
    .setInputFiles(
      new URL('../../../fixtures/spec02_a.pgp', import.meta.url).pathname,
    );
  await expect(page.locator('#import-preset-name')).toBeVisible();
  await page.locator('#import-open').click();

  // The first block's Pedal parameter follows EXP 2: the camera toggle is
  // disabled so the assignment cannot be overwritten silently.
  const pedal = page.locator('.snapshot-assign').first();
  await expect(pedal).toBeDisabled();
  await expect(pedal).toHaveAttribute('aria-pressed', 'false');
  await expect(pedal).toHaveAttribute('title', /EXP 2 controls this parameter/);
});

test('opens snapshot actions from the right-click menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  const chips = page.locator('.snapshot');
  const menu = page.getByRole('menu', { name: 'Snapshot 3 actions' });

  // Right-clicking a chip opens its own actions, without changing the draft.
  await chips.nth(2).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('SNAPSHOT 3');
  await menu
    .getByRole('menuitem', { name: 'Use as active snapshot' })
    .click();
  await expect(chips.nth(2)).toHaveClass(/is-active/);

  // Rename from the menu opens the same inline field as a double-click.
  await chips.nth(2).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Rename snapshot…' }).click();
  const nameField = page.getByRole('textbox', { name: 'Snapshot 3 name' });
  await expect(nameField).toBeVisible();
  await nameField.fill('LEAD');
  await nameField.press('Enter');
  await expect(chips.nth(2)).toContainText('LEAD');

  // The palette writes the fixed LED index and updates the chip dot.
  await chips.nth(2).click({ button: 'right' });
  await menu.getByRole('menuitemradio', { name: 'Blue' }).click();
  await expect(chips.nth(2).locator('.snapshot-led')).toHaveCSS(
    'background-color',
    'rgb(59, 130, 246)',
  );

  // Clearing the custom name falls back to SNAPSHOT 3.
  await chips.nth(2).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Clear custom name' }).click();
  await expect(chips.nth(2)).toContainText('SNAPSHOT 3');

  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  const doc = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(doc.data.tone.global['@current_snapshot']).toBe(2);
  expect(doc.data.tone.snapshot2['@name']).toBeUndefined();
  expect(doc.data.tone.snapshot2['@ledcolor']).toBe(8);
});

test('selects and renames snapshots offline, then exports them', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  const chips = page.locator('.snapshot');
  await expect(chips).toHaveCount(4);
  await expect(chips.nth(0)).toHaveClass(/is-active/);

  // Clicking a chip loads that snapshot in the draft.
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveClass(/is-active/);
  await expect(chips.nth(0)).not.toHaveClass(/is-active/);
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');

  // Double-clicking the name opens an inline field; Enter accepts.
  await chips.nth(1).dblclick();
  const nameField = page.getByRole('textbox', { name: 'Snapshot 2 name' });
  await expect(nameField).toBeVisible();
  await nameField.fill('GTR SOLO');
  await nameField.press('Enter');
  await expect(chips.nth(1)).toContainText('GTR SOLO');

  // The manual's limit is 10 characters; other bytes are refused.
  await chips.nth(2).dblclick();
  const longField = page.getByRole('textbox', { name: 'Snapshot 3 name' });
  await longField.fill('1234567890ABC');
  await expect(longField).toHaveValue('1234567890');
  await longField.press('Enter');
  await expect(chips.nth(2)).toContainText('1234567890');
  await expect(chips.nth(3)).toContainText('SNAPSHOT 4');

  const download = page.waitForEvent('download');
  await page.locator('#export-pgp').click();
  const file = await download;
  const doc = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(doc.data.tone.global['@current_snapshot']).toBe(2);
  expect(doc.data.tone.snapshot1['@name']).toBe('GTR SOLO');
  expect(doc.data.tone.snapshot2['@name']).toBe('1234567890');
  expect(doc.data.tone.snapshot3['@name']).toBe('SNAPSHOT 4');
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
