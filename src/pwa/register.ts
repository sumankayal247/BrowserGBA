/**
 * Service-worker registration.
 *
 * Policy: the shell and the emulator core are cached so the app opens offline;
 * user data never enters the cache because it lives in IndexedDB. Registration
 * failures are never fatal — offline support is a convenience, not a
 * requirement, and the app works fully without it.
 */

export interface ServiceWorkerStatus {
  registered: boolean;
  reason?: string;
  scope?: string;
}

export function canRegisterServiceWorker(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    (globalThis.isSecureContext === true || globalThis.location?.hostname === 'localhost')
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerStatus> {
  if (!canRegisterServiceWorker()) {
    return { registered: false, reason: 'Service workers need a secure context (HTTPS or localhost).' };
  }

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    // A new worker takes over on the next load; nothing needs to be interrupted.
    registration.addEventListener('updatefound', () => {
      console.info('[BrowserGBA] A new version is downloading in the background.');
    });
    return { registered: true, scope: registration.scope };
  } catch (error) {
    return {
      registered: false,
      reason: error instanceof Error ? error.message : 'Registration failed.',
    };
  }
}

/**
 * Key under which a tab records that it already tried the automatic repair.
 *
 * `sessionStorage` is per tab and survives reloads, which is exactly the scope we
 * want: one attempt per tab, so a host where the trick cannot work is never reloaded
 * twice, while a new tab (or a later visit) starts clean and usually finds the worker
 * already installed.
 */
const RECOVERY_KEY = 'browsergba.isolation-recovery';

/** What the app should do about missing cross-origin isolation, decided from state alone. */
export type IsolationRecoveryPlan =
  | { action: 'none'; reason: 'already-isolated' }
  /** Register the worker and reload once: it can make the next load isolated. */
  | { action: 'recover' }
  /** Nothing left to try automatically; tell the user what to do instead. */
  | { action: 'manual'; reason: 'embedded' | 'no-service-worker' | 'already-attempted' };

/** True when this tab has already spent its one automatic reload. */
export function isolationRecoveryAttempted(): boolean {
  try {
    return sessionStorage.getItem(RECOVERY_KEY) === '1';
  } catch {
    // Storage blocked (some privacy modes). Treat it as "already tried": reloading on
    // every load would be worse than asking the user to reload once.
    return true;
  }
}

export function markIsolationRecoveryAttempted(): void {
  try {
    sessionStorage.setItem(RECOVERY_KEY, '1');
  } catch {
    /* nothing to record; the next load simply offers the manual path */
  }
}

/**
 * Decides whether missing isolation is worth repairing automatically.
 *
 * The one rule that matters: never reload twice for the same tab. Every branch that
 * could otherwise loop returns `manual`, which is what the UI turns into a plain
 * "reload" button and an explanation.
 *
 * @param options.isolated Overridable for tests; defaults to the real page state.
 * @param options.embedded Overridable for tests; defaults to the real frame check.
 * @param options.serviceWorker Overridable for tests; defaults to `canRegisterServiceWorker()`.
 * @param options.attempted Overridable for tests; defaults to `isolationRecoveryAttempted()`.
 */
export function isolationRecoveryPlan(
  options: {
    isolated?: boolean;
    embedded?: boolean;
    serviceWorker?: boolean;
    attempted?: boolean;
  } = {},
): IsolationRecoveryPlan {
  const isolated = options.isolated ?? globalThis.crossOriginIsolated === true;
  if (isolated) return { action: 'none', reason: 'already-isolated' };

  const embedded = options.embedded ?? isEmbedded();
  // A browser never grants cross-origin isolation to a nested document, so a reload
  // inside a frame cannot help however many times it is tried.
  if (embedded) return { action: 'manual', reason: 'embedded' };

  const serviceWorker = options.serviceWorker ?? canRegisterServiceWorker();
  if (!serviceWorker) return { action: 'manual', reason: 'no-service-worker' };

  const attempted = options.attempted ?? isolationRecoveryAttempted();
  if (attempted) return { action: 'manual', reason: 'already-attempted' };

  return { action: 'recover' };
}

export interface IsolationResult {
  /** True when the document is cross-origin isolated now. */
  isolated: boolean;
  /** True when a reload was triggered to reach a state where it will be. */
  reloading: boolean;
  /** Why isolation could not be arranged, for the UI to explain. */
  reason?: string;
}

/**
 * Cross-origin isolation the host did not provide, arranged from inside the page.
 *
 * The emulator core is threaded and needs `SharedArrayBuffer`, which browsers only
 * expose to an isolated document. Isolation normally comes from
 * `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` response headers,
 * and static hosts such as GitHub Pages cannot send any — but a service worker can
 * set them on the responses it answers with. So where a host is silent, the worker
 * this app already registers for offline support becomes the source of the headers.
 *
 * Two consequences, both deliberate:
 *
 *  - The *second* visit to such a host is already isolated, with nothing for the
 *    user to do, because the worker is registered on the first visit and serves
 *    every response after that.
 *  - The first visit can ask the worker to take over immediately, at the cost of one
 *    reload. That is what this function does, and it is only ever called from a
 *    button the user pressed; BrowserGBA never reloads the page behind their back.
 *
 * It refuses to act inside an iframe, where a reload could never help (browsers do
 * not grant isolation to a nested document, whatever headers arrive).
 *
 * @param options.reload Supplied by tests; production reloads the page.
 */
export async function enableCrossOriginIsolation(
  options: { reload?: () => void } = {},
): Promise<IsolationResult> {
  if (globalThis.crossOriginIsolated === true) {
    return { isolated: true, reloading: false, reason: 'already-isolated' };
  }
  if (isEmbedded()) {
    return { isolated: false, reloading: false, reason: 'embedded' };
  }
  if (!canRegisterServiceWorker()) {
    return { isolated: false, reloading: false, reason: 'no-service-worker' };
  }

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    // `ready` means the worker is active; the page only gets its headers once the
    // worker actually controls this client. Reloading before that would produce
    // another non-isolated document and waste the user's click.
    const controlling = await waitForController(registration, 6000);
    if (!controlling) {
      return { isolated: false, reloading: false, reason: 'worker-not-controlling' };
    }
    const reload = options.reload ?? (() => globalThis.location.reload());
    reload();
    return { isolated: false, reloading: true, reason: 'reloading' };
  } catch (error) {
    return {
      isolated: false,
      reloading: false,
      reason: error instanceof Error ? error.message : 'registration-failed',
    };
  }
}

/** Plain-language explanation for a failed isolation attempt. */
export function isolationFailureMessage(reason: string | undefined): string {
  switch (reason) {
    case 'already-attempted':
      return 'Reloading this page once should be enough — this tab has already tried it automatically, so the button below will do it again. If it still does not work, the service worker is not being allowed to take over; check that site data is enabled for this page.';
    case 'embedded':
      return 'BrowserGBA cannot grant itself isolation inside a frame, and browsers never give it to a nested page. Open the app in its own tab instead.';
    case 'no-service-worker':
      return 'This page is not served over HTTPS (or localhost), so the service worker that could supply the isolation headers cannot be registered.';
    case 'worker-not-controlling':
    case 'registration-failed':
      return 'The offline worker did not take control of this page in time. Reloading the page once usually fixes it.';
    default:
      return 'Cross-origin isolation could not be arranged. Serving the app with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` always works — see docs/DEPLOYMENT.md.';
  }
}

function isEmbedded(): boolean {
  try {
    return globalThis.window !== undefined && globalThis.window.self !== globalThis.window.top;
  } catch {
    // Reading `top` threw: a cross-origin parent, which still means embedded.
    return true;
  }
}

async function waitForController(
  registration: ServiceWorkerRegistration,
  timeoutMs: number,
): Promise<boolean> {
  if (navigator.serviceWorker.controller) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve(value);
    };
    const timer = setTimeout(() => finish(Boolean(navigator.serviceWorker.controller)), timeoutMs);
    function onChange(): void {
      clearTimeout(timer);
      finish(true);
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    // An already-activated worker may claim this client without another event.
    void registration.update?.().catch(() => undefined);
  });
}

/** Removes the service worker and its caches — used by the "delete everything" flow. */
export async function unregisterServiceWorkers(): Promise<number> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 0;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  if (typeof caches !== 'undefined') {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
  return registrations.length;
}
