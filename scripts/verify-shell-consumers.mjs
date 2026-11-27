#!/usr/bin/env node
// Verify that every platform consumes the one web bundle and that all shells
// implement the same adapter contract version.
//
// Run from the repository root after `npm --prefix apps/web run build`:
//
//   node scripts/verify-shell-consumers.mjs
//
// This is the guard for the "one UI, thin shells" rule: the desktop app embeds
// `apps/web/dist`, the Android app copies it into its assets, and Pages deploys
// it. If a shell starts pointing somewhere else, or the three shell contract
// versions drift apart, this fails before a release is built.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function read(relativePath) {
  const absolute = join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    failures.push(`missing file: ${relativePath}`);
    return '';
  }
  return readFileSync(absolute, 'utf8');
}

function expectMatch(relativePath, pattern, label) {
  const match = pattern.exec(read(relativePath));
  if (!match) {
    failures.push(`${relativePath}: could not find ${label}`);
    return null;
  }
  return Number(match[1]);
}

// --- Adapter contract versions ------------------------------------------

const webVersion = expectMatch(
  'apps/web/src/shell.ts',
  /export const SHELL_API_VERSION = (\d+)/,
  'SHELL_API_VERSION',
);
const androidVersion = expectMatch(
  'apps/android/app/src/main/java/dev/openpodgo/edit/PodgoUsbBridge.kt',
  /const val API_VERSION = (\d+)/,
  'API_VERSION',
);
const desktopVersion = expectMatch(
  'apps/desktop/src-tauri/src/lib.rs',
  /const SHELL_API_VERSION: u32 = (\d+)/,
  'SHELL_API_VERSION',
);

if (
  webVersion !== null &&
  androidVersion !== null &&
  desktopVersion !== null &&
  !(webVersion === androidVersion && webVersion === desktopVersion)
) {
  failures.push(
    `shell adapter versions differ: web=${webVersion}, android=${androidVersion}, desktop=${desktopVersion}`,
  );
}

// --- Desktop embeds apps/web/dist ---------------------------------------

const tauriConfigPath = 'apps/desktop/src-tauri/tauri.conf.json';
try {
  const tauri = JSON.parse(read(tauriConfigPath));
  const frontendDist = tauri.build?.frontendDist;
  if (!frontendDist) {
    failures.push(`${tauriConfigPath}: build.frontendDist is missing`);
  } else {
    const resolved = resolve(repoRoot, 'apps/desktop/src-tauri', frontendDist);
    const expected = join(repoRoot, 'apps/web/dist');
    if (resolved !== expected) {
      failures.push(
        `${tauriConfigPath}: frontendDist points at ${resolved}, expected ${expected}`,
      );
    }
  }
} catch (error) {
  failures.push(`${tauriConfigPath}: ${error.message}`);
}

// --- Android copies apps/web/dist ---------------------------------------

const syncScriptPath = 'apps/android/tools/sync-web-assets.mjs';
const syncScript = read(syncScriptPath);
if (
  !/join\(repoRoot, 'apps', 'web', 'dist'\)/.test(syncScript)
) {
  failures.push(
    `${syncScriptPath}: expected the asset source to be apps/web/dist`,
  );
}

// --- Pages deploys the web build ----------------------------------------

const pagesPath = '.github/workflows/pages.yml';
const pages = read(pagesPath);
if (!/working-directory: apps\/web/.test(pages)) {
  failures.push(`${pagesPath}: does not build from apps/web`);
}
if (!/run: npm run build/.test(pages)) {
  failures.push(`${pagesPath}: does not run the web build`);
}

// --- The artifact actually exists ---------------------------------------

if (!existsSync(join(repoRoot, 'apps/web/dist/index.html'))) {
  failures.push(
    'apps/web/dist/index.html is missing: run `npm --prefix apps/web run build` first',
  );
}

// --- Report --------------------------------------------------------------

if (failures.length > 0) {
  console.error('Shell consumers are out of sync:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `shell consumers OK: adapter v${webVersion}, ` +
    'desktop -> apps/web/dist, android -> apps/web/dist, pages -> apps/web',
);
