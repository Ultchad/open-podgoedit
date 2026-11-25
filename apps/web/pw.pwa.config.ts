import { defineConfig, devices } from '@playwright/test';

// PWA offline tests run against the production bundle served by `vite preview`
// (dist/), not the dev server: the service worker and the generated precache
// only exist in a built site. The build runs here so the spec is self-
// contained; CI builds once for the main suite and once more here.
export default defineConfig({
  testDir: './tests',
  testMatch: /pwa\.spec\.ts/,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chromium'] } }],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 240_000,
  },
});