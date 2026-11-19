#!/usr/bin/env node
// Copy the built web bundle into the Android shell's assets.
//
// Usage: node apps/android/tools/sync-web-assets.mjs [--check]
//
//   --check  verify the copy exists and matches the current bundle (CI gate)
//
// The target directory is generated and git-ignored; `apps/web/dist` must
// exist first (`npm --prefix apps/web run build`).

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const source = join(repoRoot, 'apps', 'web', 'dist');
const target = join(repoRoot, 'apps', 'android', 'app', 'src', 'main', 'assets', 'www');
const checkOnly = process.argv.includes('--check');

/** Every file below `dir`, as repo-relative-forward paths. */
function listFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [relative(dir, full)];
  });
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (!existsSync(join(source, 'index.html'))) {
  console.error(`Missing ${source}/index.html. Build the web app first: npm --prefix apps/web run build`);
  process.exit(1);
}

if (checkOnly) {
  const missing = ['index.html', 'sw.js', 'manifest.webmanifest'].filter(
    (name) => !existsSync(join(target, name)),
  );
  const sourceFiles = listFiles(source).sort();
  const targetFiles = listFiles(target).sort();
  const drift = sourceFiles.filter((file) => {
    const dest = join(target, file);
    return !existsSync(dest) || digest(join(source, file)) !== digest(dest);
  });
  if (missing.length > 0 || drift.length > 0 || sourceFiles.length !== targetFiles.length) {
    console.error('Android web assets are out of date. Run: node apps/android/tools/sync-web-assets.mjs');
    for (const name of missing) {
      console.error(`  missing ${name}`);
    }
    for (const file of drift.slice(0, 10)) {
      console.error(`  stale   ${file}`);
    }
    process.exit(1);
  }
  console.log(`Android web assets match ${sourceFiles.length} files.`);
  process.exit(0);
}

// Replace rather than merge: a stale hashed asset must not survive.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

if (statSync(target).isDirectory()) {
  console.log(`Copied ${listFiles(target).length} files to ${relative(repoRoot, target)}`);
}
