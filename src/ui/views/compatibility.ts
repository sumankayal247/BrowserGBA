/**
 * Compatibility view.
 *
 * Renders the same capability matrix the README documents, straight from
 * `src/emulator/compatibility.ts`, so the app and the docs cannot disagree about
 * what is supported, experimental or simply not there yet. It also reports the
 * live environment for this specific browser and device.
 */
import { el, replace, formatDateTime } from '@/ui/dom';
import { APP_VERSION, DB_SCHEMA_VERSION } from '@/version';
import {
  CAPABILITY_GROUPS,
  CORE_IDENTITY,
  type CapabilityRow,
  type SupportLevel,
} from '@/emulator/compatibility';
import { blockingIssues, detectEnvironment } from '@/emulator/environment';
import { GBA_BUTTONS, DEFAULT_KEYBOARD_MAP, ACTION_LABELS, type InputAction } from '@/input/bindings';
import { FILTERS } from '@/render/display';
import { notice, type ViewContext, type ViewInstance } from '@/app/app';

const LEVEL_LABELS: Record<SupportLevel, string> = {
  implemented: 'Supported',
  experimental: 'Experimental',
  unsupported: 'Not supported',
  'not-applicable': 'Not applicable',
};

/** Text and a shape, never colour alone, so the signal survives colour blindness. */
const LEVEL_MARKS: Record<SupportLevel, string> = {
  implemented: '✔',
  experimental: '◐',
  unsupported: '✖',
  'not-applicable': '–',
};

export function renderCompatibilityView(_context: ViewContext): ViewInstance {
  const environment = detectEnvironment();
  const blockers = blockingIssues(environment);

  function rowNode(row: CapabilityRow): HTMLElement {
    const details = el('details', {
      children: [
        el('summary', {
          children: [
            el('span', {
              className: `badge badge-${badgeKind(row.level)}`,
              text: `${LEVEL_MARKS[row.level]} ${LEVEL_LABELS[row.level]}`,
            }),
            el('span', { className: 'cap-name', text: row.feature }),
          ],
        }),
        el('div', {
          className: 'cap-body',
          children: [
            el('p', { text: row.notes }),
            el('p', {
              className: 'small muted',
              children: [el('strong', { text: 'How we know: ' }), row.evidence],
            }),
          ],
        }),
      ],
    });
    return el('li', { children: [details] });
  }

  function badgeKind(level: SupportLevel): string {
    if (level === 'implemented') return 'ok';
    if (level === 'experimental') return 'warn';
    if (level === 'unsupported') return 'danger';
    return 'neutral';
  }

  const groups = CAPABILITY_GROUPS.map((group) =>
    el('div', {
      className: 'card',
      children: [
        el('h2', { text: group.title }),
        el('p', { className: 'small muted', text: group.summary }),
        el('ul', { className: 'capability-list', children: group.rows.map(rowNode) }),
      ],
    }),
  );

  const unverified = CAPABILITY_GROUPS.flatMap((group) => group.rows).filter(
    (row) => row.level === 'experimental',
  );

  const liveEnvironment = el('ul', {
    className: 'capability-list',
    children: [
      live('Cross-origin isolation', environment.crossOriginIsolated, 'Required: the threaded core needs SharedArrayBuffer'),
      live('SharedArrayBuffer', environment.hasSharedArrayBuffer, 'Core threading'),
      live('WebAssembly', environment.hasWebAssembly, 'Emulator'),
      live('Rendering', environment.hasWebGl2 ? 'WebGL 2' : environment.hasWebGl ? 'WebGL 1' : false, 'Video output'),
      live('Web Audio', environment.hasAudioContext, 'Sound'),
      live('IndexedDB', environment.hasIndexedDb, 'Storage'),
      live('Touch input', environment.hasTouch, 'On-screen controls'),
      live('Gamepad API', environment.hasGamepad, 'Optional controllers'),
      live('Fullscreen', environment.hasFullscreen, 'Immersive play'),
      live('Service worker', environment.canUseServiceWorker, 'Offline launch'),
      live('Secure context', environment.isSecureContext, 'Required for offline and storage persistence'),
    ],
  });

  function live(label: string, value: boolean | string, purpose: string): HTMLElement {
    const ok = value !== false;
    return el('li', {
      children: [
        el('span', {
          className: ok ? 'badge badge-ok' : 'badge badge-danger',
          text: ok ? '✔ yes' : '✖ no',
        }),
        el('span', {
          children: [el('strong', { text: `${label}: ` }), typeof value === 'string' ? `${value} — ` : '', purpose],
        }),
      ],
    });
  }

  const keyList = el('ul', {
    className: 'key-list',
    children: (Object.keys(DEFAULT_KEYBOARD_MAP) as InputAction[]).map((action) =>
      el('li', {
        children: [
          el('span', { className: 'key-name', text: ACTION_LABELS[action] }),
          el('code', { text: DEFAULT_KEYBOARD_MAP[action] }),
        ],
      }),
    ),
  });

  const filterList = el('ul', {
    className: 'key-list',
    children: FILTERS.map((filter) =>
      el('li', {
        children: [
          el('span', { className: 'key-name', text: filter.label }),
          el('span', { className: 'small muted', text: filter.description }),
        ],
      }),
    ),
  });

  const element = el('section', {
    className: 'view-compatibility',
    children: [
      el('h1', { text: 'Compatibility' }),
      el('p', {
        text: 'What this build actually does, and how each claim is checked. Anything without an automated test in this repository is labelled experimental rather than presented as working.',
      }),
      blockers.length > 0
        ? notice('danger', 'Playback is blocked in this context', blockers.map((issue) => issue.detail).join(' '), [
            environment.isEmbedded
              ? el('a', {
                  className: 'btn btn-primary',
                  text: 'Open in its own tab',
                  attrs: { href: globalThis.location.href, target: '_blank', rel: 'noopener' },
                })
              : null,
          ])
        : notice('ok', 'This browser can run BrowserGBA', environment.summary),
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'This browser, right now' }),
          liveEnvironment,
          el('p', {
            className: 'small faint',
            text: `Checked ${formatDateTime(Date.now())} · app ${APP_VERSION} · database schema ${DB_SCHEMA_VERSION}`,
          }),
        ],
      }),
      ...groups,
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'Emulator core' }),
          el('dl', {
            className: 'definition-list',
            children: [
              el('dt', { text: 'Name' }),
              el('dd', { text: `${CORE_IDENTITY.name} ${CORE_IDENTITY.version}` }),
              el('dt', { text: 'Licence' }),
              el('dd', { text: CORE_IDENTITY.license }),
              el('dt', { text: 'Build' }),
              el('dd', { text: CORE_IDENTITY.build }),
              el('dt', { text: 'Upstream' }),
              el('dd', {
                children: [
                  el('a', {
                    text: 'mGBA',
                    attrs: { href: CORE_IDENTITY.project, target: '_blank', rel: 'noopener noreferrer' },
                  }),
                  ' · ',
                  el('a', {
                    text: 'WebAssembly fork used here',
                    attrs: { href: CORE_IDENTITY.upstream, target: '_blank', rel: 'noopener noreferrer' },
                  }),
                ],
              }),
            ],
          }),
          el('p', {
            className: 'small muted',
            text: 'mGBA is distributed under the Mozilla Public Licence 2.0. Its source, including the exact WebAssembly build used, is published by the upstream projects linked above; BrowserGBA ships it unmodified.',
          }),
        ],
      }),
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'Default keyboard bindings' }),
          el('p', { className: 'small muted', text: 'All of these can be changed in Settings → Keyboard.' }),
          keyList,
        ],
      }),
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'Game buttons' }),
          el('p', {
            text: `Every Game Boy Advance button is wired up: ${GBA_BUTTONS.join(', ')}. Shoulder buttons are included in the keyboard map, the gamepad map and the on-screen controls.`,
          }),
          el('p', {
            className: 'small muted',
            text: 'Link cable play between two instances is not implemented. It would need a server or a local WebRTC link, and neither is in this release.',
          }),
        ],
      }),
      el('div', { className: 'card', children: [el('h2', { text: 'Visual filters' }), filterList] }),
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'What we cannot promise' }),
          el('p', {
            text: 'This project does not test commercial games — doing so would mean shipping copyrighted ROMs in the test suite, which we will not do. That is why Pokémon titles and ROM hacks are marked experimental even though the underlying emulator core is mature.',
          }),
          el('ul', {
            children: [
              el('li', { text: 'No compatibility list of specific commercial games is maintained here.' }),
              el('li', { text: 'ROM hacks that rely on mappers or cartridge hardware the core does not model may misbehave.' }),
              el('li', { text: 'Games needing a real BIOS file cannot be verified, because no BIOS is shipped or downloaded.' }),
              el('li', {
                text: `Features marked experimental today: ${unverified.map((row) => row.feature).join('; ')}.`,
              }),
            ],
          }),
        ],
      }),
    ],
  });

  return {
    element,
    dispose: () => {
      replace(element, []);
    },
  };
}
