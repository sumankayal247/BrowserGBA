/**
 * Application shell: header, hash router, shared state and error boundaries.
 *
 * The router is intentionally hash-based so the app also works when opened from
 * a file:// URL or a static host without rewrite rules.
 */
import { el, replace, type Child } from '@/ui/dom';
import { notify } from '@/ui/toast';
import { detectEnvironment, type EnvironmentReport } from '@/emulator/environment';
import { assertSupportedStorage } from '@/storage/support';
import { loadSettings, saveSettings, type AppSettings } from './settings';
import { APP_NAME, APP_VERSION } from '@/version';

export interface RouteMatch {
  name: string;
  params: Record<string, string>;
}

export interface ViewInstance {
  element: HTMLElement;
  /** Called before the view is discarded: detach listeners, stop sessions. */
  dispose?: () => void | Promise<void>;
}

export interface ViewContext {
  app: App;
  route: RouteMatch;
  navigate: (path: string) => void;
}

export type ViewFactory = (context: ViewContext) => Promise<ViewInstance> | ViewInstance;

export class App {
  settings: AppSettings = {} as AppSettings;
  environment: EnvironmentReport = detectEnvironment();

  private readonly routes = new Map<string, ViewFactory>();
  private main!: HTMLElement;
  private navHost!: HTMLElement;
  private current: ViewInstance | null = null;
  private currentRoute: RouteMatch | null = null;
  private disposed = false;
  private readonly disposers: Array<() => void> = [];

  onSettingsChange: Array<(settings: AppSettings) => void> = [];

  registerRoute(name: string, factory: ViewFactory): void {
    this.routes.set(name, factory);
  }

  async start(mountPoint: HTMLElement): Promise<void> {
    // Fail fast, and loudly, if storage is unavailable: the library cannot work
    // without it, and pretending otherwise would lose the user's data.
    assertSupportedStorage();

    this.settings = await loadSettings();
    await this.renderShell(mountPoint);

    const onHashChange = () => void this.renderRoute();
    globalThis.addEventListener('hashchange', onHashChange);
    this.disposers.push(() => globalThis.removeEventListener('hashchange', onHashChange));

    await this.renderRoute();
  }

  go(path: string): void {
    const target = path.startsWith('#') ? path : `#${path}`;
    if (globalThis.location.hash === target) {
      void this.renderRoute();
      return;
    }
    globalThis.location.hash = target;
  }

  private async renderShell(mountPoint: HTMLElement): Promise<void> {
    this.navHost = el('nav', { className: 'app-nav', attrs: { 'aria-label': 'Main sections' } });

    const header = el('header', {
      className: 'app-header',
      children: [
        el('a', {
          className: 'brand',
          attrs: { href: '#/library' },
          children: [
            el('img', {
              className: 'brand-mark',
              attrs: { src: './icons/icon-192.png', alt: '', width: 26, height: 26 },
            }),
            el('span', { children: [
              `BrowserGBA`,
              el('span', { className: 'brand-sub', text: ` ${APP_VERSION}` }),
            ] }),
          ],
        }),
        this.navHost,
      ],
    });

    this.main = el('main', { className: 'app-main', attrs: { id: 'main', tabindex: -1 } });

    const footer = el('footer', {
      className: 'app-footer',
      children: [
        el('p', {
          children: [
            `${APP_NAME} runs `,
            el('strong', { text: 'mGBA 2.5.1' }),
            ' compiled to WebAssembly. mGBA is © Jeffrey Pfau and contributors, licensed MPL-2.0. ',
            el('a', { text: 'Third-party notices', attrs: { href: '#/compatibility' } }),
            '.',
          ],
        }),
        el('p', {
          className: 'small',
          text: 'Your ROMs, saves, states and cheats stay in this browser. BrowserGBA never uploads them, never bundles commercial ROMs, and never downloads BIOS files.',
        }),
      ],
    });

    const root = el('div', { className: 'app-root', children: [header, this.main, footer] });
    replace(mountPoint, [root]);

    this.renderNav();
  }

  private renderNav(): void {
    const links: Array<{ href: string; label: string }> = [
      { href: '#/library', label: 'Library' },
      { href: '#/settings', label: 'Settings' },
      { href: '#/storage', label: 'Storage' },
      { href: '#/compatibility', label: 'Compatibility' },
    ];
    replace(
      this.navHost,
      links.map((link) =>
        el('a', {
          className: 'nav-link',
          text: link.label,
          attrs: { href: link.href, 'data-nav': link.href.slice(2) },
        }),
      ),
    );
  }

  private highlightNav(routeName: string): void {
    for (const link of this.navHost.querySelectorAll<HTMLAnchorElement>('.nav-link')) {
      const target = link.getAttribute('data-nav');
      const isCurrent = target === routeName || (routeName.startsWith('game') && target === 'library');
      if (isCurrent) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  parseRoute(): RouteMatch {
    const raw = globalThis.location.hash.replace(/^#\/?/, '');
    const [pathPart = '', queryPart = ''] = raw.split('?');
    const segments = pathPart.split('/').filter(Boolean);
    const params: Record<string, string> = {};
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const [key, value = ''] = pair.split('=');
      if (key) params[key] = decodeURIComponent(value);
    }
    if (segments[0] === 'play' && segments[1]) {
      params.id = decodeURIComponent(segments[1]);
      return { name: 'play', params };
    }
    if (segments[0] === 'game' && segments[1]) {
      params.id = decodeURIComponent(segments[1]);
      return { name: 'game', params };
    }
    const known = ['library', 'settings', 'storage', 'compatibility'];
    const name = segments[0] && known.includes(segments[0]) ? segments[0] : 'library';
    return { name, params };
  }

  async renderRoute(): Promise<void> {
    if (this.disposed) return;
    const route = this.parseRoute();

    // Dispose the previous view first: this is what stops a running session when
    // the user navigates away from the player.
    if (this.current) {
      try {
        await this.current.dispose?.();
      } catch (error) {
        console.error('Failed to dispose view', error);
      }
      this.current = null;
    }

    const factory = this.routes.get(route.name) ?? this.routes.get('library');
    if (!factory) {
      replace(this.main, [
        el('div', {
          className: 'card',
          children: [
            el('h2', { text: 'Nothing to show' }),
            el('p', { text: 'No views are registered. This is a bug in the app shell.' }),
          ],
        }),
      ]);
      return;
    }

    this.currentRoute = route;
    this.highlightNav(route.name);

    try {
      const view = await factory({ app: this, route, navigate: (path) => this.go(path) });
      // Guard against a route change that happened while the view was loading.
      if (this.parseRoute().name !== route.name) {
        await view.dispose?.();
        return;
      }
      this.current = view;
      replace(this.main, [view.element]);
      this.main.focus({ preventScroll: true });
      globalThis.scrollTo({ top: 0 });
    } catch (error) {
      console.error('View failed to render', error);
      const message = error instanceof Error ? error.message : String(error);
      replace(this.main, [
        el('div', {
          className: 'notice notice-danger',
          children: [
            el('div', {
              className: 'notice-body',
              children: [
                el('h3', { text: 'This screen could not be displayed' }),
                el('p', { text: message }),
                el('p', {
                  className: 'small',
                  text: 'Your library and saves have not been changed. Reloading the page usually clears this up.',
                }),
              ],
            }),
          ],
        }),
      ]);
    }
  }

  getRoute(): RouteMatch | null {
    return this.currentRoute;
  }

  /** Persists settings and tells subscribers (used by the player and views). */
  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    try {
      await saveSettings(this.settings);
    } catch (error) {
      notify.warning(
        'Settings could not be saved',
        error instanceof Error ? error.message : 'Browser storage refused the write.',
      );
    }
    for (const listener of this.onSettingsChange) listener(this.settings);
  }

  /** Re-checks the browser environment (used after the user changes tabs). */
  refreshEnvironment(): EnvironmentReport {
    this.environment = detectEnvironment();
    return this.environment;
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    void this.current?.dispose?.();
    this.current = null;
  }
}

/** Small helper for the status banner used across views. */
export function notice(
  kind: 'ok' | 'warn' | 'danger' | 'info',
  title: string,
  body: Child,
  actions?: Child[],
): HTMLElement {
  return el('div', {
    className: `notice notice-${kind}`,
    children: [
      el('div', {
        className: 'notice-body',
        children: [el('h3', { text: title }), el('p', { children: [body] })],
      }),
      actions ? el('div', { className: 'btn-row', children: actions }) : null,
    ],
  });
}
