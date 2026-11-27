import { expect, test } from '@playwright/test';

/**
 * The web bundle is the UI for the browser, the Android WebView app and the
 * Tauri desktop app. Each native shell reports the adapter version it
 * implements; the startup handshake must flag a shell that predates this
 * bundle instead of failing later in a confusing way.
 */

const READY = /WASM ready/;

test('flags an Android package built for an older shell contract', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'usb', {
      value: undefined,
      configurable: true,
    });
    (
      window as unknown as { podgoAndroidUsb?: unknown }
    ).podgoAndroidUsb = {
      present: true,
      // An old APK predates the handshake, or reports an older contract.
      apiVersion: () => 0,
      open: () => 'POD Go (fake) (0x4247)',
      close: () => undefined,
      discard: () => undefined,
      write: () => undefined,
      read: () => null,
    };
  });

  await page.goto('/');
  await expect(page.locator('header .badge.ready')).toHaveText(READY);
  await expect(page.locator('main.app')).toHaveAttribute(
    'data-shell',
    'android',
  );
  await expect(page.locator('main.app')).toHaveAttribute(
    'data-shell-outdated',
    'true',
  );
  await expect(page.locator('#shell-bridge-warning')).toHaveText(
    'App update needed',
  );

  // The mismatch is diagnostic only: the editor still loads and stays usable.
  await expect(page.locator('.preset-title-name')).toBeVisible();
});

test('accepts an Android package on the current shell contract', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'usb', {
      value: undefined,
      configurable: true,
    });
    (
      window as unknown as { podgoAndroidUsb?: unknown }
    ).podgoAndroidUsb = {
      present: true,
      apiVersion: () => 1,
      open: () => 'POD Go (fake) (0x4247)',
      close: () => undefined,
      discard: () => undefined,
      write: () => undefined,
      read: () => null,
    };
  });

  await page.goto('/');
  await expect(page.locator('header .badge.ready')).toHaveText(READY);
  await expect(page.locator('main.app')).toHaveAttribute(
    'data-shell-outdated',
    'false',
  );
  await expect(page.locator('#shell-bridge-warning')).toHaveCount(0);
});

test('flags a desktop package that does not answer the handshake', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: async (command: string) => {
          switch (command) {
            case 'shell_api_version':
              return 0;
            default:
              throw new Error(`unexpected command ${command}`);
          }
        },
      },
    };
  });

  await page.goto('/');
  await expect(page.locator('header .badge.ready')).toHaveText(READY);
  await expect(page.locator('main.app')).toHaveAttribute(
    'data-shell',
    'desktop',
  );
  await expect(page.locator('main.app')).toHaveAttribute(
    'data-shell-outdated',
    'true',
  );
  await expect(page.locator('#shell-bridge-warning')).toBeVisible();
});

test('the browser bundle is always current with itself', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header .badge.ready')).toHaveText(READY);
  await expect(page.locator('main.app')).toHaveAttribute(
    'data-shell',
    'browser',
  );
  await expect(page.locator('main.app')).toHaveAttribute(
    'data-shell-outdated',
    'false',
  );
  await expect(page.locator('#shell-bridge-warning')).toHaveCount(0);
});
