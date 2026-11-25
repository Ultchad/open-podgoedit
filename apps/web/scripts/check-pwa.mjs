// Verify the production build is installable and fully precached.
//
// Runs from `postbuild`, so a missing manifest icon or a service worker that
// forgot an asset fails the build instead of surfacing as a blank page when a
// user opens the installed app offline.
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');

function fail(message) {
  console.error(`check-pwa: ${message}`);
  process.exit(1);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const manifest = JSON.parse(
  await readFile(join(dist, 'manifest.webmanifest'), 'utf8'),
);
for (const field of ['name', 'short_name', 'start_url', 'display']) {
  if (!manifest[field]) {
    fail(`manifest is missing ${field}`);
  }
}
if (manifest.display !== 'standalone') {
  fail(`manifest display is ${manifest.display}, expected standalone`);
}
const icons = manifest.icons ?? [];
for (const size of ['192x192', '512x512']) {
  const icon = icons.find((entry) => entry.sizes === size);
  if (!icon) {
    fail(`manifest has no ${size} icon`);
  }
  if (!(await exists(join(dist, icon.src)))) {
    fail(`manifest icon ${icon.src} is missing from dist`);
  }
}
for (const icon of icons) {
  if (!(await exists(join(dist, icon.src)))) {
    fail(`manifest icon ${icon.src} is missing from dist`);
  }
}

const sw = await readFile(join(dist, 'sw.js'), 'utf8');
for (const placeholder of ['__BUILD_ID__', '__PRECACHE__']) {
  if (sw.includes(placeholder)) {
    fail(`sw.js still contains ${placeholder}`);
  }
}
const cache = /const CACHE = `podgo-editor-([0-9a-f]{12})`;/.exec(sw);
if (!cache) {
  fail('sw.js has no versioned cache name');
}
const match = /const PRECACHE = (\[[\s\S]*?\]);/.exec(sw);
if (!match) {
  fail('sw.js has no PRECACHE list');
}
const precache = JSON.parse(match[1]);

// Every URL the page itself references must be precached: an offline launch
// loads only index.html, and anything it links to is fetched immediately.
const html = await readFile(join(dist, 'index.html'), 'utf8');
for (const [attribute, quote, marker] of [
  ['src', '"', 'src='],
  ["src", "'", 'src='],
  ['href', '"', 'href='],
  ["href", "'", 'href='],
]) {
  const pattern = new RegExp(`${marker}${quote}([^${quote}#?]+)${quote}`, 'g');
  for (const reference of html.matchAll(pattern)) {
    let url = reference[1];
    if (
      url.startsWith('http') ||
      url.startsWith('//') ||
      url.startsWith('data:') ||
      url.startsWith('mailto:') ||
      url.startsWith('javascript:')
    ) {
      continue; // external or inline, not part of the offline bundle
    }
    // The base is either `/` (root deploy) or `./` (Pages project site).
    url = url.replace(/^(\.\/|\/)/, '');
    if (precache.includes(url) || (url === '' && precache.includes('./'))) {
      continue;
    }
    fail(`index.html references ${url}, which PRECACHE does not list`);
  }
}

const required = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
for (const entry of required) {
  if (!precache.includes(entry)) {
    fail(`PRECACHE is missing ${entry}`);
  }
}
for (const [label, pattern] of [
  ['JavaScript', /\.js$/],
  ['stylesheet', /\.css$/],
  ['WebAssembly', /\.wasm$/],
  ['fixture', /^fixtures\//],
]) {
  if (!precache.some((entry) => pattern.test(entry))) {
    fail(`PRECACHE has no ${label} asset`);
  }
}

for (const entry of precache) {
  if (entry === './') {
    continue; // the directory URL serves index.html
  }
  if (!(await exists(join(dist, decodeURIComponent(entry))))) {
    fail(`PRECACHE lists ${entry}, which is missing from dist`);
  }
}

console.log(
  `check-pwa: ${precache.length} files cached as ${cache[1]}`,
);
