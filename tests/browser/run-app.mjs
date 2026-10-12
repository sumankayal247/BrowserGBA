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
  CHROMIUM_ARGS,
  analyseStoredScreenshot,
  clickButton,
  countStore,
  findChromium,
  logChecks,
  readSaveByte,
  readIndexedDb,
  repoRoot,
  skipMessage,
  startStaticServer,
  waitForCount,
  waitForSettings,
  watchPage,
} from './harness.mjs';

const SCRIPT = 'test:e2e';
const PORT = Number(process.env.BROWSERGBA_E2E_PORT ?? 4320);
const BASE = `http://127.0.0.1:${PORT}`;
const DOWNLOADS = path.join(repoRoot, 'tests', 'browser', 'artifacts', 'downloads');
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
  const chromium = await findChromium();
  if (!chromium) {
    skipMessage(SCRIPT);
    return;
  }

  await buildApp();
  const romPath = await ensureFixtureRom();
  const altRomPath = await ensureSecondRom();
  await rm(DOWNLOADS, { recursive: true, force: true });
  await mkdir(DOWNLOADS, { recursive: true });

  const server = await startStaticServer({
    port: PORT,
    mounts: [
      // The embedding probe is deliberately served WITHOUT COOP/COEP: that is how
      // ordinary third-party sites are delivered, and it is what makes a frame
      // non-isolated. Everything else gets the isolation headers.
      { prefix: '/plain/', dir: path.join(repoRoot, 'tests', 'browser', 'plain'), isolated: false },
      { prefix: '/tests/', dir: path.join(repoRoot, 'tests') },
      { prefix: '/fixtures/', dir: path.join(repoRoot, 'fixtures') },
      { prefix: '', dir: path.join(repoRoot, 'dist') },
    ],
  });

  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromium,
    headless: true,
    args: CHROMIUM_ARGS,
  });

  const checks = [];
  const consoleErrors = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    const watcher = watchPage(page);
    consoleErrors.push(...watcher.errors);

    const client = await page.createCDPSession();
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });

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

    const fileInput = await page.$('#rom-file-input');
    await fileInput.uploadFile(romPath);
    await page.waitForSelector('.game-card', { timeout: 30000 });

    const importedTitle = await page.$eval('.game-card .game-title', (node) => node.textContent?.trim());
    checks.push(['the imported ROM appears with its header title', importedTitle === 'BGTESTROM']);

    const games = await readIndexedDb(page, 'games');
    checks.push(['the game record stores the content hash', typeof games[0]?.contentHash === 'string' && games[0].contentHash.length === 64]);
    checks.push(['the ROM bytes are stored as a record, not in localStorage', await countStore(page, 'roms') === 1]);
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-02-library-one-game.png') });

    // A second, different ROM: used later to prove cheats stay scoped per game.
    const input2 = await page.$('#rom-file-input');
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
    await page.keyboard.press('F5');
    await waitForCount(page, 'saveStates', 1);
    const states = await readIndexedDb(page, 'saveStates');
    checks.push(['quick save writes a state with a ROM hash and core version', Boolean(states[0]?.romHash) && Boolean(states[0]?.coreVersion)]);
    checks.push(['the state stores a thumbnail for the library UI', states[0]?.thumbnail?.__type === 'Blob']);

    await page.keyboard.press('F8');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const stillPlaying = await page.$('.screen-frame canvas');
    checks.push(['loading a state does not tear the session down', stillPlaying !== null]);

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
    await (await page.$('#rom-file-input')).uploadFile(romPath);
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

    // --- embedded (non-isolated) context is explained, not fatal ----------

    const framePage = await browser.newPage();
    await framePage.setViewport({ width: 1100, height: 800 });
    // The plain page is served without COOP/COEP — the everyday embedding case.
    await framePage.goto(`${BASE}/plain/embed.html`, { waitUntil: 'domcontentloaded' });
    const frameHandle = await framePage.waitForSelector('iframe', { timeout: 15000 });
    const frame = await frameHandle.contentFrame();

    // The frame shares this origin's IndexedDB, so the library imported above must
    // already be visible here. (Re-uploading the same file would raise the
    // duplicate-file prompt, which is correct behaviour but a different test.)
    await frame.waitForSelector('.game-card', { timeout: 30000 });
    const frameLibraryCount = await frame.$$eval('.game-card', (nodes) => nodes.length);
    checks.push(['the library is readable inside an embedded frame', frameLibraryCount === 2]);

    await frame.click('.game-card button.btn-primary');
    await frame.waitForSelector('.notice-danger, .screen-frame canvas', { timeout: 30000 });
    const frameState = await frame.evaluate(() => ({
      isolated: globalThis.crossOriginIsolated,
      blocking: document.querySelector('.notice-danger h3')?.textContent?.trim() ?? null,
      canOpenTab: Boolean(document.querySelector('.notice-danger a[target="_blank"]')),
      startedAnyway: Boolean(document.querySelector('.screen-frame canvas')),
    }));
    checks.push(['an embedded page is not cross-origin isolated', frameState.isolated === false]);
    checks.push(['playback blockage is explained in plain language', Boolean(frameState.blocking)]);
    checks.push(['the explanation offers to open the app in its own tab', frameState.canOpenTab === true]);
    checks.push(['playback is refused instead of half-started in a frame', frameState.startedAnyway === false]);
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
