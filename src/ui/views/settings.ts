/**
 * Settings view: emulator defaults, keyboard remapping, touch controls,
 * accessibility and data handling.
 *
 * Every control here writes to the same settings object the player reads, and
 * changes are applied immediately — there is no "save" button to forget. Errors
 * (for example a reserved key) are shown next to the field that caused them.
 */
import { el, replace, formatDateTime } from '@/ui/dom';
import { notify } from '@/ui/toast';
import { confirmDialog } from '@/ui/dialog';
import {
  ACTION_LABELS,
  DEFAULT_KEYBOARD_MAP,
  EMULATOR_ACTIONS,
  GBA_BUTTONS,
  RESERVED_CODES,
  TOUCH_LAYOUTS,
  bindingFromEvent,
  clearBinding,
  findConflicts,
  resetKeyboardMap,
  validateBinding,
  vibrate,
  type InputAction,
  type KeyboardMap,
  keyLabel,
  reservedBindings,
  type TouchLayoutId,
} from '@/input/bindings';
import { FILTERS } from '@/render/display';
import { detectEnvironment } from '@/emulator/environment';
import { estimateStorage, formatBytes, requestPersistentStorage } from '@/storage/quota';
import { deleteDatabase } from '@/storage/db';
import { DEFAULT_SETTINGS, resetSettings, type AppSettings } from '@/app/settings';
import { blockingIssues } from '@/emulator/environment';
import { notice, type ViewContext, type ViewInstance } from '@/app/app';
import { APP_VERSION, DB_SCHEMA_VERSION } from '@/version';

export async function renderSettingsView(context: ViewContext): Promise<ViewInstance> {
  const { app } = context;
  const detachers: Array<() => void> = [];

  const generalHost = el('div');
  const controlsHost = el('div');
  const touchHost = el('div');
  const dataHost = el('div');
  const aboutHost = el('div');

  const environment = detectEnvironment();
  const estimate = await estimateStorage().catch(() => null);

  // Persist a patch to settings and tell subscribers, then re-render this view
  // so dependent controls reflect the stored value rather than a stale copy.
  async function update(patch: Partial<AppSettings>, rerender = false): Promise<void> {
    await app.updateSettings(patch);
    if (rerender) await renderAll();
  }

  // --- emulator defaults -------------------------------------------------

  function sessionPatch(patch: Partial<AppSettings['session']>): Partial<AppSettings> {
    return { session: { ...app.settings.session, ...patch } };
  }

  /**
   * A slider with an inline value readout.
   *
   * `apply` runs on every frame of dragging (so the effect is visible
   * immediately); `commit` runs once on release, which is when the value is
   * written to storage. Splitting them keeps IndexedDB writes off the drag.
   */
  function numberField(
    label: string,
    hint: string,
    value: number,
    options: { min: number; max: number; step: number; suffix?: string },
    apply: (value: number) => void,
    commit: () => void,
  ): HTMLElement {
    const output = el('output', { text: `${value}${options.suffix ?? ''}` });
    const input = el('input', {
      attrs: {
        type: 'range',
        min: String(options.min),
        max: String(options.max),
        step: String(options.step),
        'aria-label': label,
      },
      props: { value: String(value) },
    }) as HTMLInputElement;

    input.addEventListener('input', () => {
      const next = Number(input.value);
      output.textContent = `${next}${options.suffix ?? ''}`;
      apply(next);
    });
    input.addEventListener('change', commit);

    return el('div', {
      className: 'field',
      children: [el('label', { text: label }), el('div', { className: 'field-row', children: [input, output] }), el('span', { className: 'field-hint', text: hint })],
    });
  }

  function checkboxField(
    label: string,
    hint: string,
    checked: boolean,
    apply: (checked: boolean) => void | Promise<void>,
  ): HTMLElement {
    const input = el('input', { attrs: { type: 'checkbox' }, props: { checked } }) as HTMLInputElement;
    input.addEventListener('change', () => void apply(input.checked));
    input.id = `set-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    return el('div', {
      className: 'switch-row',
      children: [
        el('div', {
          className: 'switch-text',
          children: [
            el('label', { text: label, attrs: { for: input.id } }),
            el('span', { className: 'field-hint', text: hint }),
          ],
        }),
        input,
      ],
    });
  }

  function renderGeneral(): void {
    const session = app.settings.session;

    const speedSelect = el('select', {
      attrs: { 'aria-label': 'Normal speed' },
      children: [0.5, 0.75, 1, 1.5, 2].map((value) =>
        el('option', { text: value === 1 ? '100% (normal)' : `${Math.round(value * 100)}%`, attrs: { value: String(value) } }),
      ),
    }) as HTMLSelectElement;
    speedSelect.value = String(session.speedMultiplier);
    speedSelect.addEventListener('change', () => {
      void update(sessionPatch({ speedMultiplier: Number(speedSelect.value) }));
    });

    const ffSelect = el('select', {
      attrs: { 'aria-label': 'Fast-forward multiplier' },
      children: [2, 3, 4, 6, 8, 10].map((value) =>
        el('option', { text: `${value}×`, attrs: { value: String(value) } }),
      ),
    }) as HTMLSelectElement;
    ffSelect.value = String(session.fastForwardMultiplier);
    ffSelect.addEventListener('change', () => {
      void update(sessionPatch({ fastForwardMultiplier: Number(ffSelect.value) }));
    });

    const ffMode = el('select', {
      attrs: { 'aria-label': 'Fast-forward behaviour' },
      children: [
        el('option', { text: 'While held', attrs: { value: 'hold' } }),
        el('option', { text: 'Toggle on and off', attrs: { value: 'toggle' } }),
      ],
    }) as HTMLSelectElement;
    ffMode.value = session.fastForwardMode;
    ffMode.addEventListener('change', () => {
      void update(sessionPatch({ fastForwardMode: ffMode.value === 'toggle' ? 'toggle' : 'hold' }));
      notify.info(
        'Fast-forward behaviour changed',
        ffMode.value === 'toggle' ? 'Tap the key or button to start, tap again to stop.' : 'Hold the key or button to speed up.',
      );
    });

    const filterSelect = el('select', {
      attrs: { 'aria-label': 'Default visual filter' },
      children: FILTERS.map((filter) => el('option', { text: filter.label, attrs: { value: filter.id } })),
    }) as HTMLSelectElement;
    filterSelect.value = session.filterId;
    filterSelect.addEventListener('change', () => {
      void update(sessionPatch({ filterId: filterSelect.value as AppSettings['session']['filterId'] }));
    });

    const scalingSelect = el('select', {
      attrs: { 'aria-label': 'Scaling mode' },
      children: [
        el('option', { text: 'Pixel-perfect (integer scaling)', attrs: { value: 'integer' } }),
        el('option', { text: 'Fit to window (may blur)', attrs: { value: 'fit' } }),
      ],
    }) as HTMLSelectElement;
    scalingSelect.value = session.scaling;
    scalingSelect.addEventListener('change', () => {
      void update(sessionPatch({ scaling: scalingSelect.value === 'fit' ? 'fit' : 'integer' }));
    });

    const reducedMotion = el('p', {
      className: 'small muted',
      text: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'Your system asks for reduced motion, so animations are already minimised.'
        : 'Your system has not asked for reduced motion.',
    });

    replace(generalHost, [
      el('div', { className: 'field', children: [el('label', { text: 'Normal speed' }), speedSelect] }),
      el('div', { className: 'field', children: [el('label', { text: 'Fast-forward speed' }), ffSelect] }),
      el('div', { className: 'field', children: [el('label', { text: 'Fast-forward behaviour' }), ffMode] }),
      checkboxField(
        'Enable rewind',
        'Keeps a rolling history of states so you can step backwards. Costs memory and a little performance.',
        session.rewindEnabled,
        (checked) => update(sessionPatch({ rewindEnabled: checked })),
      ),
      numberField(
        'Rewind history',
        'How many snapshots the core keeps. 600 frames is roughly ten seconds at 60 fps.',
        session.rewindBufferCapacity,
        { min: 60, max: 3600, step: 60, suffix: ' frames' },
        (value) => {
          app.settings.session.rewindBufferCapacity = value;
        },
        () => void app.updateSettings(sessionPatch({})),
      ),
      el('div', { className: 'field', children: [el('label', { text: 'Default visual filter' }), filterSelect] }),
      el('div', { className: 'field', children: [el('label', { text: 'Scaling' }), scalingSelect] }),
      checkboxField('Show FPS counter', 'Draws the core’s frame rate over the game. Off by default.', app.settings.showFpsCounter, (checked) =>
        update({ showFpsCounter: checked }),
      ),
      checkboxField('Ask before loading a save state', 'Loading a state replaces the running session.', app.settings.confirmStateLoad, (checked) =>
        update({ confirmStateLoad: checked }),
      ),
      reducedMotion,
    ]);
  }

  // --- keyboard ----------------------------------------------------------

  function renderControls(): void {
    const map = app.settings.keyboard;
    const conflicts = findConflicts(map);
    const conflictCodes = new Map<string, InputAction[]>();
    for (const conflict of conflicts) conflictCodes.set(conflict.code, conflict.actions);

    let listening: InputAction | null = null;
    let pendingHandler: ((event: KeyboardEvent) => void) | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    function actionRow(action: InputAction): HTMLElement {
      const code = map[action] ?? '';
      const conflict = code ? conflictCodes.get(code) : undefined;
      const button = el('button', {
        className: 'btn btn-sm key-button',
        text: listening === action ? 'Press a key…' : keyLabel(code),
        attrs: {
          type: 'button',
          'aria-label': `Change the key for ${ACTION_LABELS[action]}`,
          'data-listening': String(listening === action),
        },
        on: {
          click: () => {
            listening = action;
            startListening();
            renderControls();
          },
        },
      });

      return el('li', {
        className: 'item-row',
        children: [
          el('div', {
            className: 'item-main',
            children: [
              el('strong', { text: ACTION_LABELS[action] }),
              conflict
                ? el('span', {
                    className: 'badge badge-warn',
                    text: `Also used by ${conflict.filter((other) => other !== action).map((other) => ACTION_LABELS[other]).join(', ')}`,
                  })
                : null,
            ],
          }),
          button,
          el('button', {
            className: 'btn btn-sm btn-ghost',
            text: 'Clear',
            attrs: { type: 'button', 'aria-label': `Clear the key for ${ACTION_LABELS[action]}`, disabled: code ? undefined : true },
            on: {
              click: () => {
                void update({ keyboard: clearBinding(app.settings.keyboard, action) }, true);
              },
            },
          }),
        ],
      });
    }

    /** Removes the pending capture listener, if any. */
    function stopListening(): void {
      if (pendingHandler) {
        window.removeEventListener('keydown', pendingHandler, { capture: true });
        window.removeEventListener('blur', stopListening);
        pendingHandler = null;
      }
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }

    function startListening(): void {
      stopListening();
      pendingHandler = (event: KeyboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const action = listening;
        stopListening();

        if (event.code === 'Escape' || !action) {
          listening = null;
          renderControls();
          return;
        }

        const code = bindingFromEvent(event) ?? event.code;
        if (RESERVED_CODES.has(code)) {
          notify.warning(
            'That key is reserved',
            `${keyLabel(code)} is used by the browser or the operating system, so the game would never see it.`,
          );
          listening = null;
          renderControls();
          return;
        }

        try {
          validateBinding(action, code);
        } catch (error) {
          notify.warning('That key cannot be used', error instanceof Error ? error.message : 'Unknown reason');
          listening = null;
          renderControls();
          return;
        }

        const next: KeyboardMap = { ...app.settings.keyboard, [action]: code };
        const newConflicts = findConflicts(next).filter((conflict) => conflict.code === code);
        listening = null;
        void update({ keyboard: next }, true).then(() => {
          if (newConflicts.length > 0) {
            notify.warning(
              'Two actions share this key',
              'A game button and another action on the same key means one of them will not work.',
            );
          }
        });
      };
      window.addEventListener('keydown', pendingHandler, { capture: true });
      // Abandon the capture if the window loses focus or the user waits too long.
      window.addEventListener('blur', stopListening);
      pendingTimer = setTimeout(() => {
        listening = null;
        stopListening();
        renderControls();
      }, 8000);
    }

    detachers.push(stopListening);

    const rowsHost = el('ul', { className: 'item-list' });
    const group: Array<[string, InputAction[]]> = [
      ['Game buttons', [...GBA_BUTTONS]],
      ['Emulator actions', [...EMULATOR_ACTIONS]],
    ];
    for (const [title, actions] of group) {
      rowsHost.appendChild(el('li', { className: 'list-heading', text: title }));
      for (const action of actions) rowsHost.appendChild(actionRow(action));
    }
    // Shortcuts left over from an older build, or chosen before the browser's own
    // keys were known about: the key works for the browser, not for the game.
    const browserOwned = reservedBindings(map);

    replace(controlsHost, [
      conflicts.length > 0
        ? notice(
            'warn',
            'Some keys are bound more than once',
            'Duplicates are allowed, but the emulator can only act on one of them.',
          )
        : null,
      browserOwned.length > 0
        ? notice(
            'warn',
            'The browser needs some of these keys',
            `${browserOwned
              .map((binding) => `${ACTION_LABELS[binding.action]} = ${keyLabel(binding.code)}`)
              .join(', ')} — the browser acts on that key first (F5 reloads the page, F9 opens Reader View in Firefox), so the emulator never sees it. Pick another key, or use Reset to defaults.`,
          )
        : null,
      rowsHost,
      el('div', {
        className: 'btn-row',
        children: [
          el('button', {
            className: 'btn',
            text: 'Reset to defaults',
            attrs: { type: 'button' },
            on: { click: () => void update({ keyboard: resetKeyboardMap() }, true) },
          }),
        ],
      }),
      el('p', {
        className: 'small faint',
        text: `Bindings use physical key positions, so they follow the same keys on any keyboard layout. Defaults: ${Object.entries(
          DEFAULT_KEYBOARD_MAP,
        )
          .slice(0, 6)
          .map(([action, code]) => `${ACTION_LABELS[action as InputAction]} = ${keyLabel(code)}`)
          .join(', ')}, …`,
      }),
    ]);
  }

  // --- touch -------------------------------------------------------------

  function renderTouch(): void {
    const touch = app.settings.touch;

    const layoutSelect = el('select', {
      attrs: { 'aria-label': 'Touch control layout' },
      children: TOUCH_LAYOUTS.map((layout) => el('option', { text: layout.label, attrs: { value: layout.id } })),
    }) as HTMLSelectElement;
    layoutSelect.value = touch.layout;
    layoutSelect.addEventListener('change', () => {
      void update({ touch: { ...app.settings.touch, layout: layoutSelect.value as TouchLayoutId } }, true);
    });

    const layoutHint = TOUCH_LAYOUTS.find((layout) => layout.id === touch.layout)?.description ?? '';

    replace(touchHost, [
      el('div', { className: 'field', children: [el('label', { text: 'Layout' }), layoutSelect, el('span', { className: 'field-hint', text: layoutHint })] }),
      numberField(
        'Control size',
        'Buttons stay at least 44 px so they are reachable with a thumb.',
        Math.round(touch.scale * 100),
        { min: 75, max: 135, step: 5, suffix: '%' },
        (value) => {
          app.settings.touch.scale = value / 100;
        },
        () => void app.updateSettings({ touch: { ...app.settings.touch } }),
      ),
      numberField(
        'Control opacity',
        'Lower opacity covers less of the game; the controls stay usable either way.',
        Math.round(touch.opacity * 100),
        { min: 30, max: 100, step: 5, suffix: '%' },
        (value) => {
          app.settings.touch.opacity = value / 100;
        },
        () => void app.updateSettings({ touch: { ...app.settings.touch } }),
      ),
      checkboxField('Show shoulder buttons', 'L and R on screen, above the D-pad and A/B clusters.', touch.showShoulders, (checked) =>
        update({ touch: { ...app.settings.touch, showShoulders: checked } }),
      ),
      checkboxField('Haptic feedback', 'Short vibration when a touch button is pressed, where the device supports it.', touch.haptics, (checked) =>
        update({ touch: { ...app.settings.touch, haptics: checked } }),
      ),
      el('div', {
        className: 'btn-row',
        children: [
          el('button', {
            className: 'btn',
            text: 'Test vibration',
            attrs: { type: 'button' },
            on: { click: () => vibrate([10, 40, 10], true) },
          }),
          el('button', {
            className: 'btn',
            text: 'Reset touch settings',
            attrs: { type: 'button' },
            on: { click: () => void update({ touch: { ...DEFAULT_SETTINGS.touch } }, true) },
          }),
        ],
      }),
      environment.hasTouch
        ? null
        : el('p', { className: 'small muted', text: 'This device reports no touch input, so the on-screen controls stay hidden when you play.' }),
    ]);
  }

  // --- data --------------------------------------------------------------

  function renderData(): void {
    const persistedText = estimate
      ? `${formatBytes(estimate.usage)} used of ${formatBytes(estimate.quota, 'an unknown quota')}. ${
          estimate.persisted
            ? 'The browser has been asked to keep this data and agreed.'
            : 'The browser has not promised to keep this data, so it may clear it if space runs low.'
        }`
      : 'This browser does not report storage usage.';

    replace(dataHost, [
      el('p', { className: 'small muted', text: persistedText }),
      el('div', {
        className: 'btn-row',
        children: [
          el('button', {
            className: 'btn',
            text: 'Request persistent storage',
            attrs: { type: 'button' },
            on: {
              click: async () => {
                const granted = await requestPersistentStorage();
                notify.info(
                  granted ? 'Storage will be kept' : 'The browser declined',
                  granted
                    ? 'The browser will not clear this data automatically.'
                    : 'The browser will not promise to keep the data; back up anything important.',
                );
                await renderAll();
              },
            },
          }),
        ],
      }),
      el('hr'),
      checkboxField(
        'Remember screenshots',
        'Keeps the screenshots you take in this browser so they appear on each game’s page.',
        app.settings.keepScreenshots,
        (checked) => update({ keepScreenshots: checked }),
      ),
      checkboxField(
        'Ask before removing a game',
        'Removal deletes the ROM and its progress. Better to be asked.',
        app.settings.confirmGameRemoval,
        (checked) => update({ confirmGameRemoval: checked }),
      ),
      el('hr'),
      el('h3', { text: 'Reset' }),
      el('p', {
        className: 'small muted',
        text: 'Resetting settings does not touch your library, saves or states — only preferences.',
      }),
      el('div', {
        className: 'btn-row',
        children: [
          el('button', {
            className: 'btn',
            text: 'Reset settings only',
            attrs: { type: 'button' },
            on: {
              click: async () => {
                const confirmed = await confirmDialog({
                  title: 'Reset all settings?',
                  description: 'Key bindings, display and control preferences return to their defaults. Your library is untouched.',
                  confirmLabel: 'Reset settings',
                });
                if (!confirmed) return;
                await resetSettings();
                app.settings = { ...app.settings, ...DEFAULT_SETTINGS };
                notify.success('Settings reset');
                await renderAll();
              },
            },
          }),
          el('button', {
            className: 'btn btn-danger',
            text: 'Delete everything',
            attrs: { type: 'button' },
            on: { click: () => void deleteEverything() },
          }),
        ],
      }),
    ]);
  }

  async function deleteEverything(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Delete all BrowserGBA data?',
      description:
        'This removes every ROM, battery save, save state, cheat, screenshot and setting from this browser. There is no undo and nothing is kept in a cloud account.',
      confirmLabel: 'Delete everything',
      danger: true,
      dismissible: false,
      requireChecks: [
        { id: 'backup', label: 'I have exported backups of anything I care about' },
        { id: 'sure', label: 'I understand this cannot be undone' },
      ],
    });
    if (!confirmed) return;
    try {
      await deleteDatabase();
      notify.success('All data deleted', 'Reloading the page…');
      setTimeout(() => globalThis.location.reload(), 800);
    } catch (error) {
      notify.error('Could not delete data', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  // --- about -------------------------------------------------------------

  function renderAbout(): void {
    const blockers = blockingIssues(environment);
    replace(aboutHost, [
      el('dl', {
        className: 'definition-list',
        children: [
          el('dt', { text: 'Version' }),
          el('dd', { text: APP_VERSION }),
          el('dt', { text: 'Database schema' }),
          el('dd', { text: String(DB_SCHEMA_VERSION) }),
          el('dt', { text: 'Emulator core' }),
          el('dd', { text: 'mGBA 2.5.1 (WebAssembly, MPL-2.0)' }),
          el('dt', { text: 'Last checked' }),
          el('dd', { text: formatDateTime(Date.now()) }),
        ],
      }),
      el('ul', {
        className: 'capability-list',
        children: [
          capability('Cross-origin isolation', environment.crossOriginIsolated, 'Required by the threaded core'),
          capability('SharedArrayBuffer', environment.hasSharedArrayBuffer, 'Core threading'),
          capability('WebAssembly', environment.hasWebAssembly, 'The emulator itself'),
          capability('WebGL', environment.hasWebGl2 ? 'WebGL 2' : environment.hasWebGl ? 'WebGL 1' : false, 'Rendering'),
          capability('Web Audio', environment.hasAudioContext, 'Sound'),
          capability('IndexedDB', environment.hasIndexedDb, 'Library, saves and states'),
          capability('Gamepad API', environment.hasGamepad, 'Optional controllers'),
          capability('Touch input', environment.hasTouch, 'On-screen controls'),
          capability('Fullscreen', environment.hasFullscreen, 'Immersive play'),
          capability('Service worker', environment.canUseServiceWorker, 'Offline launch'),
        ],
      }),
      blockers.length > 0
        ? notice('danger', 'Playback is blocked here', blockers.map((issue) => issue.detail).join(' '))
        : null,
    ]);
  }

  function capability(label: string, value: boolean | string, purpose: string): HTMLElement {
    const supported = value === true || typeof value === 'string';
    return el('li', {
      children: [
        el('span', {
          className: supported ? 'badge badge-ok' : 'badge badge-danger',
          // Colour is never the only signal: the text says it too.
          text: supported ? 'available' : 'missing',
        }),
        el('span', {
          children: [
            el('strong', { text: `${label}: ` }),
            typeof value === 'string' ? `${value} — ` : '',
            supported ? `${purpose}.` : `${purpose} is unavailable.`,
          ],
        }),
      ],
    });
  }

  // --- assembly ----------------------------------------------------------

  async function renderAll(): Promise<void> {
    renderGeneral();
    renderControls();
    renderTouch();
    renderData();
    renderAbout();
  }

  await renderAll();

  const element = el('section', {
    className: 'view-settings',
    children: [
      el('h1', { text: 'Settings' }),
      el('p', {
        text: 'Everything here is stored in this browser. Nothing is sent anywhere — there is no account and no server.',
      }),
      el('div', { className: 'card', children: [el('h2', { text: 'Emulator' }), generalHost] }),
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'Keyboard' }),
          el('p', { className: 'small muted', text: 'Click a key, then press the key you want. Escape cancels.' }),
          controlsHost,
        ],
      }),
      el('div', { className: 'card', children: [el('h2', { text: 'Touch controls' }), touchHost] }),
      el('div', { className: 'card', children: [el('h2', { text: 'Data on this device' }), dataHost] }),
      el('div', { className: 'card', children: [el('h2', { text: 'About this browser' }), aboutHost] }),
    ],
  });

  return {
    element,
    dispose: () => {
      for (const detach of detachers.splice(0)) detach();
    },
  };
}
