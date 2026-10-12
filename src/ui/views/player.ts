/**
 * Player view: the game screen plus every control that belongs next to it.
 *
 * Layout rules:
 * - The screen frame is sized in whole-number scales so pixels are never
 *   resampled; the canvas backing store stays at the GBA's native 240x160.
 * - Touch controls sit under the screen and only appear on touch devices, with
 *   the game still visible between the D-pad and the face buttons.
 * - Advanced options live in the pause overlay, so the control strip stays
 *   reachable without crowding the game.
 */
import { el, replace, formatRelativeTime, humanBytes } from '@/ui/dom';
import { notify } from '@/ui/toast';
import { confirmDialog, openDialog } from '@/ui/dialog';
import { FILTERS, filterStyles, type FilterId } from '@/render/display';
import { GBA_BUTTONS, keyLabel, type GbaButton, type InputAction } from '@/input/bindings';
import { cheatsRepo } from '@/storage/records';
import { getRomBytes, getGame, titleOf } from '@/library/library';
import { MgbaCore } from '@/emulator/mgba-adapter';
import { blockingIssues } from '@/emulator/environment';
import { PlayerController, applyViewport } from '@/app/player';
import { enableCrossOriginIsolation, isolationFailureMessage } from '@/pwa/register';
import { notice, type ViewContext, type ViewInstance } from '@/app/app';
import { formatDuration } from '@/storage/quota';

export async function renderPlayerView(context: ViewContext): Promise<ViewInstance> {
  const { app, route, navigate } = context;
  const gameId = route.params.id ?? '';
  const game = await getGame(gameId);

  if (!game) {
    return {
      element: el('div', {
        className: 'card',
        children: [
          el('h1', { text: 'Game not found' }),
          el('p', { text: 'That entry is no longer in your library.' }),
          el('a', { className: 'btn', text: 'Back to library', attrs: { href: '#/library' } }),
        ],
      }),
    };
  }

  const romBytes = await getRomBytes(gameId);
  if (!romBytes) {
    return {
      element: el('div', {
        children: [
          notice('danger', 'This game has no ROM stored', 'The ROM bytes for this entry are missing. Import the file again to play it.'),
          el('a', { className: 'btn', text: 'Back to library', attrs: { href: '#/library' } }),
        ],
      }),
    };
  }

  const environment = app.refreshEnvironment();
  const blockers = blockingIssues(environment);
  if (blockers.length > 0) {
    // The host may simply not send the isolation headers (GitHub Pages cannot). The
    // service worker can supply them, which costs one reload — offer that as a button
    // rather than reloading the page on the user's behalf.
    const isolationButton = environment.canSelfIsolate
      ? el('button', {
          className: 'btn btn-primary',
          text: 'Enable playback (reloads once)',
          attrs: { type: 'button' },
          on: {
            click: async () => {
              const outcome = await enableCrossOriginIsolation();
              if (!outcome.reloading && !outcome.isolated) {
                notify.warning('Playback is still blocked', isolationFailureMessage(outcome.reason));
              }
            },
          },
        })
      : null;

    return {
      element: el('div', {
        children: [
          notice('danger', blockers[0]!.label, blockers[0]!.detail, [
            isolationButton,
            environment.isEmbedded
              ? el('a', {
                  className: 'btn btn-primary',
                  text: 'Open in a new tab',
                  attrs: { href: globalThis.location.href, target: '_blank', rel: 'noopener' },
                })
              : null,
            el('a', { className: 'btn', text: 'Back to library', attrs: { href: '#/library' } }),
          ]),
          el('div', {
            className: 'card',
            children: [
              el('h2', { text: 'Everything else still works' }),
              el('p', {
                text: 'Importing, organising, exporting saves and backups keep working without playback. Only the emulator itself needs these browser features.',
              }),
            ],
          }),
        ],
      }),
    };
  }

  // --- screen ------------------------------------------------------------

  const canvas = el('canvas', {
    attrs: {
      width: 240,
      height: 160,
      'aria-label': 'Game screen',
      role: 'img',
    },
  }) as HTMLCanvasElement;

  const filterOverlay = el('div', { className: 'filter-overlay', attrs: { 'aria-hidden': 'true' } });
  const frame = el('div', { className: 'screen-frame', children: [canvas, filterOverlay] });

  const speedIndicator = el('span', {
    className: 'speed-indicator',
    attrs: { 'data-active': 'false', 'data-mode': 'normal', role: 'status' },
    children: ['100%'],
  });

  const saveIndicator = el('span', {
    className: 'save-indicator',
    attrs: { 'data-status': 'idle', role: 'status' },
    text: 'No save yet',
  });

  const filterSelect = el('select', {
    attrs: { 'aria-label': 'Visual filter' },
    children: FILTERS.map((filter) =>
      el('option', { text: filter.label, attrs: { value: filter.id } }),
    ),
    on: {
      change: () => {
        const filterId = filterSelect.value as FilterId;
        void app.updateSettings({
          session: { ...app.settings.session, filterId },
        });
        applyFilter(filterId);
      },
    },
  });
  filterSelect.value = app.settings.session.filterId;

  const intensityInput = el('input', {
    attrs: { type: 'range', min: '0', max: '100', step: '5', 'aria-label': 'Filter intensity' },
    props: { value: '60' },
    on: { input: () => applyFilter(filterSelect.value as FilterId) },
  }) as HTMLInputElement;

  function applyFilter(filterId: FilterId | string): void {
    const intensity = Number(intensityInput.value) / 100;
    const styles = filterStyles(filterId as FilterId, intensity);
    canvas.style.filter = styles.canvasFilter;
    filterOverlay.style.backgroundImage = styles.overlayImage;
    filterOverlay.style.opacity = String(styles.overlayOpacity);
    filterOverlay.style.display = styles.disabled ? 'none' : 'block';
    const definition = FILTERS.find((filter) => filter.id === (filterId as FilterId));
    intensityInput.disabled = !definition?.hasIntensity;
  }

  // --- HUD ---------------------------------------------------------------

  const statusLine = el('div', { className: 'player-hud' });
  const titleLine = el('div', {
    className: 'player-bar',
    children: [
      el('button', {
        className: 'btn btn-sm',
        text: '← Library',
        attrs: { type: 'button' },
        on: { click: () => navigate('/library') },
      }),
      el('span', { className: 'player-title', text: titleOf(game) }),
      el('span', { className: 'spacer' }),
      speedIndicator,
      saveIndicator,
    ],
  });

  const controlStrip = el('div', { className: 'control-strip', attrs: { 'aria-label': 'Emulator controls' } });

  const touchHost = el('div', { className: 'touch-controls', attrs: { 'aria-label': 'On-screen controls' } });

  // Portrait phones get a bigger picture in landscape. The hint is only displayed
  // by CSS in that exact situation (portrait, touch device, no fullscreen).
  const orientationHint = el('p', {
    className: 'orientation-hint',
    text: 'Rotate your device or use Fullscreen for a larger picture.',
  });

  const stage = el('div', {
    className: 'stage-wrap',
    children: [
      el('div', { className: 'player-fullscreen-host', children: [titleLine, frame] }),
      controlStrip,
      statusLine,
      orientationHint,
      touchHost,
    ],
  });

  const element = el('section', { className: 'player', children: [stage] });

  // --- controller --------------------------------------------------------

  const core = new MgbaCore();
  let controller: PlayerController;
  try {
    await core.init(canvas);
  } catch (error) {
    return {
      element: el('div', {
        children: [
          notice('danger', 'The emulator could not start', error instanceof Error ? error.message : 'Unknown error', [
            el('a', { className: 'btn', text: 'Back to library', attrs: { href: '#/library' } }),
          ]),
        ],
      }),
    };
  }

  try {
    controller = await PlayerController.create({
      core,
      game,
      romBytes: new Uint8Array(romBytes),
      settings: app.settings.session,
      keyboard: app.settings.keyboard as unknown as Record<string, string>,
      onFeedback: (feedback) => updateSaveIndicator(feedback),
      onCheatsRejected: (rejected, applied) => {
        // A bad code must never stop play, but it must not be silent either.
        const names = rejected.map((cheat) => cheat.label).join(', ');
        notify.warning(
          rejected.length === 1 ? 'One cheat code did not load' : `${rejected.length} cheat codes did not load`,
          `The emulator could not read ${names}. The game is running with ${
            applied === 0 ? 'no cheats' : `${applied} other code${applied === 1 ? '' : 's'}`
          }. Nothing was deleted — fix or disable it on the game page.`,
          {
            durationMs: 0,
            kind: 'warning',
            action: {
              label: 'Disable them',
              onClick: () => {
                void (async () => {
                  for (const cheat of rejected) await cheatsRepo.setEnabled(game.id, cheat.id, false);
                  notify.info('Cheats disabled', 'They will not be loaded next time you start the game.');
                })();
              },
            },
          },
        );
      },
      onSpeedChange: (multiplier, isHold) => updateSpeedIndicator(multiplier, isHold),
      onVolumeChange: (volume, muted) => {
        void app.updateSettings({ session: { ...app.settings.session, volume, muted } });
      },
      onNeedsGesture: () => {},
    });
  } catch (error) {
    await core.destroy();
    return {
      element: el('div', {
        children: [
          notice(
            'danger',
            'This ROM could not be started',
            error instanceof Error ? error.message : 'Unknown error',
            [el('a', { className: 'btn', text: 'Back to library', attrs: { href: '#/library' } })],
          ),
        ],
      }),
    };
  }

  document.body.setAttribute('data-playing', 'true');

  function updateSpeedIndicator(multiplier: number, isHold: boolean): void {
    const percent = Math.round(multiplier * 100);
    speedIndicator.textContent = multiplier === 1 ? '100%' : `${percent}%${isHold ? ' ⏩' : ''}`;
    speedIndicator.setAttribute('data-active', String(multiplier !== 1));
    speedIndicator.setAttribute('data-mode', multiplier < 1 ? 'slow' : 'normal');
  }

  function updateSaveIndicator(feedback: { status: string; lastSavedAt: number | null; message?: string }): void {
    saveIndicator.setAttribute('data-status', feedback.status);
    if (feedback.status === 'error') {
      saveIndicator.textContent = feedback.message ?? 'Save failed';
    } else if (feedback.status === 'pending') {
      saveIndicator.textContent = 'Saving…';
    } else if (feedback.status === 'saved') {
      saveIndicator.textContent = `Saved ${formatRelativeTime(feedback.lastSavedAt)}`;
    } else {
      saveIndicator.textContent = 'No save yet';
    }
  }

  // --- controls ----------------------------------------------------------

  function holdButton(
    label: string,
    onDown: () => void,
    onUp: () => void,
    options: { className?: string; title?: string } = {},
  ): HTMLButtonElement {
    const button = el('button', {
      className: `btn btn-sm hold-btn ${options.className ?? ''}`.trim(),
      text: label,
      attrs: {
        type: 'button',
        'data-hold': 'true',
        ...(options.title ? { title: options.title, 'aria-label': options.title } : {}),
      },
    }) as HTMLButtonElement;

    const start = (event: Event) => {
      event.preventDefault();
      controller.unlockAudio();
      button.setAttribute('data-active', 'true');
      onDown();
    };
    const end = () => {
      if (button.getAttribute('data-active') !== 'true') return;
      button.setAttribute('data-active', 'false');
      onUp();
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      end();
    };

    button.addEventListener('pointerdown', start);
    button.addEventListener('pointerup', end);
    button.addEventListener('pointercancel', cancel);
    button.addEventListener('pointerleave', end);
    return button;
  }

  const pauseButton = el('button', {
    className: 'btn btn-sm',
    text: 'Pause',
    attrs: { type: 'button' },
    on: {
      click: () => {
        controller.togglePause();
        pauseButton.textContent = controller.getSession().getState() === 'paused' ? 'Resume' : 'Pause';
      },
    },
  });

  const volumeInput = el('input', {
    attrs: { type: 'range', min: '0', max: '100', step: '5', 'aria-label': 'Volume' },
    props: { value: String(Math.round(app.settings.session.volume * 100)) },
    on: {
      input: () => {
        controller.unlockAudio();
        controller.setVolume(Number(volumeInput.value) / 100);
      },
    },
  }) as HTMLInputElement;

  const muteButton = el('button', {
    className: 'btn btn-sm',
    text: app.settings.session.muted ? 'Unmute' : 'Mute',
    attrs: { type: 'button', 'aria-pressed': String(app.settings.session.muted) },
    on: {
      click: () => {
        controller.unlockAudio();
        controller.toggleMute();
        const { muted } = controller.getVolumeState();
        muteButton.textContent = muted ? 'Unmute' : 'Mute';
        muteButton.setAttribute('aria-pressed', String(muted));
      },
    },
  });

  const fullscreenButton = el('button', {
    className: 'btn btn-sm',
    text: 'Fullscreen',
    attrs: { type: 'button' },
    on: {
      click: () => {
        void toggleFullscreen();
      },
    },
  });

  async function toggleFullscreen(): Promise<void> {
    const host = element.querySelector<HTMLElement>('.player-fullscreen-host') ?? element;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (host.requestFullscreen) {
        await host.requestFullscreen();
      } else {
        notify.warning('Fullscreen unavailable', 'This browser does not allow fullscreen for this element.');
      }
    } catch (error) {
      notify.warning('Fullscreen unavailable', error instanceof Error ? error.message : 'The request was rejected.');
    }
  }

  controller.onToggleFullscreen = () => void toggleFullscreen();

  /**
   * `" (F2)"` for a bound key, or `""` when the action has no key at all.
   *
   * Tooltips read the user's own keyboard map, so remapping a shortcut cannot leave
   * a button advertising a key that no longer does anything.
   */
  const shortcut = (action: InputAction): string => {
    const code = app.settings.keyboard[action];
    return code ? ` (${keyLabel(code)})` : '';
  };

  replace(controlStrip, [
    pauseButton,
    el('button', {
      className: 'btn btn-sm',
      text: 'Save state',
      attrs: { type: 'button', title: `Quick save state${shortcut('quickSave')}` },
      on: { click: () => void controller.quickSave() },
    }),
    el('button', {
      className: 'btn btn-sm',
      text: 'Load state',
      attrs: { type: 'button', title: `Quick load state${shortcut('quickLoad')}` },
      on: { click: () => void controller.quickLoad() },
    }),
    el('button', {
      className: 'btn btn-sm',
      text: 'Save file',
      attrs: { type: 'button', title: 'Write the game’s battery save to browser storage now' },
      on: { click: () => void controller.flushSave() },
    }),
    holdButton(
      'Fast-forward',
      () => controller.beginFastForward(),
      () => controller.endFastForward(),
      { title: `Hold to fast-forward${shortcut('fastForward')}` },
    ),
    holdButton(
      'Rewind',
      () => controller.startRewind(),
      () => controller.stopRewind(),
      { title: `Hold to rewind${shortcut('rewind')} — enable rewind in settings first` },
    ),
    el('button', {
      className: 'btn btn-sm',
      text: 'Screenshot',
      attrs: { type: 'button', title: `Screenshot${shortcut('screenshot')}` },
      on: { click: () => void controller.screenshot() },
    }),
    el('button', {
      className: 'btn btn-sm',
      text: 'Reset',
      attrs: { type: 'button' },
      on: {
        click: async () => {
          const confirmed = await confirmDialog({
            title: 'Reset the game?',
            description:
              'The game restarts from the beginning. Battery saves (in-game saves) are kept, but anything saved only in a save state since your last in-game save will be lost.',
            confirmLabel: 'Reset game',
            danger: true,
          });
          if (confirmed) await controller.reset();
        },
      },
    }),
    el('button', {
      className: 'btn btn-sm',
      text: 'Menu',
      attrs: { type: 'button', title: 'Emulator menu (M)' },
      on: { click: () => openMenu() },
    }),
    el('label', {
      className: 'visually-hidden',
      text: 'Volume',
      attrs: { for: 'player-volume' },
    }),
    volumeInput,
    muteButton,
    fullscreenButton,
  ]);

  volumeInput.id = 'player-volume';

  // --- touch controls ----------------------------------------------------

  const touchKeys: GbaButton[] = [];

  function touchKey(button: GbaButton, label: string, extraClass = ''): HTMLElement {
    const node = el('button', {
      className: `touch-key ${extraClass}`.trim(),
      text: label,
      attrs: { type: 'button', 'data-button': button, 'aria-label': `Button ${label}` },
    });

    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      node.setAttribute('data-held', 'true');
      controller.unlockAudio();
      controller.handleTouch(event.pointerId, button, 'down');
    });
    const release = (event: PointerEvent) => {
      node.removeAttribute('data-held');
      controller.handleTouch(event.pointerId, button, 'up');
    };
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('pointerout', release);
    return node;
  }

  const dpad = el('div', { className: 'touch-pad' });
  const dpadCells: Array<[number, GbaButton | null, string]> = [
    [0, null, ''],
    [1, 'Up', '▲'],
    [2, null, ''],
    [3, 'Left', '◀'],
    [4, null, ''],
    [5, 'Right', '▶'],
    [6, null, ''],
    [7, 'Down', '▼'],
    [8, null, ''],
  ];
  for (const [, button, label] of dpadCells) {
    if (!button) {
      dpad.appendChild(el('span', { className: 'touch-dpad-cell' }));
      continue;
    }
    const key = touchKey(button, label);
    touchKeys.push(button);
    dpad.appendChild(key);
  }

  const faceButtons = el('div', {
    className: 'touch-buttons',
    children: [
      touchKey('B', 'B', 'touch-key-round'),
      touchKey('A', 'A', 'touch-key-round'),
      touchKey('Start', 'Start', 'touch-key-wide'),
      touchKey('Select', 'Sel', 'touch-key-wide'),
    ],
  });

  const shoulders = el('div', {
    className: 'touch-shoulders',
    children: [touchKey('L', 'L'), touchKey('R', 'R')],
  });

  const touchSettings = app.settings.touch;
  touchHost.setAttribute('data-enabled', 'true');
  touchHost.setAttribute('data-layout', touchSettings.layout);
  touchHost.style.setProperty('--touch-key', `${Math.round(52 * touchSettings.scale)}px`);
  touchHost.style.setProperty('--touch-opacity', String(touchSettings.opacity));
  replace(touchHost, [
    shoulders,
    dpad,
    faceButtons,
    el('p', {
      className: 'touch-hint',
      text: 'Controls can be resized in Settings → Controls.',
    }),
  ]);

  // --- menu --------------------------------------------------------------

  function openMenu(): void {
    const session = controller.getSession();
    const settings = session.getSettings();

    const speedSelect = el('select', {
      attrs: { 'aria-label': 'Normal speed' },
      children: [0.5, 0.75, 1, 1.5, 2, 3].map((value) =>
        el('option', {
          text: value === 1 ? '100% (normal)' : `${Math.round(value * 100)}%`,
          attrs: { value: String(value) },
        }),
      ),
      on: { change: () => controller.setSpeed(Number(speedSelect.value)) },
    }) as HTMLSelectElement;
    speedSelect.value = String(settings.speedMultiplier);

    const fastForwardSelect = el('select', {
      attrs: { 'aria-label': 'Fast-forward speed' },
      children: [2, 3, 4, 6, 8].map((value) => el('option', { text: `${value}×`, attrs: { value: String(value) } })),
      on: {
        change: () => {
          session.setFastForwardMultiplier(Number(fastForwardSelect.value));
          void app.updateSettings({
            session: { ...app.settings.session, fastForwardMultiplier: Number(fastForwardSelect.value) },
          });
        },
      },
    }) as HTMLSelectElement;
    fastForwardSelect.value = String(settings.fastForwardMultiplier);

    const rewindToggle = el('input', {
      attrs: { type: 'checkbox' },
      props: { checked: settings.rewindEnabled },
      on: {
        change: () => {
          controller.setRewindEnabled(rewindToggle.checked);
          void app.updateSettings({ session: { ...app.settings.session, rewindEnabled: rewindToggle.checked } });
        },
      },
    }) as HTMLInputElement;
    rewindToggle.id = 'menu-rewind';

    const rewindBudget = el('select', {
      attrs: { 'aria-label': 'Rewind history' },
      children: [
        { label: 'Short (~5 s)', value: 300 },
        { label: 'Medium (~10 s)', value: 600 },
        { label: 'Long (~20 s)', value: 1200 },
        { label: 'Very long (~30 s)', value: 1800 },
      ].map((option) => el('option', { text: option.label, attrs: { value: String(option.value) } })),
      on: {
        change: () => {
          const capacity = Number(rewindBudget.value);
          session.setRewindBudget(capacity, settings.rewindBufferInterval);
          void app.updateSettings({ session: { ...app.settings.session, rewindBufferCapacity: capacity } });
        },
      },
    }) as HTMLSelectElement;
    rewindBudget.value = String(settings.rewindBufferCapacity);

    const scalingSelect = el('select', {
      attrs: { 'aria-label': 'Scaling' },
      children: [
        el('option', { text: 'Pixel-perfect (integer)', attrs: { value: 'integer' } }),
        el('option', { text: 'Fit to window', attrs: { value: 'fit' } }),
      ],
      on: {
        change: () => {
          const scaling = scalingSelect.value === 'fit' ? 'fit' : 'integer';
          void app.updateSettings({ session: { ...app.settings.session, scaling } });
          layout();
        },
      },
    }) as HTMLSelectElement;
    scalingSelect.value = settings.scaling;

    const overlay = el('div', {
      children: [
        el('div', {
          className: 'field',
          children: [el('label', { text: 'Normal speed' }), speedSelect],
        }),
        el('div', {
          className: 'field',
          children: [el('label', { text: 'Fast-forward speed' }), fastForwardSelect],
        }),
        el('div', {
          className: 'switch-row',
          children: [
            el('div', {
              className: 'switch-text',
              children: [
                el('strong', { children: [el('label', { text: 'Rewind', attrs: { for: 'menu-rewind' } })] }),
                el('span', { text: 'Stores a rolling history of states so you can step back.' }),
              ],
            }),
            rewindToggle,
          ],
        }),
        el('div', {
          className: 'field',
          children: [el('label', { text: 'Rewind history' }), rewindBudget],
        }),
        el('div', {
          className: 'field',
          children: [el('label', { text: 'Scaling' }), scalingSelect],
        }),
        el('div', {
          className: 'field',
          children: [
            el('label', { text: 'Visual filter' }),
            filterSelect,
            el('div', { className: 'small muted', text: 'Filters only change what you see; nothing is written to your saves.' }),
          ],
        }),
        el('div', {
          className: 'field',
          children: [el('label', { text: 'Filter intensity' }), intensityInput],
        }),
        el('hr'),
        el('p', {
          className: 'small muted',
          text: 'Pausing the emulator stops the game clock. Saves are still written to browser storage.',
        }),
      ],
    });

    openDialog({
      title: 'Emulator menu',
      description: 'These settings apply immediately and are remembered for the next session.',
      content: overlay,
      confirmLabel: 'Done',
      cancelLabel: null,
    });
  }

  controller.onToggleMenu = () => openMenu();

  // --- layout ------------------------------------------------------------

  function layout(): void {
    const availableWidth = Math.max(element.clientWidth - 8, 240);

    // Measure the chrome instead of reserving a fixed guess for it: a guess either
    // wastes screen on desktop or pushes the HUD below the fold on a phone. Two
    // measurements are taken relative to the screen itself, so they hold in all
    // three shapes the player takes:
    //
    //   * everything above the screen (header, page padding, player bar), and
    //   * everything *below* it. Only blocks whose top is under the screen count:
    //     in the landscape layout the controls sit beside the screen and therefore
    //     cost the game no height at all.
    const frameRect = frame.getBoundingClientRect();
    const below = [controlStrip, statusLine, orientationHint, touchHost]
      .filter(
        (node) =>
          node.offsetParent !== null && node.getBoundingClientRect().top >= frameRect.bottom - 1,
      )
      .map((node) => node.getBoundingClientRect().bottom);
    const main = element.parentElement ?? element;
    const bottomPadding = Number.parseFloat(getComputedStyle(main).paddingBottom) || 0;
    const reserved =
      Math.max(frameRect.top, 0) +
      (below.length > 0 ? Math.max(...below) - frameRect.bottom : 0) +
      bottomPadding +
      8;
    const availableHeight = Math.max(globalThis.innerHeight - reserved, 160);

    const result = applyViewport(frame, canvas, { width: availableWidth, height: availableHeight }, app.settings.session.scaling);
    if (!result.pixelPerfect && app.settings.session.scaling === 'integer') {
      // Happens only when the viewport is smaller than one whole frame.
      statusLine.textContent = 'Viewport is smaller than one full frame — showing 1×.';
    }
  }

  applyFilter(app.settings.session.filterId);
  layout();
  updateSpeedIndicator(app.settings.session.speedMultiplier, false);

  // The first pass can run before the stylesheet has been applied — in dev it is a
  // separate request — and unstyled elements report nonsense geometry, which used to
  // leave the frame stuck at 1x on a large window. Measure again after the next
  // paint, once the stylesheet is in, and once fonts have settled.
  requestAnimationFrame(() => layout());
  globalThis.addEventListener('load', () => layout(), { once: true });
  void document.fonts?.ready.then(() => layout());

  const onResize = () => layout();
  globalThis.addEventListener('resize', onResize);
  const onOrientation = () => setTimeout(layout, 150);
  globalThis.addEventListener('orientationchange', onOrientation);

  // Pause when the page is hidden; resume only if the user had not paused.
  const wasPausedByUser = { value: false };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      wasPausedByUser.value = controller.getSession().getState() === 'paused';
      controller.pause();
      pauseButton.textContent = 'Resume';
    }
  });

  // Persist progress if the tab is closed mid-session.
  const onPageHide = () => {
    void controller.getSession().flushSave('stop');
  };
  globalThis.addEventListener('pagehide', onPageHide);

  statusLine.appendChild(
    el('span', {
      className: 'small faint',
      text: `${game.gameCode ?? 'GBA'} · ${humanBytes(game.size)} · ${formatDuration(game.playtimeMs)} played before`,
    }),
  );

  let disposed = false;

  return {
    element,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      globalThis.removeEventListener('resize', onResize);
      globalThis.removeEventListener('orientationchange', onOrientation);
      globalThis.removeEventListener('pagehide', onPageHide);
      document.body.removeAttribute('data-playing');
      touchKeys.length = 0;
      await controller.dispose();
      await core.destroy();
      void wasPausedByUser;
    },
  };
}

export { GBA_BUTTONS };
