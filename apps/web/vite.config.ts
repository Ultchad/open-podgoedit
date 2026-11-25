import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const SW_TEMPLATE = readFileSync(join(here, 'scripts/sw.template.js'), 'utf8');

/** Every file below `dir`, as POSIX paths relative to it. */
async function listFiles(dir: string, root = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path, root)));
    } else if (entry.isFile()) {
      files.push(path.slice(root.length + 1).split(sep).join('/'));
    }
  }
  return files.sort();
}

/**
 * Emit `sw.js` with a precache list of the complete build.
 *
 * The worker lives in `public/` in older builds and only cached `./`, so the
 * first visit could not open the app offline: the JavaScript and WASM had not
 * been fetched through the worker yet. Generating the list after the bundle is
 * written caches every asset during install instead.
 *
 * The cache name carries a hash of the build contents, so a deploy replaces
 * the previous cache instead of mixing old and new assets.
 */
function offlineServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'podgo-offline-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = (await listFiles(outDir)).filter(
        (file) => file !== 'sw.js' && !file.endsWith('.map'),
      );
      if (!files.includes('index.html')) {
        throw new Error('offline service worker: dist/index.html is missing');
      }

      const fingerprints = await Promise.all(
        files.map(async (file) => {
          const digest = createHash('sha256')
            .update(await readFile(join(outDir, file)))
            .digest('hex');
          return `${file}:${digest}`;
        }),
      );
      const buildId = createHash('sha256')
        .update(fingerprints.join('\n'))
        .digest('hex')
        .slice(0, 12);

      // `./` and `index.html` are the same document under two URLs; both are
      // needed because a standalone launch requests the directory, while a
      // direct link requests the file.
      const precache = ['./', ...files];
      const source = SW_TEMPLATE.replace('__BUILD_ID__', buildId).replace(
        '__PRECACHE__',
        JSON.stringify(precache, null, 2),
      );
      if (
        source.includes('podgo-editor-__BUILD_ID__') ||
        source.includes('const PRECACHE = __PRECACHE__;')
      ) {
        throw new Error('offline service worker: unresolved template placeholder');
      }
      await writeFile(join(outDir, 'sw.js'), source);
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineServiceWorker()],
  // GitHub Pages serves a project site under `/<repository>/`. Build with
  // `VITE_BASE=./` for a path-independent bundle; local dev keeps `/`.
  base: process.env.VITE_BASE || '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
});
