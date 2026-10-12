/**
 * Runtime capability detection.
 *
 * The emulator core is a threaded WebAssembly build, which means it needs
 * `SharedArrayBuffer`, which browsers only expose to cross-origin isolated
 * documents. Rather than failing with a blank canvas, the app asks these
 * questions up front and explains what is missing.
 *
 * Behaviour is decided by feature detection, never by sniffing the browser. The
 * one exception is `detectEngine()`, which identifies the engine *for display* so a
 * user can report which browser they were on; it never gates a feature.
 */

export type CapabilitySeverity = 'blocking' | 'advisory';

/** Browser engines this project is aware of. `unknown` still works; we just do not label it. */
export type EngineId = 'firefox' | 'chromium' | 'safari' | 'unknown';

export interface EngineInfo {
  id: EngineId;
  /** Human-readable product name, e.g. "Firefox". */
  label: string;
  /** Version number when it could be read, otherwise null. */
  version: string | null;
}

/**
 * Identifies the engine for the compatibility screen.
 *
 * Only ever used for a label — no capability decision is made from this, and every
 * check below is a real feature test, because a wrong (or spoofed) user agent must
 * not change what the app thinks it can do.
 */
export function detectEngine(): EngineInfo {
  const ua = globalThis.navigator?.userAgent ?? '';
  // Major version only: that is the granularity support questions need, and the
  // trailing build numbers of Chromium-family agents are noise.
  const version = (pattern: RegExp): string | null => pattern.exec(ua)?.[1] ?? null;

  // Firefox reports "Firefox/x" on desktop/Android, and "FxiOS/x" on iOS.
  if (/Firefox\//.test(ua) && !/FxiOS/.test(ua)) {
    return { id: 'firefox', label: 'Firefox', version: version(/Firefox\/(\d+)/) };
  }
  // Every browser on iOS is WebKit underneath, and its constraints are Safari's —
  // saying "Firefox" there would point support in the wrong direction.
  if (/FxiOS\//.test(ua)) {
    return { id: 'safari', label: 'Firefox on iOS', version: version(/FxiOS\/(\d+)/) };
  }
  if (/CriOS\//.test(ua)) {
    return { id: 'safari', label: 'Chrome on iOS', version: version(/CriOS\/(\d+)/) };
  }
  if (/EdgiOS\//.test(ua)) {
    return { id: 'safari', label: 'Edge on iOS', version: version(/EdgiOS\/(\d+)/) };
  }
  if (/Edg\//.test(ua)) return { id: 'chromium', label: 'Edge', version: version(/Edg\/(\d+)/) };
  if (/OPR\//.test(ua)) return { id: 'chromium', label: 'Opera', version: version(/OPR\/(\d+)/) };
  if (/Chrome\//.test(ua)) return { id: 'chromium', label: 'Chrome', version: version(/Chrome\/(\d+)/) };
  if (/Safari\//.test(ua) && /Version\//.test(ua)) {
    return { id: 'safari', label: 'Safari', version: version(/Version\/(\d+(?:\.\d+)?)/) };
  }
  return { id: 'unknown', label: 'This browser', version: null };
}

export interface CapabilityIssue {
  id: string;
  severity: CapabilitySeverity;
  /** Short label for a status list. */
  label: string;
  /** What is wrong and what the user can do about it. */
  detail: string;
}

export interface EnvironmentReport {
  /** True when the threaded core can run at all. */
  canRunEmulator: boolean;
  crossOriginIsolated: boolean;
  hasSharedArrayBuffer: boolean;
  hasWebAssembly: boolean;
  hasWebGl2: boolean;
  hasWebGl: boolean;
  hasAudioContext: boolean;
  hasIndexedDb: boolean;
  hasFullscreen: boolean;
  hasGamepad: boolean;
  hasPointerEvents: boolean;
  hasTouch: boolean;
  /** True when this document is inside an iframe, which is what blocks isolation. */
  isEmbedded: boolean;
  /** True when a service worker can be registered (needs HTTPS or localhost). */
  canUseServiceWorker: boolean;
  /** True when the page is served from a secure context. */
  isSecureContext: boolean;
  /** Vibration API: present in Chromium on Android, absent in Firefox and on iOS. */
  hasVibration: boolean;
  /** Browser engine, for display and support only (never used to gate a feature). */
  engine: EngineInfo;
  /**
   * True when the page is *not* cross-origin isolated but could still become so:
   * a service worker can answer the navigation with the isolation headers, which is
   * how the app works on hosts that cannot set headers (GitHub Pages).
   */
  canSelfIsolate: boolean;
  issues: CapabilityIssue[];
  /** One-line summary for the UI status bar. */
  summary: string;
}

function detectWebGl(version: 1 | 2): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const contextName = version === 2 ? 'webgl2' : 'webgl';
    const context = canvas.getContext(contextName);
    // Release the probe context immediately; browsers cap how many can exist.
    if (context && typeof (context as WebGLRenderingContext).getParameter === 'function') {
      const lose = (context as WebGLRenderingContext & { getExtension?: (n: string) => unknown })
        .getExtension?.('WEBGL_lose_context') as { loseContext?: () => void } | undefined;
      lose?.loseContext?.();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function detectEnvironment(override?: Partial<EnvironmentReport>): EnvironmentReport {
  const hasSharedArrayBuffer = typeof SharedArrayBuffer === 'function';
  const crossOriginIsolated = Boolean(
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
  );
  const hasWebAssembly = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  const hasAudioContext =
    typeof globalThis.AudioContext === 'function' ||
    typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext === 'function';
  const hasIndexedDb = (() => {
    try {
      return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
    } catch {
      return false;
    }
  })();
  const isEmbedded = (() => {
    try {
      return globalThis.window !== undefined && globalThis.window.self !== globalThis.window.top;
    } catch {
      // A cross-origin parent makes `window.top` access throw, which still
      // means "we are embedded".
      return true;
    }
  })();

  const canUseServiceWorker =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && globalThis.isSecureContext === true;

  const report: EnvironmentReport = {
    canRunEmulator: false,
    crossOriginIsolated,
    hasSharedArrayBuffer,
    hasWebAssembly,
    hasWebGl2: detectWebGl(2),
    hasWebGl: detectWebGl(1),
    hasAudioContext,
    hasIndexedDb,
    hasFullscreen: typeof document !== 'undefined' && Boolean(document.documentElement?.requestFullscreen),
    hasGamepad: typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function',
    hasPointerEvents: typeof globalThis.PointerEvent === 'function',
    hasTouch: typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0,
    isEmbedded,
    canUseServiceWorker,
    hasVibration:
      typeof navigator !== 'undefined' && typeof (navigator as { vibrate?: unknown }).vibrate === 'function',
    engine: detectEngine(),
    // A frame cannot be isolated (the browser withholds it from nested documents),
    // so only a top-level document can fix this for itself.
    canSelfIsolate: false,
    isSecureContext: globalThis.isSecureContext === true,
    issues: [],
    summary: '',
    ...override,
  };

  // A frame can never be isolated (browsers withhold it from nested documents) and
  // an insecure origin cannot register the worker that would supply the headers, so
  // those two cases have nothing to offer. Everything else can be repaired from
  // inside the page. Computed here rather than at construction so it reflects any
  // overrides the caller applied above.
  report.canSelfIsolate =
    !report.crossOriginIsolated && !report.isEmbedded && report.canUseServiceWorker;

  // The threaded core needs SharedArrayBuffer. Without it the wasm module
  // cannot even be instantiated, so this is blocking, not advisory.
  if (!report.hasWebAssembly) {
    report.issues.push({
      id: 'no-wasm',
      severity: 'blocking',
      label: 'WebAssembly is unavailable',
      detail:
        'This browser cannot run WebAssembly, so the emulator cannot start. Try a current version of Chrome, Edge, Firefox or Safari.',
    });
  }
  if (!report.hasSharedArrayBuffer || !report.crossOriginIsolated) {
    report.issues.push({
      id: 'no-isolation',
      severity: 'blocking',
      label: 'This page is not cross-origin isolated',
      detail: report.isEmbedded
        ? 'BrowserGBA runs inside an embedded frame here, and browsers only grant cross-origin isolation to a top-level page. Open BrowserGBA in its own browser tab to play. (The library, imports, exports and backups all still work in this frame.)'
        : report.canSelfIsolate
          ? 'The emulator core is threaded and needs SharedArrayBuffer, which is only granted to cross-origin isolated pages. This host does not send the isolation headers, so BrowserGBA is trying to supply them itself through its service worker — if this message stays, open the app in a new tab, or serve it with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (see docs/DEPLOYMENT.md).'
          : 'The emulator core is threaded and needs SharedArrayBuffer, which the browser only grants to cross-origin isolated pages. The server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` — see docs/DEPLOYMENT.md.',
    });
  }
  if (!report.hasWebGl2 && !report.hasWebGl) {
    report.issues.push({
      id: 'no-webgl',
      severity: 'blocking',
      label: 'Hardware-accelerated canvas is unavailable',
      detail:
        'The emulator renders through WebGL. Enable hardware acceleration, or try another browser.',
    });
  }
  if (!report.hasIndexedDb) {
    report.issues.push({
      id: 'no-indexeddb',
      severity: 'blocking',
      label: 'No database storage',
      detail:
        'BrowserGBA stores your library in IndexedDB. Private windows and some privacy settings block it.',
    });
  }
  if (!report.hasAudioContext) {
    report.issues.push({
      id: 'no-audio',
      severity: 'advisory',
      label: 'No audio output available',
      detail: 'Games will run silently because this browser exposes no Web Audio API.',
    });
  }
  if (!report.isSecureContext) {
    report.issues.push({
      id: 'insecure-context',
      severity: 'advisory',
      label: 'Served over an insecure connection',
      detail:
        'Without HTTPS (or localhost) some features are limited, and hashing falls back to a slower pure-JavaScript implementation. Installability and offline caching need a secure context.',
    });
  }
  report.canRunEmulator = !report.issues.some((issue) => issue.severity === 'blocking');

  const blocking = report.issues.filter((issue) => issue.severity === 'blocking').length;
  report.summary = report.canRunEmulator
    ? 'Ready to play'
    : `${blocking} blocking ${blocking === 1 ? 'issue' : 'issues'} prevent playback`;

  return report;
}

/** Issues that stop the emulator from running, for callers that only need those. */
export function blockingIssues(report: EnvironmentReport): CapabilityIssue[] {
  return report.issues.filter((issue) => issue.severity === 'blocking');
}
