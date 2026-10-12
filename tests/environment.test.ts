/**
 * Environment detection drives what the app promises and what it refuses, so the
 * parts that are pure logic are pinned here: engine labelling (display only) and the
 * reading of an isolation problem that the app can repair by itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockingIssues, detectEngine, detectEnvironment } from '@/emulator/environment';

const FIREFOX_UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const FIREFOX_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15';

function withUserAgent(userAgent: string, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent');
  Object.defineProperty(globalThis.navigator, 'userAgent', { value: userAgent, configurable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis.navigator, 'userAgent', original);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('engine detection', () => {
  it('labels Firefox, including the version', () => {
    withUserAgent(FIREFOX_UA, () => {
      expect(detectEngine()).toEqual({ id: 'firefox', label: 'Firefox', version: '128' });
    });
  });

  it('labels the Chromium family apart from each other', () => {
    withUserAgent(CHROME_UA, () => {
      expect(detectEngine().id).toBe('chromium');
      expect(detectEngine().version).toBe('126');
    });
    withUserAgent(`${CHROME_UA} Edg/126.0.2592.87`, () => {
      expect(detectEngine().label).toBe('Edge');
    });
  });

  it('labels Safari', () => {
    withUserAgent(SAFARI_UA, () => {
      expect(detectEngine()).toEqual({ id: 'safari', label: 'Safari', version: '17.5' });
    });
  });

  it('reports Firefox on iOS as Safari, because that is the engine it uses', () => {
    // Worth pinning: "Firefox" there is a shell around WebKit, so the emulator
    // constraints are Safari's, not Gecko's.
    withUserAgent(FIREFOX_IOS_UA, () => {
      expect(detectEngine().id).toBe('safari');
    });
  });

  it('never fails, even for an unrecognised or empty agent', () => {
    withUserAgent('', () => {
      expect(detectEngine()).toEqual({ id: 'unknown', label: 'This browser', version: null });
    });
    withUserAgent('Some/1.0 Crawler', () => {
      expect(detectEngine().id).toBe('unknown');
    });
  });
});

describe('isolation reporting', () => {
  it('offers self-isolation only when it could actually work', () => {
    // Not isolated, top-level, secure, service worker available: the app can step in.
    const repairable = detectEnvironment({
      crossOriginIsolated: false,
      hasSharedArrayBuffer: false,
      canUseServiceWorker: true,
      isEmbedded: false,
    });
    expect(repairable.canSelfIsolate).toBe(true);
    expect(blockingIssues(repairable).map((issue) => issue.id)).toContain('no-isolation');
    // The message must not tell the user to redeploy their host when the app can cope.
    expect(blockingIssues(repairable)[0]?.detail).toContain('service worker');

    // In a frame there is nothing to repair, so no button should be offered.
    expect(
      detectEnvironment({ crossOriginIsolated: false, isEmbedded: true, canUseServiceWorker: true })
        .canSelfIsolate,
    ).toBe(false);

    // Already isolated: nothing to do.
    expect(
      detectEnvironment({ crossOriginIsolated: true, canUseServiceWorker: true }).canSelfIsolate,
    ).toBe(false);

    // Insecure origin: no service worker, so no self-repair either.
    expect(
      detectEnvironment({ crossOriginIsolated: false, canUseServiceWorker: false }).canSelfIsolate,
    ).toBe(false);
  });

  it('reports a working page as ready to play', () => {
    const report = detectEnvironment({
      crossOriginIsolated: true,
      hasSharedArrayBuffer: true,
      hasWebAssembly: true,
      hasWebGl2: true,
      hasWebGl: true,
      hasIndexedDb: true,
      canUseServiceWorker: true,
    });
    expect(blockingIssues(report)).toEqual([]);
    expect(report.canRunEmulator).toBe(true);
    expect(report.engine.id).toBeDefined();
  });
});
