import { expect, test } from '@playwright/test';

// Offline PWA behaviour against the production bundle: `sw.js` is generated at
// build time with a full precache list, so one online visit must be enough to
// open the editor with no network afterwards. Runs via `npm run test:pwa`
// (pw.pwa.config.ts), which serves `dist/` with `vite preview`.

test('precaches the whole app and serves it offline', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);

  // The worker must be controlling the page and have finished installing
  // (precache ran during install, before activation).
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          if (!registration || !registration.active) {
            return 'missing';
          }
          return registration.active.state;
        });
        return state;
      },
      { timeout: 15_000 },
    )
    .toBe('activated');

  // Drop the network: the next reload and every asset fetch must come from the
  // service worker cache.
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await expect(page.locator('#offline-notice')).toContainText(
    'No POD Go connected',
  );

  // Every piece the editor needs came from the service worker cache: the WASM
  // core (badge), the setlist fixtures (128 presets) and the catalog.
  await expect(page.locator('.preset-item')).toHaveCount(128);
  await expect(page.locator('.snapshot')).toHaveCount(4);
  expect(errors).toEqual([]);
});