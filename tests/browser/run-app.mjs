#!/usr/bin/env node
/**
 * End-to-end app test.
 *
 * Everything else in this repository tests a module. This script tests the
 * product: it builds the real app, serves it the way a static host must (with
 * cross-origin isolation headers), and drives it in a real browser the way a
 * person would — importing a ROM through the file picker, playing it, saving
 * progress, taking a screenshot, remapping a key, and checking that the
 * emulator really rendered the pixels.
 *
 * The ROM is the original homebrew fixture from `tools/make-test-rom.mjs`; no
 * commercial game is ever used, here or in CI.
 *
 *   BROWSERGBA_CHROMIUM=/path/to/chrome npm run test:e2e
 *
 * Requirements: the app is built by this script (`vite build`), so the first run
 * takes a few seconds longer.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  analyseStoredScreenshot,
  clickButton,
  countStore,
  clickButtonInCard,
  dismissToasts,
  requireElement,
  waitForElement,
  logChecks,
  readSaveByte,
  readIndexedDb,
  repoRoot,
  launchBrowser,
  skipMessage,
  startStaticServer,
  waitForCount,
  waitForSettings,
  watchPage,
} from './harness.mjs';

const SCRIPT = 'test:e2e';
const PORT = Number(process.env.BROWSERGBA_E2E_PORT ?? 4320);
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * A second origin serving the same build with no isolation headers, which is all
 * GitHub Pages can do (it cannot send response headers at all).
 *
 * A separate *origin* is required, not just a separate path: a service worker
 * registered for one path on an origin also answers for its subpaths, so a same-origin
 * copy would arrive already isolated and the cold path below would go untested.
 * Different ports share no worker and no database.
 */
const PLAIN_PORT = Number(process.env.BROWSERGBA_E2E_PLAIN_PORT ?? PORT + 1);
const PLAIN_BASE = `http://127.0.0.1:${PLAIN_PORT}`;
/**
 * A third origin for the embedding probe, so the frame really is cross-origin and its
 * parent really is a site that cannot send isolation headers. It carries only the
 * probe page: the app it frames lives on `BASE`.
 */
const EMBED_PORT = Number(process.env.BROWSERGBA_E2E_EMBED_PORT ?? PORT + 2);
/**
 * The deployment shape GitHub Pages produces for a project site: the built app one
 * directory down (`/BrowserGBA/`) on a host that cannot send response headers. Both
 * halves matter — asset URLs and the service-worker scope have to survive the
 * sub-path, and the isolation repair has to cope with the missing headers — so it
 * gets its own origin rather than riding on the other header-less one.
 */
const SUBPATH_PORT = Number(process.env.BROWSERGBA_E2E_SUBPATH_PORT ?? PORT + 3);
const EMBED_BASE = `http://127.0.0.1:${EMBED_PORT}`;
const SUBPATH_BASE = `http://127.0.0.1:${SUBPATH_PORT}`;
/**
 * A header-less origin that is guaranteed cold — no worker has ever been registered
 * for it — used to check what a user sees when the automatic repair has already been
 * spent. (Trying to reuse the other header-less origin for this does not work: tearing
 * a worker down and navigating immediately races with the browser's own teardown, and
 * the next load can still arrive isolated.)
 */
const MANUAL_PORT = Number(process.env.BROWSERGBA_E2E_MANUAL_PORT ?? PORT + 4);
const MANUAL_BASE = `http://127.0.0.1:${MANUAL_PORT}`;
const ARTIFACTS = path.join(repoRoot, 'tests', 'browser', 'artifacts');

async function buildApp() {
  console.log(`[${SCRIPT}] building the app…`);
  const result = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('the app failed to build');
}

async function ensureFixtureRom() {
  const romPath = path.join(repoRoot, 'fixtures', 'test-rom.gba');
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'make-test-rom.mjs')], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('failed to generate the fixture ROM');
  return romPath;
}

/** Writes a second, distinguishable fixture ROM so cheat scoping can be tested. */
/**
 * Writes a small valid PNG to upload as cover art.
 *
 * Generated rather than committed: the repository ships no artwork, and a test image
 * built from scratch cannot carry anyone's copyright.
 */
/**
 * Types a value into an input the way a user would.
 *
 * The editor keeps its own state in `input` listeners, so assigning `.value` alone is
 * not enough — the events have to fire.
 */
async function typeInto(scope, selector, value) {
  const handle = await scope.$(selector);
  if (!handle) throw new Error(`no input matched ${selector}`);
  await handle.evaluate((node, next) => {
    node.value = next;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/**
 * Records what the app hands to the browser as a download.
 *
 * `URL.createObjectURL` + a `<a download>` click is the whole export mechanism, and
 * both are ordinary Web APIs: capturing them from inside the page tests the real
 * path without any browser-protocol download plumbing, which keeps the check
 * engine-neutral (Chromium's CDP download APIs do not exist in Firefox).
 */
async function captureDownloads(page) {
  await page.evaluate(() => {
    const state = { downloads: [] };
    globalThis.__bgbaDownloads = state;
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = realCreate(blob);
      state.downloads.push({ url, blob, size: blob.size, type: blob.type, name: '' });
      return url;
    };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedClick(...args) {
      if (this.download) {
        const last = state.downloads[state.downloads.length - 1];
        if (last) last.name = this.download;
      }
      return realClick.apply(this, args);
    };
  });
}

/** The last captured download as `{ name, size, head }` (plus `json`), or null. */
async function lastDownload(page) {
  return page.evaluate(async () => {
    const list = globalThis.__bgbaDownloads?.downloads ?? [];
    const last = list[list.length - 1];
    if (!last) return null;
    const bytes = new Uint8Array(await last.blob.arrayBuffer());
    let json = null;
    if (last.type.includes('json') || last.name.endsWith('.json')) {
      try {
        json = JSON.parse(await last.blob.text());
      } catch {
        json = null;
      }
    }
    return { name: last.name, size: last.size, type: last.type, head: Array.from(bytes.slice(0, 4)), json };
  });
}

async function ensureCoverImage() {
  const outPath = path.join(ARTIFACTS, 'cover.png');
  const script = `
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const width = 48;
const height = 32;
const raw = Buffer.alloc(height * (1 + width * 4));
for (let y = 0; y < height; y += 1) {
  const rowStart = y * (1 + width * 4);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < width; x += 1) {
    const i = rowStart + 1 + x * 4;
    raw[i] = (x * 5) & 0xff;
    raw[i + 1] = (y * 8) & 0xff;
    raw[i + 2] = 0x40;
    raw[i + 3] = 0xff;
  }
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // truecolour + alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2], png);
console.log('wrote', process.argv[2], png.length, 'bytes');
`;
  const temp = path.join(ARTIFACTS, 'make-cover.mjs');
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(temp, script, 'utf8');
  const result = spawnSync(process.execPath, [temp, outPath], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('failed to generate the cover image');
  return outPath;
}

async function ensureSecondRom() {
  const outPath = path.join(repoRoot, 'fixtures', 'alt-rom.gba');
  const script = `
    import { buildRom } from ${JSON.stringify(path.join(repoRoot, 'tools', 'make-test-rom.mjs'))};
    import { writeFile } from 'node:fs/promises';
    const rom = buildRom({ title: 'BGALTROM', gameCode: 'BGA1' });
    await writeFile(${JSON.stringify(outPath)}, rom);
    console.log('wrote', ${JSON.stringify(outPath)}, rom.length);
  `;
  const temp = path.join(repoRoot, 'tests', 'browser', 'artifacts', 'make-alt-rom.mjs');
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(temp, script, 'utf8');
  const result = spawnSync(process.execPath, [temp], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('failed to generate the second fixture ROM');
  return outPath;
}

async function main() {
  // Chromium by default; set BROWSERGBA_FIREFOX to run the whole suite in Gecko.
  const launched = await launchBrowser();
  if (!launched) {
    skipMessage(SCRIPT);
    return;
  }
  const { browser, engine, engineLabel } = launched;
  console.log(`[${SCRIPT}] running the suite in ${engineLabel}`);

  await buildApp();
  const romPath = await ensureFixtureRom();
  const altRomPath = await ensureSecondRom();
  const coverPath = await ensureCoverImage();

  const server = await startStaticServer({
    port: PORT,
    mounts: [
      // The embedding probe is deliberately served WITHOUT COOP/COEP: that is how
      // ordinary third-party sites are delivered, and it is what makes a frame
      // non-isolated. Everything else gets the isolation headers.
      { prefix: '/plain/', dir: path.join(repoRoot, 'tests', 'browser', 'plain'), isolated: false },
      { prefix: '/tests/', dir: path.join(repoRoot, 'tests') },
      { prefix: '/fixtures/', dir: path.join(repoRoot, 'fixtures') },
      // The development shell, exactly as it sits in the repository: an entry module
      // the browser cannot run plus assets that were never built. This is what a
      // static host publishes when it serves the branch instead of the build, and the
      // app is expected to say so rather than showing an empty page.
      { prefix: '/devshell/', dir: repoRoot, isolated: false },
      { prefix: '', dir: path.join(repoRoot, 'dist') },
    ],
  });

  const plainServer = await startStaticServer({
    port: PLAIN_PORT,
    mounts: [
      { prefix: '/fixtures/', dir: path.join(repoRoot, 'fixtures'), isolated: false },
      { prefix: '', dir: path.join(repoRoot, 'dist'), isolated: false },
    ],
  });

  const subpathServer = await startStaticServer({
    port: SUBPATH_PORT,
    mounts: [
      { prefix: '/fixtures/', dir: path.join(repoRoot, 'fixtures'), isolated: false },
      { prefix: '/BrowserGBA/', dir: path.join(repoRoot, 'dist'), isolated: false },
    ],
  });

  const manualServer = await startStaticServer({
    port: MANUAL_PORT,
    mounts: [
      { prefix: '/fixtures/', dir: path.join(repoRoot, 'fixtures'), isolated: false },
      { prefix: '', dir: path.join(repoRoot, 'dist'), isolated: false },
    ],
  });

  const embedServer = await startStaticServer({
    port: EMBED_PORT,
    mounts: [{ prefix: '', dir: path.join(repoRoot, 'tests', 'browser', 'plain'), isolated: false }],
  });

  const checks = [];
  const consoleErrors = [];

  try {
    const page = await browser.newPage();
    // `deviceScaleFactor` is a Chromium-only knob; Gecko reports its own ratio, and
    // the geometry checks compare CSS pixels, so they hold either way.
    await page.setViewport({
      width: 1280,
      height: 900,
      ...(engine === 'chromium' ? { deviceScaleFactor: 1 } : {}),
    });
    const watcher = watchPage(page);
    consoleErrors.push(...watcher.errors);
    // App log lines, for checks like "the app said what it was doing".


    await captureDownloads(page);

    // --- the app loads ----------------------------------------------------

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.app-header .brand', { timeout: 30000 });
    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
    checks.push(['the page is cross-origin isolated (core can run)', isolated === true]);

    await page.waitForSelector('.view-header h1', { timeout: 15000 });
    const emptyState = await page.$eval('.empty-state h2', (node) => node.textContent?.trim());
    checks.push(['an empty library explains what to do', emptyState === 'Your library is empty']);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-01-library-empty.png') });

    // --- importing through the real file input ----------------------------

    const fileInput = await requireElement(page, '#rom-file-input', 'the ROM file input');
    await fileInput.uploadFile(romPath);
    await page.waitForSelector('.game-card', { timeout: 30000 });

    const importedTitle = await page.$eval('.game-card .game-title', (node) => node.textContent?.trim());
    checks.push(['the imported ROM appears with its header title', importedTitle === 'BGTESTROM']);

    const games = await readIndexedDb(page, 'games');
    checks.push(['the game record stores the content hash', typeof games[0]?.contentHash === 'string' && games[0].contentHash.length === 64]);
    checks.push(['the ROM bytes are stored as a record, not in localStorage', await countStore(page, 'roms') === 1]);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-02-library-one-game.png') });

    // A second, different ROM: used later to prove cheats stay scoped per game.
    const input2 = await requireElement(page, '#rom-file-input', 'the ROM file input');
    await input2.uploadFile(altRomPath);
    await page.waitForFunction(() => document.querySelectorAll('.game-card').length === 2, { timeout: 30000 });
    checks.push(['a second, different ROM is a separate library entry', (await countStore(page, 'games')) === 2]);

    // --- playing ----------------------------------------------------------

    const cards = await page.$$('.game-card');
    let targetCard = null;
    for (const card of cards) {
      const title = await card.$eval('.game-title', (node) => node.textContent?.trim());
      if (title === 'BGTESTROM') targetCard = card;
    }
    const playButton = await targetCard.$('button.btn-primary');
    await playButton.click();

    await page.waitForSelector('.screen-frame canvas', { timeout: 30000 });
    // Give the core a moment to boot the ROM and render frames.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const playerInfo = await page.evaluate(() => ({
      canvasWidth: document.querySelector('.screen-frame canvas')?.width,
      canvasHeight: document.querySelector('.screen-frame canvas')?.height,
      frameWidth: document.querySelector('.screen-frame')?.getBoundingClientRect().width,
      scale: window.devicePixelRatio,
      hasTouch: document.querySelector('.touch-controls')?.getAttribute('data-enabled'),
      controls: [...document.querySelectorAll('.control-strip button')].map((button) => button.textContent?.trim()),
    }));
    checks.push(['the canvas keeps the native 240x160 backing store', playerInfo.canvasWidth === 240 && playerInfo.canvasHeight === 160]);
    checks.push(['the frame is scaled to a whole number of device pixels', Number.isInteger(playerInfo.frameWidth)]);

    // --- rendering: the emulator is really drawing -------------------------

    await clickButton(page, 'Screenshot', '.control-strip');
    await waitForCount(page, 'screenshots', 1);

    const shot = await analyseStoredScreenshot(page);
    checks.push(['a screenshot is captured at native resolution', shot?.width === 240 && shot?.height === 160]);
    checks.push([
      'every sampled pixel matches the fixture ROM’s deterministic ramp',
      shot?.rampOk === true,
      JSON.stringify(shot?.samples),
    ]);
    checks.push(['the A button marker is clear while no button is held', shot?.markerTopLeft === 0]);
    checks.push([
      'the per-frame counter advances inside one channel only',
      shot?.animOk === true,
      JSON.stringify({ animValue: shot?.animValue }),
    ]);
    checks.push([
      'the cartridge save memory holds what the game wrote',
      shot?.sramMarker === 0xa5,
      JSON.stringify({ sramMarker: shot?.sramMarker, expected: 0xa5 }),
    ]);

    // Liveness: the fixture advances its counter every frame, so a few consecutive
    // captures must not all show the same value.
    const counters = [shot?.animValue];
    for (let i = 0; i < 3; i += 1) {
      const before = await countStore(page, 'screenshots');
      await new Promise((resolve) => setTimeout(resolve, 350));
      await clickButton(page, 'Screenshot', '.control-strip');
      await waitForCount(page, 'screenshots', before + 1);
      counters.push((await analyseStoredScreenshot(page))?.animValue);
    }
    checks.push([
      'the emulated CPU keeps running (counter changes between captures)',
      new Set(counters).size > 1,
      JSON.stringify(counters),
    ]);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-03-player.png') });

    // --- input reaches the game -------------------------------------------

    const shotsBeforeHeld = await countStore(page, 'screenshots');
    await page.keyboard.down('KeyX'); // default binding for A
    await new Promise((resolve) => setTimeout(resolve, 400));
    await clickButton(page, 'Screenshot', '.control-strip');
    await waitForCount(page, 'screenshots', shotsBeforeHeld + 1);
    await page.keyboard.up('KeyX');

    const heldShot = await analyseStoredScreenshot(page);
    checks.push(['holding A paints the input marker at the bottom-right pixel', heldShot?.markerTopLeft === 0x1f]);
    // The neighbours must still hold the ramp: a 32-bit store into that pixel
    // would clobber the pixel next to it, which is exactly what this catches.
    checks.push([
      'the marker does not bleed into neighbouring pixels',
      heldShot?.markerNeighbourLeft === ((159 * 240 + 238) & 0x7fff) &&
        heldShot?.markerNeighbourUp === ((158 * 240 + 239) & 0x7fff),
      JSON.stringify({
        left: heldShot?.markerNeighbourLeft,
        expectedLeft: (159 * 240 + 238) & 0x7fff,
        up: heldShot?.markerNeighbourUp,
        expectedUp: (158 * 240 + 239) & 0x7fff,
      }),
    ]);

    // --- progress is persisted -------------------------------------------

    await clickButton(page, 'Save file', '.control-strip');
    await waitForCount(page, 'batterySaves', 1);

    const saves = await readIndexedDb(page, 'batterySaves');
    checks.push(['the battery save is stored with its real size (32 KiB SRAM)', saves[0]?.size === 32768]);
    checks.push(['the save belongs to the game that produced it', saves[0]?.gameId === games[0]?.id]);

    // What the core exported must contain what the game wrote: the fixture puts
    // 0xA5 in SRAM[0] at boot (once — the core only flushes a save once its data
    // settles). Anything else means the app persisted a zero placeholder.
    const exported = await readSaveByte(page, games[0].id, 0);
    checks.push([
      'the exported battery save contains the cartridge data',
      exported?.size === 32768 && exported.byte === 0xa5,
      JSON.stringify(exported),
    ]);

    // Save state via the default keyboard shortcut, then load it back.
    //
    // The defaults are F2/F4 on purpose: F5 is "reload" and F9 is Reader View in
    // Firefox, and no page can cancel either, so a shortcut on those keys would
    // never reach the emulator. See RESERVED_CODES in src/input/bindings.ts.
    await page.keyboard.press('F2');
    await waitForCount(page, 'saveStates', 1);
    const states = await readIndexedDb(page, 'saveStates');
    checks.push(['quick save writes a state with a ROM hash and core version', Boolean(states[0]?.romHash) && Boolean(states[0]?.coreVersion)]);
    checks.push(['the state stores a thumbnail for the library UI', states[0]?.thumbnail?.__type === 'Blob']);
    await page.keyboard.press('F4');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const stillPlaying = await page.$('.screen-frame canvas');
    checks.push(['loading a state does not tear the session down', stillPlaying !== null]);

    const quickSaveTip = await page.$$eval('.control-strip button', (nodes) =>
      nodes.map((node) => node.getAttribute('title') ?? '').find((title) => title.startsWith('Quick save state')) ?? '',
    );
    checks.push(['the quick-save button advertises the key that is actually bound', quickSaveTip === 'Quick save state (F2)', quickSaveTip]);

    // --- fast-forward hold ------------------------------------------------

    await page.keyboard.down('Space');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fastForwarded = await page.$eval('.speed-indicator', (node) => node.getAttribute('data-active'));
    await page.keyboard.up('Space');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const backToNormal = await page.$eval('.speed-indicator', (node) => node.textContent?.trim());
    checks.push(['holding fast-forward reports an active speed', fastForwarded === 'true']);
    checks.push(['releasing fast-forward returns to 100%', backToNormal === '100%']);

    // --- cheats are scoped to one game ------------------------------------

    await page.goto(`${BASE}/#/game/${encodeURIComponent(games[0].id)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.view-game', { timeout: 20000 });
    await clickButton(page, 'Add cheat', '.view-game');

    const dialogShown = await page.waitForSelector('dialog.dialog[open]', { timeout: 10000 });
    checks.push(['the cheat editor opens', dialogShown !== null]);

    // A code that does not match the selected format must be refused.
    await page.type('dialog.dialog input[type="text"]', 'Broken code');
    await page.type('dialog.dialog textarea', 'not a real code');
    await clickButton(page, 'Save cheat', 'dialog.dialog');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const validationMessage = await page.$eval('dialog.dialog .field-error', (node) => node.textContent?.trim()).catch(() => '');
    checks.push(['an invalid cheat code is rejected in the editor', Boolean(validationMessage)]);

    // Now a valid one, for the first game only.
    await page.$eval('dialog.dialog textarea', (node) => {
      node.value = '';
    });
    await page.type('dialog.dialog textarea', '82025BC4 000F423F');
    await clickButton(page, 'Save cheat', 'dialog.dialog');
    await waitForCount(page, 'cheats', 1);

    const cheats = await readIndexedDb(page, 'cheats');
    checks.push(['the cheat is stored against its own game only', cheats.length === 1 && cheats[0].gameId === games[0].id]);
    checks.push(['the cheat keeps the format it was entered in', cheats[0]?.format === 'gameShark']);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-04-game-detail.png') });

    // Playing the other game must not write the first game's cheat file.
    const otherGame = (await readIndexedDb(page, 'games')).find((row) => row.id !== games[0]?.id);
    await page.goto(`${BASE}/#/play/${encodeURIComponent(otherGame.id)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.screen-frame canvas', { timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await clickButton(page, 'Screenshot', '.control-strip');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const otherShot = await analyseStoredScreenshot(page, otherGame.id);
    checks.push(['the other game runs and renders its own frames', otherShot?.rampOk === true]);
    checks.push(['the other game has no cheats of its own', (await readIndexedDb(page, 'cheats')).length === 1]);

    // --- key remapping ----------------------------------------------------

    await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.view-settings', { timeout: 20000 });

    const aKey = await page.waitForSelector('button.key-button[aria-label="Change the key for A"]', { timeout: 10000 });
    await aKey.click();
    await page.keyboard.press('KeyQ');
    const storedKeyboard = await waitForSettings(page, (value) => value.keyboard?.A === 'KeyQ');
    checks.push(['remapping A to Q is persisted', true]);

    // The remapped key must actually reach the game.
    await page.goto(`${BASE}/#/play/${encodeURIComponent(games[0].id)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.screen-frame canvas', { timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const shotsBefore = await countStore(page, 'screenshots');
    await page.keyboard.down('KeyQ');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await clickButton(page, 'Screenshot', '.control-strip');
    await waitForCount(page, 'screenshots', shotsBefore + 1);
    await page.keyboard.up('KeyQ');
    const remappedShot = await analyseStoredScreenshot(page, games[0].id);
    checks.push(['the remapped key presses A in the game', remappedShot?.markerTopLeft === 0x1f]);

    // --- leaving the player stops the session -----------------------------

    await page.evaluate(() => {
      window.location.hash = '#/library';
    });
    await page.waitForSelector('.library-grid, .library-list, .empty-state', { timeout: 20000 });
    const playingFlag = await page.evaluate(() => document.body.hasAttribute('data-playing'));
    checks.push(['navigating away from the player releases the session', playingFlag === false]);

    // --- duplicate imports are reviewed, not silently merged ----------------

    const gamesBeforeDuplicate = await countStore(page, 'games');
    await (await requireElement(page, '#rom-file-input', 'the ROM file input')).uploadFile(romPath);
    await page.waitForSelector('dialog.dialog[open]', { timeout: 20000 });
    const duplicateTitle = await page.$eval('dialog.dialog h2', (node) => node.textContent?.trim());
    await clickButton(page, 'Cancel import', 'dialog.dialog');
    await new Promise((resolve) => setTimeout(resolve, 500));
    checks.push([
      'importing the same file again asks instead of duplicating it',
      duplicateTitle === 'This ROM is already in your library' &&
        (await countStore(page, 'games')) === gamesBeforeDuplicate,
      duplicateTitle,
    ]);

    // --- editing name, cover and links from a library card ----------------

    const cardPencil = await waitForElement(page, '.game-card .btn-icon[aria-label^="Edit"]');
    checks.push(['each game card offers an edit control', cardPencil !== null]);
    await clickButton(page, '✏', '.game-card');
    await page.waitForSelector('dialog.dialog[open]', { timeout: 10000 });

    await typeInto(page, '#edit-game-title', 'My Renamed Game');
    // A pasted link of a kind a "helpful" validator would reject, plus an ordinary one.
    await clickButton(page, 'Add link', 'dialog.dialog');
    await typeInto(page, '.link-editor .link-row:nth-of-type(1) input:nth-of-type(1)', 'Steam shortcut');
    await typeInto(page, '.link-editor .link-row:nth-of-type(1) input:nth-of-type(2)', 'steam://run/12345');
    await clickButton(page, 'Add link', 'dialog.dialog');
    await typeInto(page, '.link-editor .link-row:nth-of-type(2) input:nth-of-type(1)', 'Project page');
    await typeInto(page, '.link-editor .link-row:nth-of-type(2) input:nth-of-type(2)', 'example.com/whatever?x=1');
    // A URL that would run code rather than open a page: kept, but never a live link.
    await clickButton(page, 'Add link', 'dialog.dialog');
    await typeInto(page, '.link-editor .link-row:nth-of-type(3) input:nth-of-type(1)', 'Sneaky');
    await typeInto(page, '.link-editor .link-row:nth-of-type(3) input:nth-of-type(2)', 'javascript:alert(1)');
    await (await requireElement(page, '#edit-game-cover', 'the cover picker')).uploadFile(coverPath);
    await clickButton(page, 'Save changes', 'dialog.dialog');
    await new Promise((resolve) => setTimeout(resolve, 800));

    const edited = (await readIndexedDb(page, 'games')).find((row) => row.id === games[0].id);
    checks.push(['renaming a game is stored', edited?.customTitle === 'My Renamed Game']);
    checks.push([
      'the card shows the new name',
      (await page.$eval('.game-card .game-title', (node) => node.textContent?.trim())) === 'My Renamed Game',
    ]);
    checks.push([
      'links are stored exactly as pasted, including unusual schemes',
      edited?.links?.[0]?.url === 'steam://run/12345' &&
        edited?.links?.[1]?.url === 'https://example.com/whatever?x=1' &&
        edited?.links?.[2]?.url === 'javascript:alert(1)',
      JSON.stringify(edited?.links),
    ]);
    checks.push(['the cover image is stored with the game', (await countStore(page, 'covers')) === 1]);
    checks.push([
      'the card renders the new cover',
      (await page.$('.game-card .game-art img')) !== null,
    ]);

    // The links are shown on the game screen, and the unsafe-scheme one is text only.
    await page.goto(`${BASE}/#/game/${encodeURIComponent(games[0].id)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.view-game', { timeout: 20000 });
    const linkState = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('.link-list a')].map((node) => node.getAttribute('href'));
      const text = document.querySelector('.link-list')?.textContent ?? '';
      return {
        anchors,
        mentionsSteam: text.includes('steam://run/12345'),
        mentionsProject: text.includes('example.com'),
        mentionsCodeUrl: text.includes('javascript:alert(1)'),
      };
    });
    checks.push([
      'a link with an unusual scheme is offered as a link, not policed',
      linkState.anchors.includes('steam://run/12345'),
      JSON.stringify(linkState.anchors),
    ]);
    checks.push([
      'a URL that would run code is shown as text, never as a live link',
      linkState.mentionsCodeUrl && !linkState.anchors.some((href) => href?.startsWith('javascript:')),
      JSON.stringify(linkState),
    ]);
    checks.push([
      'an ordinary link is rendered as a link',
      linkState.anchors.includes('https://example.com/whatever?x=1'),
      JSON.stringify(linkState.anchors),
    ]);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-07-game-links.png') });

    // Export the battery save: a real file must come out of the browser, named after
    // the game and carrying the cartridge's own bytes. Downloads are captured inside
    // the page rather than through browser-protocol APIs, which is what keeps this
    // check portable across engines.
    await dismissToasts(page);
    await captureDownloads(page);
    // A real mouse click — this is the exact path a user takes, not a synthetic
    // `button.click()` from script.
    await clickButtonInCard(page, 'Battery saves', 'Export');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const exportedFile = await lastDownload(page);
    checks.push([
      'exporting a battery save hands the browser a real 32 KiB .sav file',
      exportedFile?.name.endsWith('.sav') === true && exportedFile?.size === 32768,
      JSON.stringify(exportedFile),
    ]);
    checks.push([
      'the exported file carries the cartridge data, not a blank shim',
      exportedFile?.head?.[0] === 0xa5,
      JSON.stringify(exportedFile?.head),
    ]);

    // The whole-library backup is the promise that a user can leave with their data,
    // so it has to be a real file that really contains the saves — and no ROM bytes.
    await page.goto(`${BASE}/#/storage`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.view-storage', { timeout: 20000 });
    await dismissToasts(page);
    await captureDownloads(page);
    await clickButton(page, 'Export whole library', '.view-storage');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const backupFile = await lastDownload(page);
    const backupGames = Array.isArray(backupFile?.json?.games) ? backupFile.json.games : [];
    checks.push([
      'the whole-library backup is a real JSON file that names its own format',
      backupFile?.name.endsWith('.json') === true && backupFile?.json?.format === 'browsergba.library',
      JSON.stringify({ name: backupFile?.name, format: backupFile?.json?.format }),
    ]);
    checks.push([
      'the backup carries the game, its battery save and its save state',
      backupGames.length === 2 &&
        backupGames.some((bundle) => (bundle.saves ?? []).length > 0) &&
        backupGames.some((bundle) => (bundle.states ?? []).length > 0),
      JSON.stringify(
        backupGames.map((bundle) => ({
          game: bundle.game?.title,
          saves: bundle.saves?.length,
          states: bundle.states?.length,
        })),
      ),
    ]);
    checks.push([
      'the backup contains no ROM image',
      !('roms' in (backupFile?.json ?? {})) &&
        Object.keys(backupGames[0]?.game ?? {}).every((key) => !/rom|bytes/i.test(key)) &&
        Object.keys(backupGames[0] ?? {}).every((key) => !/rom|bytes/i.test(key)),
      JSON.stringify({ top: Object.keys(backupFile?.json ?? {}), bundle: Object.keys(backupGames[0] ?? {}) }),
    ]);

    // --- offline shell ----------------------------------------------------

    // `getRegistration()` resolves even for a worker that never installs, so
    // this waits for it to reach `activated` *and* checks that it really stored
    // something — a worker that throws on evaluation passes a laxer test.
    const swState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return { registered: false };
      const ready = await Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
      ]);
      const keys = await caches.keys();
      const precache = keys.find((key) => key.startsWith('browsergba-') && !key.includes('runtime'));
      let entries = 0;
      if (precache) {
        const cache = await caches.open(precache);
        entries = (await cache.keys()).length;
      }
      return { registered: true, activated: ready && registration.active?.state === 'activated', keys, entries };
    });
    checks.push([
      'the service worker activates and precaches the shell',
      swState.activated === true && swState.entries > 0,
      JSON.stringify(swState),
    ]);

    // --- a host that cannot send headers (how GitHub Pages behaves) -------

    // First visit to such a host: the page cannot be isolated, the worker can fix that
    // for the *next* load, and the app spends that reload itself rather than showing a
    // notice and hoping the user reloads. Count the loads so a repair loop cannot hide
    // here — exactly two document loads, never more.
    const headerless = await browser.newPage();
    await headerless.setViewport({ width: 1100, height: 800 });
    const headerlessWatcher = watchPage(headerless);
    consoleErrors.push(...headerlessWatcher.errors);
    await headerless.evaluateOnNewDocument(() => {
      const loads = Number(sessionStorage.getItem('e2e.loads') ?? '0') + 1;
      sessionStorage.setItem('e2e.loads', String(loads));
    });
    await headerless.goto(`${PLAIN_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await headerless.waitForSelector('.app-header .brand', { timeout: 30000 });
    checks.push([
      'an app served without isolation headers starts un-isolated',
      (await headerless.evaluate(() => globalThis.crossOriginIsolated)) === false,
    ]);

    // No click, no button: the app is expected to make the next load isolated on its own.
    const selfRepaired = await headerless
      .waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 60000, polling: 250 })
      .then(() => true)
      .catch(() => false);
    checks.push([
      'the app repairs isolation by itself on a header-less host, without being asked',
      selfRepaired === true,
    ]);

    const loadCount = await headerless.evaluate(() => Number(sessionStorage.getItem('e2e.loads') ?? '0'));
    checks.push([
      'the automatic repair reloads exactly once and cannot loop',
      loadCount === 2,
      `document loads: ${loadCount}`,
    ]);
    checks.push([
      'the repair is announced, not a silent flicker',
      headerlessWatcher.logs.some((line) => /reloading once so the service worker/.test(line)),
      headerlessWatcher.logs.slice(-2).join(' | ').slice(0, 200),
    ]);

    // Importing is unaffected by isolation, so the library still works on such a host.
    await (await requireElement(headerless, '#rom-file-input', 'the ROM file input')).uploadFile(romPath);
    await headerless.waitForSelector('.game-card', { timeout: 30000 });
    await headerless.click('.game-card button.btn-primary');
    const repairedCanvas = await headerless
      .waitForSelector('.screen-frame canvas', { timeout: 60000 })
      .catch(() => null);
    checks.push(['the repaired page plays the game without any prompt', repairedCanvas !== null]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (repairedCanvas) {
      await clickButton(headerless, 'Screenshot', '.control-strip');
      await waitForCount(headerless, 'screenshots', (await countStore(headerless, 'screenshots')) + 1);
      const repairedShot = await analyseStoredScreenshot(headerless);
      checks.push([
        'the game really runs on a header-less host (frames match the fixture)',
        repairedShot?.rampOk === true && repairedShot?.sramMarker === 0xa5,
      ]);
      await headerless.screenshot({ path: path.join(ARTIFACTS, 'e2e-06-self-isolated.png') });
    }

    // The other half of the story, on its own cold origin: when the automatic attempt is
    // already spent, the app must stop and ask rather than reloading again — and the
    // retry has to be one click away. The flag is seeded before any app code runs, which
    // is exactly the state a second visit to a header-less host arrives in.
    const manual = await browser.newPage();
    await manual.setViewport({ width: 1100, height: 800 });
    const manualWatcher = watchPage(manual);
    consoleErrors.push(...manualWatcher.errors);
    await manual.evaluateOnNewDocument(() => {
      sessionStorage.setItem('browsergba.isolation-recovery', '1');
      const loads = Number(sessionStorage.getItem('e2e.manual-loads') ?? '0') + 1;
      sessionStorage.setItem('e2e.manual-loads', String(loads));
    });
    await manual.goto(`${MANUAL_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await manual.waitForSelector('.app-header .brand', { timeout: 30000 });
    await manual.waitForSelector('.toast', { timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const manualState = await manual.evaluate(() => {
      const toast = document.querySelector('.toast');
      return {
        title: toast?.querySelector('strong')?.textContent?.trim() ?? '',
        body: (toast?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        button: toast?.querySelector('button.btn')?.textContent?.trim() ?? null,
        isolated: globalThis.crossOriginIsolated === true,
        loads: Number(sessionStorage.getItem('e2e.manual-loads') ?? '0'),
      };
    });
    checks.push([
      'a tab that already spent its automatic attempt is told to reload instead of looping',
      manualState.isolated === false && manualState.button === 'Reload' && manualState.loads === 1,
      JSON.stringify(manualState).slice(0, 300),
    ]);
    checks.push([
      'that message says what the reload is for',
      /reload|isolation|SharedArrayBuffer/i.test(manualState.body),
      manualState.body.slice(0, 200),
    ]);

    await manual.screenshot({ path: path.join(ARTIFACTS, 'e2e-09-isolation-manual.png') });
    await clickButton(manual, 'Reload', '.toast');
    const manualRepaired = await manual
      .waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 60000, polling: 250 })
      .then(() => true)
      .catch(() => false);
    const manualLoads = await manual.evaluate(() => Number(sessionStorage.getItem('e2e.manual-loads') ?? '0'));
    checks.push(['the offered reload does fix it, in one click', manualRepaired === true && manualLoads === 2, `loads: ${manualLoads}`]);
    await manual.close();
    await headerless.close();

    // --- the layout GitHub Pages serves ---------------------------------------

    // A project site lives one directory down, on a host that sends no headers, and
    // `base: './'` in vite.config.ts is the only reason its asset URLs resolve. That
    // combination is not covered anywhere else in the suite, so it is checked here.
    const subPage = await browser.newPage();
    const subWatcher = watchPage(subPage);
    consoleErrors.push(...subWatcher.errors);
    const subUrl = `${SUBPATH_BASE}/BrowserGBA/`;
    await subPage.goto(subUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await subPage.waitForSelector('.app-header .brand', { timeout: 30000 });
    checks.push(['the built app boots from a repository sub-path (the GitHub Pages layout)', true]);
    checks.push([
      'a properly built deployment does not show the development-shell warning',
      (await subPage.$('.boot-failure')) === null,
    ]);
    checks.push([
      'a sub-path deployment on a header-less host starts un-isolated',
      (await subPage.evaluate(() => globalThis.crossOriginIsolated === true)) === false,
    ]);
    const scopeHandle = await subPage.waitForFunction(
      async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration ? registration.scope : false;
      },
      { timeout: 25000, polling: 500 },
    );
    const subScope = await scopeHandle.jsonValue();
    checks.push([
      'the offline worker is scoped to the sub-path, not the domain root',
      typeof subScope === 'string' && subScope.endsWith('/BrowserGBA/'),
      String(subScope),
    ]);
    await subPage.screenshot({ path: path.join(ARTIFACTS, 'e2e-08-pages-subpath.png') });
    await subPage.close();

    // --- a host serving the wrong thing explains itself -----------------------

    // The other half of the same story: when a host publishes the repository instead
    // of the build, the page must say what is wrong instead of rendering nothing.
    const devShellPage = await browser.newPage();
    await devShellPage.goto(`${BASE}/devshell/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await devShellPage.waitForSelector('.boot-failure', { timeout: 20000 });
    const bootMessage = await devShellPage.$eval('.boot-failure', (node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    checks.push([
      'a host serving the development shell explains the problem instead of showing a blank page',
      /could not start/i.test(bootMessage) && /GitHub Actions/.test(bootMessage),
      bootMessage.slice(0, 160),
    ]);
    checks.push([
      'that explanation points at the built app rather than pretending to run',
      (await devShellPage.$('.app-header')) === null,
    ]);
    await devShellPage.close();

    // --- embedded (non-isolated) context is explained, not fatal ----------

    const framePage = await browser.newPage();
    await framePage.setViewport({ width: 1100, height: 800 });
    // A third-party page that cannot send isolation headers, framing the app
    // cross-origin: the everyday embedding case, and the one the app cannot repair
    // for itself (a frame never gets isolation its parent chain does not have).
    await framePage.goto(`${EMBED_BASE}/embed.html`, { waitUntil: 'domcontentloaded' });
    const frameHandle = await framePage.waitForSelector('iframe', { timeout: 15000 });
    await framePage.evaluate((url) => {
      const node = document.querySelector('iframe');
      if (node) node.src = url;
    }, `${BASE}/`);
    const frame = await frameHandle.contentFrame();
    await frame.waitForSelector('.empty-state, .game-card', { timeout: 30000 });

    // Setting the src above re-navigates the frame, so retry rather than assuming the
    // first paint is the document we will be talking to.
    const frameInput = await (async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const input = await frame.$('#rom-file-input').catch(() => null);
        if (input) return input;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    })();
    if (!frameInput) throw new Error('the framed app never rendered its import control');

    // The framed app runs on the main origin, so it shares the library imported
    // earlier — only import when the frame is showing an empty one. (Uploading a file
    // that is already there raises the duplicate prompt, which is modal and would
    // block the click below.)
    if ((await frame.$$eval('.game-card', (nodes) => nodes.length)) === 0) {
      await frameInput.uploadFile(romPath);
      await frame.waitForSelector('.game-card', { timeout: 30000 });
    }
    checks.push([
      'the library renders inside a third-party frame',
      (await frame.$$eval('.game-card', (nodes) => nodes.length)) > 0,
    ]);

    await frame.click('.game-card button.btn-primary');
    await frame.waitForSelector('.notice-danger, .screen-frame canvas', { timeout: 30000 });
    const frameState = await frame.evaluate(() => ({
      isolated: globalThis.crossOriginIsolated,
      blocking: document.querySelector('.notice-danger h3')?.textContent?.trim() ?? null,
      canOpenTab: Boolean(document.querySelector('.notice-danger a[target="_blank"]')),
      startedAnyway: Boolean(document.querySelector('.screen-frame canvas')),
      selfIsolateOffered: /Enable playback/.test(document.body.textContent ?? ''),
    }));
    checks.push(['an embedded page is not cross-origin isolated', frameState.isolated === false]);
    checks.push(['playback blockage is explained in plain language', Boolean(frameState.blocking)]);
    checks.push(['the explanation offers to open the app in its own tab', frameState.canOpenTab === true]);
    checks.push(['playback is refused instead of half-started in a frame', frameState.startedAnyway === false]);
    checks.push([
      'a frame is not offered self-repair it could never complete',
      frameState.selfIsolateOffered === false,
    ]);
    await framePage.screenshot({ path: path.join(ARTIFACTS, 'e2e-05-embedded.png') });
    await framePage.close();

    // --- no silent console errors ----------------------------------------

    const realErrors = [...new Set(consoleErrors)].filter(
      (message) => !message.includes('service worker') && !message.includes('ServiceWorker'),
    );
    checks.push(['the console stays free of runtime errors', realErrors.length === 0, realErrors.join(' | ')]);
  } finally {
    await browser.close();
    server.close();
    plainServer.close();
    embedServer.close();
    subpathServer.close();
    manualServer.close();
  }

  const failure = logChecks(SCRIPT, checks);
  if (failure) {
    console.error(`\n[${SCRIPT}] FAILED at: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\n[${SCRIPT}] all checks passed`);
  }
}

main().catch((error) => {
  console.error(`[${SCRIPT}] harness error:`, error);
  process.exitCode = 1;
});
