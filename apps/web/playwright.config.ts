import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The offline PWA spec needs the built bundle (dist/ has the generated
  // sw.js and precache); the dev server cannot run it. It is collected by
  // pw.pwa.config.ts instead.
  testIgnore: /pwa\.spec\.ts/,
  fullyParallel: true,
  reporter: 'list',
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
