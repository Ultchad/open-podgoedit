import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const repoRoot = resolve(webRoot, '..', '..');
const output = resolve(webRoot, 'public', 'fixtures');

const fixtures = [
  'spec02_obj22_blob.bin',
  'user_setlist.bin',
  'factory_setlist_fw250.bin',
];

await mkdir(output, { recursive: true });
for (const name of fixtures) {
  await copyFile(resolve(repoRoot, 'fixtures', name), resolve(output, name));
}
console.log(`fixtures copied to ${output}`);
