/**
 * BrowserGBA entry point.
 *
 * Startup order matters:
 *   1. Check the environment *before* touching storage, so a user in an
 *      unsupported browser gets an explanation instead of a crash.
 *   2. Open the database (this is what creates/migrates the schema).
 *   3. Register the service worker for offline launch, without blocking the UI.
 *   4. Mount the app shell and let the hash router pick a view.
 *
 * Nothing here talks to a network service: the app is complete without one.
 */
import { App } from '@/app/app';
import { el, replace } from '@/ui/dom';
import { notify } from '@/ui/toast';
import { detectEnvironment, blockingIssues } from '@/emulator/environment';
import { assertSupportedStorage, StorageUnsupportedError } from '@/storage/support';
import { openDatabase, StorageError } from '@/storage/db';
import { registerServiceWorker } from '@/pwa/register';
import { APP_NAME, APP_VERSION } from '@/version';
import './styles.css';

export async function bootstrap(mountPoint: HTMLElement): Promise<App | null> {
  const environment = detectEnvironment();

  // Storage is not optional: without it the library cannot exist, and silently
  // running on volatile memory would lose the user's imports.
  try {
    assertSupportedStorage();
    await openDatabase();
  } catch (error) {
    renderFatal(mountPoint, {
      title: error instanceof StorageUnsupportedError ? 'This browser cannot store your library' : 'Storage is unavailable',
      message:
        error instanceof StorageError
          ? error.userMessage
          : 'BrowserGBA needs IndexedDB to keep ROMs, saves and save states on your device.',
      hints: storageHints(error),
    });
    return null;
  }

  const app = new App();
  app.environment = environment;
  app.registerRoute('library', (context) => import('@/ui/views/library').then((module) => module.renderLibraryView(context)));
  app.registerRoute('game', (context) => import('@/ui/views/game').then((module) => module.renderGameView(context)));
  app.registerRoute('play', (context) => import('@/ui/views/player').then((module) => module.renderPlayerView(context)));
  app.registerRoute('settings', (context) => import('@/ui/views/settings').then((module) => module.renderSettingsView(context)));
  app.registerRoute('storage', (context) => import('@/ui/views/storage').then((module) => module.renderStorageView(context)));
  app.registerRoute('compatibility', (context) =>
    import('@/ui/views/compatibility').then((module) => Promise.resolve(module.renderCompatibilityView(context))),
  );

  try {
    await app.start(mountPoint);
  } catch (error) {
    renderFatal(mountPoint, {
      title: 'BrowserGBA could not start',
      message: error instanceof Error ? error.message : String(error),
      hints: ['Reload the page. If it keeps happening, your browser storage may be blocked for this site.'],
    });
    return null;
  }

  // Report environment problems once, in plain language, without blocking use.
  const blockers = blockingIssues(environment);
  if (blockers.length > 0) {
    notify.warning(blockers[0]!.label, blockers[0]!.detail);
  }

  // Offline support is a bonus: never let it delay or break startup. The
  // service worker is only emitted by a production build, so dev skips it.
  if (import.meta.env.PROD) {
    void registerServiceWorker().catch((error) => {
      console.info('[BrowserGBA] Service worker not registered:', error);
    });
  }

  console.info(`[BrowserGBA] ${APP_NAME} ${APP_VERSION} ready (crossOriginIsolated=${environment.crossOriginIsolated})`);
  return app;
}

function storageHints(error: unknown): string[] {
  if (error instanceof StorageUnsupportedError) {
    return [
      'Private or incognito windows often disable IndexedDB — try a normal window.',
      'Firefox private windows block IndexedDB; Chrome and Safari allow it.',
      'Some browsers block storage for sites with restricted cookies or site data settings.',
    ];
  }
  const hints = ['Reload the page and try again.'];
  if (error instanceof StorageError && error.code === 'quota-exceeded') {
    hints.unshift('Free some space by deleting a game, then import again.');
  }
  return hints;
}

function renderFatal(
  mountPoint: HTMLElement,
  options: { title: string; message: string; hints: string[] },
): void {
  replace(mountPoint, [
    el('div', {
      className: 'app-root',
      children: [
        el('main', {
          className: 'app-main',
          children: [
            el('h1', { text: options.title }),
            el('p', { text: options.message }),
            el('ul', { children: options.hints.map((hint) => el('li', { text: hint })) }),
            el('p', {
              className: 'small muted',
              text: `BrowserGBA ${APP_VERSION}`,
            }),
          ],
        }),
      ],
    }),
  ]);
}

/** Starts the app against `#app`, replacing the static loading placeholder. */
export function start(): void {
  const mountPoint = document.getElementById('app');
  if (!mountPoint) {
    console.error('[BrowserGBA] No #app element to mount into.');
    return;
  }
  void bootstrap(mountPoint);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
