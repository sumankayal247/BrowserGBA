/**
 * Game detail view: everything about one entry that is not the game screen.
 *
 * Save states, battery saves, cheats, screenshots and metadata live here because
 * they are per-game by definition (keyed by ROM content hash), and the copy says
 * so explicitly — a user should never have to guess whether a cheat or a state
 * applies to the game they are about to play.
 */
import { el, formatDateTime, formatRelativeTime, humanBytes, downloadBlob } from '@/ui/dom';
import { notify } from '@/ui/toast';
import { confirmDialog, openDialog, promptDialog } from '@/ui/dialog';
import {
  getGame,
  getRomBytes,
  removeGame,
  setFavourite,
  titleOf,
  updateGame,
} from '@/library/library';
import { CHEAT_FORMAT_LIST, sanitiseLabel, validateCheatCode } from '@/cheats/cheats';
import type { CheatFormat } from '@/storage/records';
import { batterySavesRepo, cheatsRepo, saveStatesRepo, screenshotsRepo } from '@/storage/records';
import { nextRecordId } from '@/storage/ids';
import {
  backupFileName,
  buildBackupBundle,
  parseBackupBundle,
  restoreBackupBundle,
} from '@/storage/backup';
import { formatDuration } from '@/storage/quota';
import { getCover, MAX_COVER_BYTES, removeCover, setCover } from '@/storage/covers';
import { notice, type ViewContext, type ViewInstance } from '@/app/app';

export async function renderGameView(context: ViewContext): Promise<ViewInstance> {
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

  const title = titleOf(game);
  const record = game;
  const objectUrls: string[] = [];

  const cover = await getCover(gameId).catch(() => null);
  const coverUrl = cover ? makeUrl(cover.blob) : null;

  function makeUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  }

  const statesHost = el('div');
  const savesHost = el('div');
  const cheatsHost = el('div');
  const shotsHost = el('div');

  // --- header ------------------------------------------------------------

  const coverInput = el('input', {
    className: 'visually-hidden',
    attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif' },
  }) as HTMLInputElement;

  coverInput.addEventListener('change', async () => {
    const file = coverInput.files?.[0];
    coverInput.value = '';
    if (!file) return;
    try {
      await setCover(gameId, file);
      notify.success('Cover saved');
      refresh();
    } catch (error) {
      notify.error('Could not use that image', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  const backupInput = el('input', {
    className: 'visually-hidden',
    attrs: { type: 'file', accept: 'application/json,.json' },
  }) as HTMLInputElement;

  backupInput.addEventListener('change', async () => {
    const file = backupInput.files?.[0];
    backupInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = parseBackupBundle(text);
      const result = await restoreBackupBundle(bundle, { targetGameId: gameId });
      notify.success(
        'Backup restored',
        `${result.saves} save(s), ${result.states} state(s) and ${result.cheats} cheat(s) added. Nothing that was already here was deleted.`,
      );
      refresh();
    } catch (error) {
      notify.error('Backup not restored', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  const header = el('div', {
    className: 'game-detail-head',
    children: [
      el('div', {
        className: 'cover-box',
        children: coverUrl
          ? [el('img', { attrs: { src: coverUrl, alt: `Cover art for ${title}` } })]
          : [
              el('div', {
                className: 'cover-placeholder',
                children: [
                  el('span', { text: 'No cover art' }),
                  el('span', {
                    className: 'small muted',
                    text: 'BrowserGBA never downloads box art. Add your own image if you want one.',
                  }),
                ],
              }),
            ],
      }),
      el('div', {
        className: 'game-detail-info',
        children: [
          el('h1', { text: title }),
          el('dl', {
            className: 'definition-list',
            children: [
              el('dt', { text: 'File' }),
              el('dd', { text: record.fileName }),
              el('dt', { text: 'Size' }),
              el('dd', { text: humanBytes(record.size) }),
              el('dt', { text: 'Game code' }),
              el('dd', { className: 'mono', text: record.gameCode ?? 'not in header' }),
              el('dt', { text: 'Content hash' }),
              el('dd', {
                className: 'mono small',
                text: record.contentHash,
                attrs: { title: 'Saves, states and cheats are tied to this hash' },
              }),
              el('dt', { text: 'Added' }),
              el('dd', { text: formatDateTime(record.addedAt) }),
              el('dt', { text: 'Last played' }),
              el('dd', { text: formatDateTime(record.lastPlayedAt) }),
              el('dt', { text: 'Total playtime' }),
              el('dd', { text: formatDuration(record.playtimeMs) }),
            ],
          }),
          record.warnings.length
            ? notice('warn', 'Import warnings', record.warnings.join(' '))
            : null,
          el('div', {
            className: 'btn-row',
            children: [
              el('button', {
                className: 'btn btn-primary',
                text: 'Play',
                attrs: { type: 'button' },
                on: { click: () => navigate(`/play/${encodeURIComponent(gameId)}`) },
              }),
              el('button', {
                className: 'btn',
                text: 'Rename / tag / notes',
                attrs: { type: 'button' },
                on: { click: () => void editMetadata() },
              }),
              el('button', {
                className: 'btn',
                text: coverUrl ? 'Replace cover' : 'Add cover image',
                attrs: { type: 'button' },
                on: { click: () => coverInput.click() },
              }),
              coverUrl
                ? el('button', {
                    className: 'btn',
                    text: 'Remove cover',
                    attrs: { type: 'button' },
                    on: {
                      click: async () => {
                        await removeCover(gameId);
                        notify.info('Cover removed');
                        refresh();
                      },
                    },
                  })
                : null,
              el('button', {
                className: 'btn',
                text: record.favourite ? '★ Favourite' : '☆ Favourite',
                attrs: { type: 'button', 'aria-pressed': String(record.favourite) },
                on: {
                  click: async () => {
                    await setFavourite(gameId, !record.favourite);
                    refresh();
                  },
                },
              }),
              el('button', {
                className: 'btn btn-danger',
                text: 'Remove game',
                attrs: { type: 'button' },
                on: { click: () => void removeEntry() },
              }),
            ],
          }),
        ],
      }),
    ],
  });

  function refresh(): void {
    void app.renderRoute();
  }

  async function editMetadata(): Promise<void> {
    const name = await promptDialog({
      title: 'Rename game',
      label: 'Display title',
      initialValue: title,
      maxLength: 80,
      description: 'This only changes how the game is listed here; the ROM file itself is untouched.',
    });
    if (name === null) return;

    const tagsText = await promptDialog({
      title: 'Tags',
      label: 'Tags (comma separated)',
      initialValue: record.tags.join(', '),
      maxLength: 200,
      description: 'Tags are stored with the game and can be used to filter the library.',
    });
    if (tagsText === null) return;

    const notes = await promptDialog({
      title: 'Notes',
      label: 'Notes for yourself',
      initialValue: record.notes,
      multiline: true,
      maxLength: 2000,
      description: 'Kept locally. Notes are plain text and are never rendered as HTML.',
    });
    if (notes === null) return;

    await updateGame(gameId, {
      customTitle: name.trim() || undefined,
      tags: tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 20),
      notes,
    });
    notify.success('Details updated');
    refresh();
  }

  async function removeEntry(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove ${title}?`,
      description:
        'This deletes the ROM, its battery saves, save states, cheats, screenshots and cover image from this browser. Export a backup first if you want to keep any of it.',
      confirmLabel: 'Remove everything',
      danger: true,
      requireChecks: [
        {
          id: 'backup',
          label: 'I have exported anything I want to keep',
          detail: 'Use “Export backup” below — it includes saves, states and cheats, but not the ROM.',
        },
      ],
    });
    if (!confirmed) return;
    await removeGame(gameId);
    notify.success('Game removed', 'Its saves, states and cheats were deleted with it.');
    navigate('/library');
  }

  // --- save states -------------------------------------------------------

  async function renderStates(): Promise<void> {
    const states = await saveStatesRepo.listForGame(gameId);
    statesHost.textContent = '';

    if (states.length === 0) {
      statesHost.appendChild(
        el('p', {
          className: 'muted',
          text: 'No save states yet. States are snapshots you control and never overwrite the game’s own battery save.',
        }),
      );
      return;
    }

    statesHost.appendChild(
      el('ul', {
        className: 'item-list',
        children: states.map((state) => {
          const thumbUrl = state.thumbnail ? makeUrl(state.thumbnail) : null;
          return el('li', {
            className: 'item-row',
            children: [
              thumbUrl ? el('img', { className: 'thumb', attrs: { src: thumbUrl, alt: '' } }) : null,
              el('div', {
                className: 'item-main',
                children: [
                  el('strong', { text: state.name }),
                  el('div', {
                    className: 'small muted',
                    text: `Slot ${state.slot} · ${formatDateTime(state.createdAt)} · ${humanBytes(state.size)} · ${state.coreName} ${state.coreVersion}`,
                  }),
                  state.romHash && state.romHash !== record.contentHash
                    ? el('span', {
                        className: 'badge badge-danger',
                        text: 'Different ROM — will not load',
                        attrs: { title: 'This state was captured with a different ROM and is kept only for reference.' },
                      })
                    : null,
                ],
              }),
              el('button', {
                className: 'btn btn-sm',
                text: 'Rename',
                attrs: { type: 'button' },
                on: {
                  click: async () => {
                    const name = await promptDialog({
                      title: 'Rename save state',
                      label: 'Name',
                      initialValue: state.name,
                      maxLength: 60,
                    });
                    if (name === null) return;
                    await saveStatesRepo.put({ ...state, name: name.trim() || state.name });
                    renderStates();
                  },
                },
              }),
              el('button', {
                className: 'btn btn-sm',
                text: 'Export',
                attrs: { type: 'button' },
                on: {
                  click: () =>
                    downloadBlob(
                      new Blob([state.bytes], { type: 'application/octet-stream' }),
                      `${safeStem(title)} - slot ${state.slot}.ss`,
                    ),
                },
              }),
              el('button', {
                className: 'btn btn-sm btn-danger',
                text: 'Delete',
                attrs: { type: 'button' },
                on: {
                  click: async () => {
                    const confirmed = await confirmDialog({
                      title: 'Delete this save state?',
                      description: 'Battery saves are not affected.',
                      confirmLabel: 'Delete',
                      danger: true,
                    });
                    if (!confirmed) return;
                    await saveStatesRepo.remove(state.id);
                    notify.info('Save state deleted');
                    renderStates();
                  },
                },
              }),
            ],
          });
        }),
      }),
    );
  }

  // --- battery saves -----------------------------------------------------

  async function renderSaves(): Promise<void> {
    const saves = await batterySavesRepo.listForGame(gameId);
    savesHost.textContent = '';

    if (saves.length === 0) {
      savesHost.appendChild(
        el('p', {
          className: 'muted',
          text: 'No battery save yet. In-game saves appear here the first time the game writes to its cartridge.',
        }),
      );
      return;
    }

    const labels: Record<string, string> = {
      auto: 'Automatic',
      manual: 'Manual',
      import: 'Imported',
      'pre-overwrite': 'Before an import',
    };

    savesHost.appendChild(
      el('ul', {
        className: 'item-list',
        children: saves.slice(0, 25).map((save) =>
          el('li', {
            className: 'item-row',
            children: [
              el('div', {
                className: 'item-main',
                children: [
                  el('strong', { text: labels[save.kind] ?? save.kind }),
                  el('div', {
                    className: 'small muted',
                    text: `${formatDateTime(save.savedAt)} · ${humanBytes(save.size)} · ${save.hash.slice(0, 12)}…${save.note ? ` · ${save.note}` : ''}`,
                  }),
                ],
              }),
              el('button', {
                className: 'btn btn-sm',
                text: 'Export',
                attrs: { type: 'button' },
                on: {
                  click: () =>
                    downloadBlob(
                      new Blob([save.bytes], { type: 'application/octet-stream' }),
                      `${safeStem(title)} - ${save.kind}.sav`,
                    ),
                },
              }),
              el('button', {
                className: 'btn btn-sm',
                text: 'Note',
                attrs: { type: 'button' },
                on: {
                  click: async () => {
                    const note = await promptDialog({
                      title: 'Note for this save',
                      label: 'Note',
                      initialValue: save.note ?? '',
                      maxLength: 120,
                      description: 'Useful for marking a known-good save before trying something risky.',
                    });
                    if (note === null) return;
                    await batterySavesRepo.put({ ...save, note: note.trim() || undefined });
                    renderSaves();
                  },
                },
              }),
            ],
          }),
        ),
      }),
    );
  }

  // --- cheats ------------------------------------------------------------

  async function renderCheats(): Promise<void> {
    const cheats = await cheatsRepo.listForGame(gameId);
    cheatsHost.textContent = '';

    const addButton = el('button', {
      className: 'btn btn-primary',
      text: 'Add cheat',
      attrs: { type: 'button' },
      on: { click: () => void addCheat() },
    });

    if (cheats.length === 0) {
      cheatsHost.appendChild(
        el('div', {
          children: [
            el('p', {
              className: 'muted',
              text: 'No cheats for this game. Cheats are stored per game and written to a file named after this ROM only, so a code can never leak into another title.',
            }),
            addButton,
          ],
        }),
      );
      return;
    }

    cheatsHost.appendChild(
      el('ul', {
        className: 'item-list',
        children: cheats.map((cheat) => {
          const toggle = el('input', {
            attrs: { type: 'checkbox', 'aria-label': `Enable ${cheat.label}` },
            props: { checked: cheat.enabled },
          }) as HTMLInputElement;
          toggle.addEventListener('change', async () => {
            await cheatsRepo.setEnabled(gameId, cheat.id, toggle.checked);
            notify.info(
              toggle.checked ? 'Cheat enabled' : 'Cheat disabled',
              `${cheat.label} — takes effect the next time you load this game.`,
            );
          });

          return el('li', {
            className: 'item-row',
            children: [
              toggle,
              el('div', {
                className: 'item-main',
                children: [
                  el('strong', { text: cheat.label }),
                  cheat.lastRejectedAt
                    ? el('span', {
                        className: 'badge badge-danger',
                        text: 'The emulator did not accept this code',
                        attrs: {
                          title: `${cheat.lastRejectedReason ?? 'Rejected by the core.'} Last checked ${formatDateTime(cheat.lastRejectedAt)}.`,
                        },
                      })
                    : null,
                  el('div', {
                    className: 'small muted',
                    children: [
                      `${CHEAT_FORMAT_LIST.find((format) => format.id === cheat.format)?.label ?? cheat.format} · `,
                      el('code', { text: cheat.code }),
                    ],
                  }),
                ],
              }),
              el('button', {
                className: 'btn btn-sm',
                text: 'Edit',
                attrs: { type: 'button' },
                on: {
                  click: async () => {
                    const result = await cheatEditor(cheat);
                    if (!result) return;
                    await cheatsRepo.put({ ...cheat, ...result, updatedAt: Date.now() });
                    notify.success('Cheat updated');
                    renderCheats();
                  },
                },
              }),
              el('button', {
                className: 'btn btn-sm btn-danger',
                text: 'Delete',
                attrs: { type: 'button' },
                on: {
                  click: async () => {
                    const confirmed = await confirmDialog({
                      title: 'Delete this cheat?',
                      description: `${cheat.label} will no longer be applied to this game.`,
                      confirmLabel: 'Delete',
                      danger: true,
                    });
                    if (!confirmed) return;
                    await cheatsRepo.remove(cheat.id);
                    renderCheats();
                  },
                },
              }),
            ],
          });
        }),
      }),
    );
    cheatsHost.appendChild(el('div', { className: 'btn-row', children: [addButton] }));
  }

  async function addCheat(): Promise<void> {
    const result = await cheatEditor();
    if (!result) return;
    await cheatsRepo.put({
      id: nextRecordId('cheat', gameId),
      gameId,
      label: result.label,
      code: result.code,
      format: result.format,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    notify.success('Cheat added', 'It will be applied the next time this game is loaded.');
    renderCheats();
  }

  /** Shared editor for adding and editing a single cheat line. */
  async function cheatEditor(
    initial?: { label: string; code: string; format: CheatFormat },
  ): Promise<{ label: string; code: string; format: CheatFormat } | null> {
    const labelInput = el('input', {
      attrs: { type: 'text', maxlength: 64, placeholder: 'e.g. Infinite rare candy' },
      props: { value: initial?.label ?? '' },
    }) as HTMLInputElement;

    const codeInput = el('textarea', {
      attrs: {
        rows: 3,
        maxlength: 400,
        placeholder: 'e.g. 82025BC4 000F423F',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocomplete: 'off',
      },
      props: { value: initial?.code ?? '' },
    }) as HTMLTextAreaElement;

    const formatSelect = el('select', {
      children: CHEAT_FORMAT_LIST.map((format) =>
        el('option', { text: format.label, attrs: { value: format.id } }),
      ),
    }) as HTMLSelectElement;
    formatSelect.value = initial?.format ?? 'gameShark';

    const hint = el('span', { className: 'field-hint' });
    const error = el('p', { className: 'field-error', attrs: { role: 'alert' } });

    function currentFormat(): CheatFormat {
      return formatSelect.value as CheatFormat;
    }

    function updateHint(): void {
      const info = CHEAT_FORMAT_LIST.find((format) => format.id === currentFormat());
      hint.textContent = info ? `${info.hint} Example: ${info.example}` : '';
    }
    updateHint();
    formatSelect.addEventListener('change', () => {
      updateHint();
      if (error.textContent) error.textContent = validate() ?? '';
    });

    /** Returns an error message, or null when the form is complete and valid. */
    function validate(): string | null {
      if (!sanitiseLabel(labelInput.value)) return 'Give the cheat a name so you can recognise it later.';
      const code = codeInput.value.trim();
      if (!code) return 'Enter the code exactly as it appears in the list you are copying it from.';
      const result = validateCheatCode(currentFormat(), code);
      if (!result.ok) {
        const first = result.errors[0];
        return first ? `Line ${first.line}: ${first.message}` : 'That code does not match the selected format.';
      }
      return null;
    }

    const form = el('div', {
      children: [
        el('div', { className: 'field', children: [el('label', { text: 'Name' }), labelInput] }),
        el('div', { className: 'field', children: [el('label', { text: 'Format' }), formatSelect] }),
        el('div', {
          className: 'field',
          children: [el('label', { text: 'Code' }), codeInput, hint],
        }),
        error,
      ],
    });

    const { handle, result } = openDialog({
      title: initial ? 'Edit cheat' : 'Add cheat',
      description:
        'Cheat text is data, never code: it is validated, stored with this game only, and never evaluated as JavaScript.',
      content: form,
      confirmLabel: 'Save cheat',
    });

    // The dialog resolves on confirm; a second listener lets us veto that click.
    const confirmButton = handle.element.querySelector<HTMLButtonElement>('[data-dialog-confirm]');
    confirmButton?.addEventListener(
      'click',
      (event) => {
        const problem = validate();
        if (!problem) return;
        event.stopImmediatePropagation();
        error.textContent = problem;
        (problem.startsWith('Line') ? codeInput : labelInput).focus();
      },
      { capture: true },
    );

    for (const input of [labelInput, codeInput]) {
      input.addEventListener('input', () => {
        if (error.textContent) error.textContent = validate() ?? '';
      });
    }

    const confirmed = await result;
    if (!confirmed) return null;
    const problem = validate();
    if (problem) {
      notify.error('Cheat not saved', problem);
      return null;
    }
    return { label: sanitiseLabel(labelInput.value), code: codeInput.value.trim(), format: currentFormat() };
  }

  // --- screenshots -------------------------------------------------------

  async function renderShots(): Promise<void> {
    const shots = await screenshotsRepo.listForGame(gameId);
    shotsHost.textContent = '';
    if (shots.length === 0) {
      shotsHost.appendChild(el('p', { className: 'muted', text: 'No screenshots yet. Press F9 or use the Screenshot button while playing.' }));
      return;
    }
    shotsHost.appendChild(
      el('div', {
        className: 'shot-grid',
        children: shots.slice(0, 24).map((shot) =>
          el('figure', {
            children: [
              el('img', { attrs: { src: makeUrl(shot.blob), alt: `Screenshot from ${formatRelativeTime(shot.createdAt)}`, width: 240, height: 160 } }),
              el('figcaption', {
                className: 'small muted',
                children: [
                  formatRelativeTime(shot.createdAt),
                  el('button', {
                    className: 'btn btn-sm',
                    text: 'Save',
                    attrs: { type: 'button' },
                    on: {
                      click: () =>
                        downloadBlob(shot.blob, `${safeStem(title)} - ${new Date(shot.createdAt).toISOString().slice(0, 19).replace(/[:.]/g, '-')}.png`),
                    },
                  }),
                  el('button', {
                    className: 'btn btn-sm',
                    text: 'Make cover',
                    attrs: { type: 'button' },
                    on: {
                      click: async () => {
                        const file = new File([shot.blob], 'cover.png', { type: shot.blob.type || 'image/png' });
                        try {
                          await setCover(gameId, file);
                          notify.success('Cover set from screenshot');
                          refresh();
                        } catch (error) {
                          notify.error('Could not set cover', error instanceof Error ? error.message : 'Unknown error');
                        }
                      },
                    },
                  }),
                ],
              }),
            ],
          }),
        ),
      }),
    );
  }

  // --- backup -----------------------------------------------------------

  async function exportBackup(): Promise<void> {
    try {
      const bundle = await buildBackupBundle(gameId);
      downloadBlob(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
        backupFileName(title),
      );
      notify.success(
        'Backup exported',
        `${bundle.saves.length} save(s), ${bundle.states.length} state(s) and ${bundle.cheats.length} cheat(s). The ROM itself is not included.`,
      );
    } catch (error) {
      notify.error('Could not export', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  await Promise.all([renderStates(), renderSaves(), renderCheats(), renderShots()]);
  const romPresent = (await getRomBytes(gameId)) !== null;

  const element = el('section', {
    className: 'view-game',
    children: [
      el('div', {
        className: 'view-header',
        children: [
          el('a', { className: 'btn btn-sm btn-ghost', text: '← Library', attrs: { href: '#/library' } }),
        ],
      }),
      header,
      coverInput,
      backupInput,
      !romPresent
        ? notice(
            'warn',
            'The ROM bytes for this entry are missing',
            'Saves, states and cheats are still here, but the game cannot be played until you import the file again.',
          )
        : null,
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'Save states' }),
          el('p', {
            className: 'small muted',
            text: 'Snapshots you control. Loading one never destroys the game’s own battery save.',
          }),
          statesHost,
        ],
      }),
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'Battery saves' }),
          el('p', {
            className: 'small muted',
            text: 'Automatic saves are written when the game’s save data changes; manual ones are triggered by you.',
          }),
          savesHost,
        ],
      }),
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'Cheats' }),
          el('p', {
            className: 'small muted',
            text: `These codes apply to ${title} only.`,
          }),
          cheatsHost,
        ],
      }),
      el('div', {
        className: 'card',
        children: [el('h2', { text: 'Screenshots' }), shotsHost],
      }),
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'Backup and restore' }),
          el('p', {
            className: 'small muted',
            text: `A backup is a JSON file with this game’s saves, states, cheats and details — never the ROM. Covers are accepted up to ${humanBytes(MAX_COVER_BYTES)} and 2048×2048.`,
          }),
          el('div', {
            className: 'btn-row',
            children: [
              el('button', {
                className: 'btn btn-primary',
                text: 'Export backup',
                attrs: { type: 'button' },
                on: { click: () => void exportBackup() },
              }),
              el('button', {
                className: 'btn',
                text: 'Restore backup',
                attrs: { type: 'button' },
                on: { click: () => backupInput.click() },
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
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.length = 0;
    },
  };
}

/** Conservative filename stem: no separators, no control characters. */
function safeStem(title: string): string {
  return (
    title
      .replace(/[^\w\d\-() ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'game'
  );
}
