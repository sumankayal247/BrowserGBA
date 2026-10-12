/**
 * Shared browser-test harness.
 *
 * Both the core probe (`run-smoke.mjs`) and the end-to-end app test
 * (`run-app.mjs`) need the same three things: a Chromium binary to point at, a
 * static server that sends cross-origin isolation headers, and a few small
 * waiting helpers. They live here so the two scripts cannot drift apart.
 *
 * The browser is intentionally *not* downloaded by this project: CI provides one
 * via `BROWSERGBA_CHROMIUM`, and the scripts explain themselves and skip when it
 * is missing instead of failing a build for an unrelated reason.
 *
 * Point `BROWSERGBA_FIREFOX` at a Firefox build and the same suites run in Gecko
 * instead. See `launchBrowser()` for what that changes.
 */
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CHROMIUM_CANDIDATES = [
  process.env.BROWSERGBA_CHROMIUM,
  '/tmp/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export async function findChromium() {
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const FIREFOX_CANDIDATES = [
  process.env.BROWSERGBA_FIREFOX,
  '/usr/bin/firefox',
  '/usr/bin/firefox-esr',
  '/usr/lib/firefox/firefox',
  '/snap/bin/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
].filter(Boolean);

export async function findFirefox() {
  for (const candidate of FIREFOX_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Launches the browser the suites should run in.
 *
 * Chromium is the default because it is what CI has. Setting `BROWSERGBA_FIREFOX`
 * (or having a Firefox binary in the usual place) switches the same checks to
 * Firefox: the app is expected to behave identically there, and the differences are
 * real — Gecko refuses `navigator.vibrate` on desktop, partitions third-party
 * iframes' storage, and keeps F5/F9 for reload and Reader View, which is why the
 * keyboard defaults avoid those keys.
 *
 * Firefox is driven over WebDriver BiDi rather than Chromium's CDP, so anything
 * Chromium-specific (the CDP download plumbing, for instance) is skipped instead of
 * being called and failing. The checks themselves stay the same.
 *
 * @returns {Promise<{ browser: import('puppeteer-core').Browser, engine: 'chromium'|'firefox', engineLabel: string } | null>}
 */
export async function launchBrowser({ headless = true } = {}) {
  const { default: puppeteer } = await import('puppeteer-core');
  const firefox = process.env.BROWSERGBA_FIREFOX ? await findFirefox() : null;

  if (firefox) {
    console.log(`[harness] launching Firefox at ${firefox}`);
    const browser = await puppeteer.launch({
      browser: 'firefox',
      executablePath: firefox,
      headless,
      protocol: 'webDriverBiDi',
      extraPrefsFirefox: {
        // SharedArrayBuffer behind COOP/COEP is on by default in current Firefox;
        // set explicitly so an enterprise profile cannot silently cost the core its
        // threads and turn the emulator into a slow single-threaded build.
        'javascript.options.shared_memory': true,
        'dom.postMessage.sharedArrayBuffer.withCOOP_COEP': true,
        // The suites open cross-origin windows/iframes on 127.0.0.1 and expect the
        // app's service worker to be usable there.
        'dom.serviceWorkers.enabled': true,
        'browser.tabs.warnOnClose': false,
      },
    });
    return { browser, engine: 'firefox', engineLabel: 'Firefox' };
  }

  const chromium = await findChromium();
  if (!chromium) return null;
  const browser = await puppeteer.launch({
    executablePath: chromium,
    headless,
    args: CHROMIUM_ARGS,
  });
  return { browser, engine: 'chromium', engineLabel: 'Chromium' };
}

export function skipMessage(script) {
  console.log(`[${script}] SKIPPED — no browser binary found.`);
  console.log(`[${script}] Set BROWSERGBA_CHROMIUM=/path/to/chrome (or BROWSERGBA_FIREFOX=/path/to/firefox) to enable this check.`);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.gba': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves one or more directories under a single origin.
 *
 * `mounts` maps a URL prefix to a directory; the first mount whose directory
 * contains the file wins, and served paths are confined to the repo. Mounts are
 * isolated by default (COOP/COEP), which is what the emulator core needs; a
 * mount can opt out with `isolated: false` to reproduce an ordinary third-party
 * embedding, where the browser withholds cross-origin isolation.
 */
export async function startStaticServer({ port, mounts }) {
  const server = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${port}`;
    const url = new URL(req.url ?? '/', base);
    const relative = decodeURIComponent(url.pathname);

    for (const mount of mounts) {
      if (mount.prefix && !relative.startsWith(mount.prefix)) continue;
      const stripped = (mount.prefix ? relative.slice(mount.prefix.length) : relative).replace(/^\/+/, '');
      const candidate = path.join(mount.dir, stripped || 'index.html');
      if (!candidate.startsWith(mount.dir)) continue;
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        const body = await readFile(candidate);
        const headers = {
          'Content-Type': MIME_TYPES[path.extname(candidate)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        };
        if (mount.isolated !== false) {
          // Cross-origin isolation: without these the threaded core cannot start.
          headers['Cross-Origin-Opener-Policy'] = 'same-origin';
          headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
        }
        headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
        res.writeHead(200, headers);
        res.end(body);
        return;
      } catch {
        /* try the next mount */
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return server;
}

/** Puppeteer launch flags that make the GPU-less CI environment work. */
export const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--mute-audio',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required',
];

/** Collects page errors and console errors so a test can assert on them. */
export function watchPage(page, options = {}) {
  const errors = [];
  const logs = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.log('[page error]', error.message);
  });
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') {
      // 404s for optional assets are reported, but only as logs: the app is
      // expected to work without a service worker or a manifest in some setups.
      errors.push(text);
      console.log('[console error]', text);
    } else if (options.verbose || text.includes('[BrowserGBA]')) {
      logs.push(text);
      console.log('[console]', text);
    }
  });
  return { errors, logs };
}

/** Clicks the first button whose accessible text matches exactly. */
export async function clickButton(page, text, root = 'body') {
  const handle = await page.waitForFunction(
    (label, scope) => {
      const buttons = [...document.querySelectorAll(`${scope} button`)];
      return buttons.find((button) => button.textContent?.trim() === label) ?? null;
    },
    { timeout: 15000, polling: 100 },
    text,
    root,
  );
  await handle.asElement().click();
}

/**
 * Returns an element handle, waiting for the view to finish rendering.
 *
 * Views are rendered asynchronously (the library re-reads IndexedDB on every
 * navigation), so `page.$` right after changing the route can legitimately return
 * `null`. Polling here removes a whole class of flaky failures.
 */
export async function waitForElement(page, selector, { timeout = 20000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const handle = await page.$(selector).catch(() => null);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Like `waitForElement`, but throws instead of returning `null`. */
export async function requireElement(page, selector, description = selector) {
  const handle = await waitForElement(page, selector);
  if (!handle) throw new Error(`the page never rendered ${description}`);
  return handle;
}

/**
 * Closes any toasts that are on screen.
 *
 * Toasts sit in a fixed region at the bottom right and accept pointer events, so one
 * left over from an earlier step can sit on top of the button the next step wants to
 * press — a real click then lands on the toast and quietly does nothing.
 */
export async function dismissToasts(page) {
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('.toast .toast-close')) {
      button.click();
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0, { timeout: 5000 });
}

/**
 * Clicks a button inside the `.card` whose `<h2>` matches `heading`.
 *
 * The game screen has several lists that each end in their own action buttons
 * ("Save states", "Battery saves", …), so "the Export button" is ambiguous by
 * text alone; naming the card keeps the test honest about which one it presses.
 */
export async function clickButtonInCard(page, heading, text) {
  const handle = await page.waitForFunction(
    (headingText, label) => {
      const card = [...document.querySelectorAll('.card')].find(
        (node) => node.querySelector('h2')?.textContent?.trim() === headingText,
      );
      const buttons = [...(card?.querySelectorAll('button') ?? [])];
      return buttons.find((button) => button.textContent?.trim() === label) ?? null;
    },
    { timeout: 15000, polling: 100 },
    heading,
    text,
  );
  await handle.asElement().click();
}

// --- page-side helpers (executed inside the browser) -----------------------

/**
 * Reads records out of the app's IndexedDB from the page.
 *
 * The store names are duplicated here on purpose: a test that imported the
 * app's own constants could not notice a rename that breaks existing users.
 */
export const readIndexedDb = async (page, store, limit = 50) =>
  page.evaluate(
    async (storeName, max) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('browsergba');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            reject(new Error(`store ${storeName} does not exist`));
            return;
          }
          const tx = db.transaction(storeName, 'readonly');
          const all = tx.objectStore(storeName).getAll();
          all.onsuccess = () => {
            const rows = all.result.slice(0, max);
            db.close();
            resolve(
              rows.map((row) => {
                // Blobs and ArrayBuffers cannot cross the CDP boundary, so they
                // are summarised; tests that need the bytes decode them in-page.
                const copy = {};
                for (const [key, value] of Object.entries(row)) {
                  if (value instanceof ArrayBuffer) copy[key] = { __type: 'ArrayBuffer', size: value.byteLength };
                  else if (value instanceof Blob) copy[key] = { __type: 'Blob', size: value.size, mime: value.type };
                  else copy[key] = value;
                }
                return copy;
              }),
            );
          };
          all.onerror = () => reject(all.error);
        };
      }),
    store,
    limit,
  );

/**
 * Decodes the newest stored screenshot inside the page and returns summary
 * information about its pixels.
 *
 * Screenshots are written by the emulator from its own framebuffer, so this is
 * the honest way to observe what the game actually rendered — reading the
 * canvas is not reliable because the core runs WebGL without
 * `preserveDrawingBuffer`.
 */
export const analyseStoredScreenshot = async (page, gameId = null) =>
  page.evaluate(
    async (id) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('browsergba');
        open.onerror = () => reject(open.error);
        open.onsuccess = async () => {
          const db = open.result;
          try {
            const rows = await new Promise((res, rej) => {
              const tx = db.transaction('screenshots', 'readonly');
              const all = tx.objectStore('screenshots').getAll();
              all.onsuccess = () => res(all.result);
              all.onerror = () => rej(all.error);
            });
            const candidates = id ? rows.filter((row) => row.gameId === id) : rows;
            candidates.sort((a, b) => b.createdAt - a.createdAt);
            const newest = candidates[0];
            if (!newest) {
              resolve(null);
              return;
            }
            const bitmap = await createImageBitmap(newest.blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0);
            const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            const data = image.data;
            const pixel = (x, y) => {
              const i = (y * bitmap.width + x) * 4;
              return [data[i], data[i + 1], data[i + 2]];
            };
            const rgb15 = (x, y) => {
              const [r, g, b] = pixel(x, y);
              return ((r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10)) & 0x7fff;
            };
            // The fixture ROM paints pixel(i) = i & 0x7fff over the whole screen,
            // except two deliberate probes: (0,0) carries a per-frame blue counter
            // (the "the loop is still running" probe) and (239,159) is the input
            // marker (the "a button reached the game" probe). The ramp must
            // therefore be sampled away from those two, or the check would reject
            // the very probes the rest of this test depends on.
            const samples = [];
            for (const [x, y] of [
              [1, 0],
              [17, 5],
              [120, 80],
              [238, 159],
              [239, 158],
            ]) {
              samples.push({ x, y, rgb: pixel(x, y), value: rgb15(x, y), expected: (y * 240 + x) & 0x7fff });
            }
            const rampOk = samples.every((sample) => sample.value === sample.expected);
            // The counter is written as a halfword into the blue channel only, so
            // any other bit set here means a store spilled into the next pixel.
            const animValue = rgb15(0, 0);
            // The fixture copies cartridge SRAM[0] (0xA5, written at boot) into the
            // green channel of (238,0), so this reads the emulated cart's save memory.
            const sramMarker = rgb15(238, 0) >> 5;
            resolve({
              width: bitmap.width,
              height: bitmap.height,
              createdAt: newest.createdAt,
              gameId: newest.gameId,
              samples,
              rampOk,
              animValue,
              animOk: (animValue & 0x3ff) === 0,
              sramMarker,
              markerTopLeft: rgb15(239, 159),
              markerNeighbourLeft: rgb15(238, 159),
              markerNeighbourUp: rgb15(239, 158),
            });
          } catch (error) {
            reject(error);
          } finally {
            db.close();
          }
        };
      }),
    gameId,
  );

/**
 * Reads a byte from the newest stored battery save for a game. The fixture ROM
 * writes its frame counter to SRAM[0], so this byte advancing proves the
 * emulated CPU kept running between two reads.
 */
export const readSaveByte = async (page, gameId, offset = 0) =>
  page.evaluate(
    async ([id, index]) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('browsergba');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const tx = db.transaction('batterySaves', 'readonly');
            const all = tx.objectStore('batterySaves').getAll();
            all.onsuccess = () => {
              const rows = all.result.filter((row) => row.gameId === id).sort((a, b) => b.savedAt - a.savedAt);
              const newest = rows[0];
              if (!newest) {
                resolve(null);
                return;
              }
              const bytes = new Uint8Array(newest.bytes);
              resolve({ byte: bytes[index], size: bytes.length, savedAt: newest.savedAt });
            };
            all.onerror = () => reject(all.error);
          } finally {
            db.close();
          }
        };
      }),
    [gameId, offset],
  );

/** Counts records per store, for assertions about persistence. */
export const countStore = async (page, store) =>
  page.evaluate(
    async (storeName) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('browsergba');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction(storeName, 'readonly');
          const count = tx.objectStore(storeName).count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
      }),
    store,
  );

/**
 * Polls a store from Node until it holds at least `min` records.
 *
 * Polling from Node rather than with `page.waitForFunction` keeps the wait
 * explicit and debuggable: this code is the test harness, so a failure should
 * point at the assertion, not at a serialized in-page promise.
 */
export async function waitForCount(page, store, min, { timeout = 25000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let count = await countStore(page, store).catch(() => 0);
  while (count < min && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    count = await countStore(page, store).catch(() => 0);
  }
  return count;
}

/** Polls the stored settings object until `predicate` accepts it. */
export async function waitForSettings(page, predicate, { timeout = 20000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const rows = await readIndexedDb(page, 'settings');
    const value = rows.find((row) => row.key === 'app')?.value;
    if (value !== undefined && predicate(value)) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export function logChecks(script, checks) {
  console.log(`\n[${script}] checks:`);
  let failure = null;
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
    // Failing checks carry the measured value as an optional third element; showing
    // it here is what makes a failure diagnosable from CI output alone.
    if (!pass && detail !== undefined) console.log(`        ${String(detail).slice(0, 400)}`);
    if (!pass && !failure) failure = label;
  }
  return failure;
}
