import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cross-origin isolation headers.
 *
 * The mGBA WebAssembly core is built with threads, so it needs
 * `SharedArrayBuffer`, which browsers only expose to cross-origin isolated
 * documents.  These headers are required in development, in preview, and on
 * whatever static host serves the production build — see docs/DEPLOYMENT.md.
 *
 * Note: cross-origin isolation is only granted to the *top-level* document.
 * Inside an embedded iframe (e.g. a preview pane) the browser withholds it even
 * when these headers are present, which is why the app detects and explains
 * that case instead of failing mysteriously.
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // WebAssembly needs 'wasm-unsafe-eval' in Chrome to compile from a worker.
  'Permissions-Policy': 'gamepad=(self), fullscreen=(self)',
};

/**
 * Serves the vendored emulator core verbatim during development.
 *
 * `public/mgba/mgba.js` must be loaded as a runtime module URL (its pthread
 * worker resolves `new URL('mgba.js', import.meta.url)`, so bundling or hashing
 * it would break), but Vite refuses to *transform* files that live in `public/`
 * when they are imported from source. In a production build the absolute URL is
 * fetched at runtime and never enters the module graph, so only the dev server
 * needs this: serving the file ourselves keeps dev and production identical.
 */
function serveCoreInDev(): Plugin {
  return {
    name: 'browsergba-serve-core-in-dev',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      const publicDir = path.join(root, 'public');
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        if (!pathname.startsWith('/mgba/')) {
          next();
          return;
        }
        const filePath = path.join(publicDir, pathname.replace(/^\/+/, ''));
        // Never serve anything outside public/.
        if (!pathFileInside(publicDir, filePath)) {
          next();
          return;
        }
        void readFile(filePath)
          .then((body) => {
            res.writeHead(200, {
              'Content-Type': pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
              ...crossOriginIsolation,
              'Cache-Control': 'no-cache',
            });
            res.end(body);
          })
          .catch(() => {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('core asset not found — run: npm run sync:core');
          });
      });
    },
  };
}

function pathFileInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Emits a service worker with a build-time precache manifest.
 *
 * Hand-rolled on purpose: it keeps the dependency tree small (no Workbox) and
 * the offline policy obvious — the app shell and the licensed emulator core are
 * precached, while user data (ROMs, saves, states, screenshots) never enters the
 * HTTP cache because it lives in IndexedDB.
 */
function offlineShell(): Plugin {
  return {
    name: 'browsergba-offline-shell',
    apply: 'build',
    async closeBundle() {
      const distDir = path.join(root, 'dist');
      const assets = await collectFiles(distDir);
      const precache = assets.filter(
        (file) =>
          !file.endsWith('sw.js') &&
          !file.endsWith('.map') &&
          // Large core binaries are cached on first use rather than at install
          // time so the first paint is not blocked by a ~2 MB download.
          !file.endsWith('mgba.wasm'),
      );

      const template = await readFile(path.join(root, 'src', 'pwa', 'sw-template.js'), 'utf8');
      const version = Date.now().toString(36);
      const sw = template
        .replaceAll('__PRECACHE_MANIFEST__', JSON.stringify(precache, null, 2))
        .replaceAll('__CACHE_VERSION__', version);

      // A leftover placeholder is not a warning: the worker would throw on
      // evaluation, never install, and the app would quietly lose offline
      // support. Fail the build where it can still be fixed.
      for (const placeholder of ['__PRECACHE_MANIFEST__', '__CACHE_VERSION__']) {
        if (sw.includes(placeholder)) {
          throw new Error(
            `sw-template.js still contains ${placeholder} after substitution — ` +
              'check that the placeholder appears only in its `const` declaration.',
          );
        }
      }

      await writeFile(path.join(distDir, 'sw.js'), sw);
      this.info?.(`service worker: ${precache.length} precached entries`);
    },
  };
}

async function collectFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(path.join(dir, entry.name), rel)));
    } else {
      out.push(`./${rel}`);
    }
  }
  return out;
}

export default defineConfig({
  root,
  base: './',
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  plugins: [serveCoreInDev(), offlineShell()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    headers: crossOriginIsolation,
    // Dev servers reached through a proxied hostname (sandboxes, tunnels,
    // preview panes) are rejected by Vite's host check by default. The server
    // only ever serves this project's own files, so accepting any Host header
    // is the right trade-off here.
    allowedHosts: true,
    // The proxy terminates TLS on 443, so the hot-reload socket must be told
    // where to reconnect; without this the client tries the raw dev port.
    hmr: { clientPort: 443 },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    headers: crossOriginIsolation,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // The core is loaded at runtime from /mgba/, never bundled.
        manualChunks: undefined,
      },
    },
  },
  // The core must be fetched as a runtime module instead of being bundled.
  optimizeDeps: { exclude: ['@thenick775/mgba-wasm'] },
  assetsInclude: ['**/*.wasm'],
});
