import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The offline PWA spec needs the built bundle (dist/ has the generated
  // sw.js and precache); the dev server cannot run it. It is collected by
  // pw.pwa.config.ts instead.
  testIgnore: /pwa\.spec\.ts/,
  fullyParallel: true,
  reporter: 'list',
  // The app initialises WASM before it accepts input, and the first dev-server
  // load compiles the whole bundle. A 5 s assertion timeout is too tight on a
  // slow or memory-constrained machine, so give startup a wider window.
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
