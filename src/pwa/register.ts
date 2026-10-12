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
