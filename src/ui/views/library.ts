/**
 * Library view: import, search, filter, sort, and per-game entry points.
 *
 * The import flow is deliberately a two-step process — prepare, then confirm —
 * so a duplicate can be reviewed (title, size, hash prefix, existing entry)
 * before anything is written.
 */
import { openGameEditor } from '@/ui/edit-game';
import { el, frag, humanBytes, formatRelativeTime, replace } from '@/ui/dom';
import { notify } from '@/ui/toast';
import { confirmDialog } from '@/ui/dialog';
import {
  ImportError,
  allTags,
  commitImport,
  importErrorMessage,
  listGames,
  prepareImport,
  removeGame,
  setFavourite,
  titleOf,
  type ImportCandidate,
  type LibraryQuery,
  type SortKey,
} from '@/library/library';
import type { GameRecord } from '@/storage/records';
import { formatDuration } from '@/storage/quota';
import { checkStorageHealth, isStoragePressure, storagePressureMessage } from '@/storage/support';
import { peekCoverUrl, primeCoversFor, releaseCoverUrls } from '@/storage/covers';
import type { ViewContext, ViewInstance } from '@/app/app';
import { notice } from '@/app/app';

/** ROMs are read in full, so cap what we are willing to pull into memory. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export async function renderLibraryView(context: ViewContext): Promise<ViewInstance> {
  const { app, navigate } = context;
  const objectUrls: string[] = [];

  const query: LibraryQuery = {
    search: '',
    sort: 'recent',
    favouritesOnly: false,
  };

  const toolbar = el('div', { className: 'toolbar' });
  const listHost = el('div');
  const fileInput = el('input', {
    className: 'visually-hidden',
    attrs: { type: 'file', accept: '.gba,application/octet-stream', multiple: true, id: 'rom-file-input' },
  });

  const importButton = el('button', {
    className: 'btn btn-primary',
    text: 'Import ROM',
    attrs: { type: 'button' },
    on: { click: () => fileInput.click() },
  });

  const dropzone = el('div', {
    className: 'dropzone',
    attrs: { 'data-dragover': 'false' },
    children: [
      el('p', { children: [el('strong', { text: 'Drop .gba files here' }), ' to import them.'] }),
      el('p', {
        className: 'small muted',
        text: 'Files are read locally and stored in this browser. Nothing is uploaded.',
      }),
      importButton,
    ],
  });

  // --- import ------------------------------------------------------------

  async function readFile(file: File): Promise<Uint8Array> {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async function importFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;

    const estimate = await checkStorageHealth().catch(() => null);
    if (estimate && isStoragePressure(estimate)) {
      notify.warning('Storage is nearly full', storagePressureMessage(estimate));
    }

    let imported = 0;
    const failures: string[] = [];

    for (const file of files) {
      try {
        imported += (await importOneFile(file)) ? 1 : 0;
      } catch (error) {
        failures.push(
          error instanceof ImportError
            ? `${file.name}: ${error.message}`
            : `${file.name}: ${error instanceof Error ? error.message : 'import failed'}`,
        );
      }
    }

    if (imported > 0) {
      notify.success(
        imported === 1 ? 'ROM imported' : `${imported} ROMs imported`,
        'Open a game to play it, add cheats, or set your own cover image.',
      );
    }
    for (const failure of failures) notify.error('Import failed', failure);
    await refresh();
  }

  async function importOneFile(file: File): Promise<boolean> {
    if (file.size > MAX_FILE_BYTES) {
      throw new ImportError(
        `${file.name} is ${humanBytes(file.size)}, larger than the 32 MiB a Game Boy Advance cartridge can address.`,
        'invalid-file',
      );
    }

    const bytes = await readFile(file);
    let candidate: ImportCandidate;
    try {
      candidate = await prepareImport({ name: file.name, size: file.size }, bytes);
    } catch (error) {
      throw error instanceof ImportError ? error : new ImportError(importErrorMessage(error), 'invalid-file');
    }

    if (candidate.warnings.length > 0 && !candidate.duplicate) {
      // Warnings are shown but never block import: a blank Nintendo logo is
      // normal for homebrew, and a trimmed ROM often still runs.
      notify.warning(`${candidate.title} imported with warnings`, candidate.warnings.join(' '));
    }

    if (candidate.duplicate) {
      const strategy = await askAboutDuplicate(candidate.duplicate, candidate);
      if (strategy === 'cancel') return false;
      await commitImport(candidate, { onDuplicate: strategy });
      return true;
    }

    await commitImport(candidate);
    return true;
  }

  async function askAboutDuplicate(
    existing: GameRecord,
    candidate: ImportCandidate,
  ): Promise<'replace' | 'cancel'> {
    const confirmed = await confirmDialog({
      title: 'This ROM is already in your library',
      description: 'The imported file has the same contents as an existing entry, so it is the same game.',
      confirmLabel: 'Replace existing entry',
      cancelLabel: 'Cancel import',
      content: el('dl', {
        className: 'definition-list',
        children: [
          el('dt', { text: 'Existing' }),
          el('dd', { text: `${titleOf(existing)} (${existing.fileName})` }),
          el('dt', { text: 'New file' }),
          el('dd', { text: candidate.fileName }),
          el('dt', { text: 'Content hash' }),
          el('dd', { className: 'mono', text: candidate.contentHash.slice(0, 32) }),
          el('dt', { text: 'Size' }),
          el('dd', { text: humanBytes(candidate.size) }),
        ],
      }),
    });

    if (!confirmed) return 'cancel';
    notify.info('Replaced existing entry', 'Play history, saves, states and cheats were kept.');
    return 'replace';
  }

  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void importFiles(files);
  });

  // Drag and drop (desktop).
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.setAttribute('data-dragover', 'true');
  });
  dropzone.addEventListener('dragleave', () => dropzone.setAttribute('data-dragover', 'false'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.setAttribute('data-dragover', 'false');
    const files = [...(event.dataTransfer?.files ?? [])];
    void importFiles(files);
  });

  // --- toolbar -----------------------------------------------------------

  const searchInput = el('input', {
    className: 'search',
    attrs: { type: 'search', placeholder: 'Search titles, filenames, codes or tags', 'aria-label': 'Search library' },
    on: {
      input: () => {
        query.search = searchInput.value;
        void refresh();
      },
    },
  });

  const sortSelect = el('select', {
    attrs: { 'aria-label': 'Sort games' },
    on: {
      change: () => {
        query.sort = sortSelect.value as SortKey;
        void refresh();
      },
    },
    children: [
      el('option', { text: 'Recently played', attrs: { value: 'recent' } }),
      el('option', { text: 'Recently added', attrs: { value: 'added' } }),
      el('option', { text: 'Title', attrs: { value: 'title' } }),
      el('option', { text: 'Most played', attrs: { value: 'playtime' } }),
    ],
  });
  sortSelect.value = query.sort ?? 'recent';

  const favouritesToggle = el('button', {
    className: 'btn',
    text: '★ Favourites',
    attrs: { type: 'button', 'aria-pressed': 'false' },
    on: {
      click: () => {
        query.favouritesOnly = !query.favouritesOnly;
        favouritesToggle.setAttribute('aria-pressed', String(query.favouritesOnly));
        void refresh();
      },
    },
  });

  const tagSelect = el('select', {
    attrs: { 'aria-label': 'Filter by tag' },
    on: {
      change: () => {
        query.tag = tagSelect.value || undefined;
        void refresh();
      },
    },
    children: [el('option', { text: 'All tags', attrs: { value: '' } })],
  });

  const viewToggle = el('button', {
    className: 'btn btn-icon',
    attrs: { type: 'button', 'aria-label': 'Switch between grid and list view', title: 'Grid / list' },
    text: app.settings.libraryView === 'list' ? '▤' : '▦',
    on: {
      click: () => {
        const next = app.settings.libraryView === 'list' ? 'grid' : 'list';
        viewToggle.textContent = next === 'list' ? '▤' : '▦';
        void app.updateSettings({ libraryView: next }).then(refresh);
      },
    },
  });

  replace(toolbar, [searchInput, sortSelect, tagSelect, favouritesToggle, viewToggle]);

  // --- list --------------------------------------------------------------

  function gameCard(game: GameRecord): HTMLElement {
    const art = el('div', { className: 'game-art' });
    const coverUrl = peekCoverUrl(game.id);
    if (coverUrl) {
      objectUrls.push(coverUrl);
      art.appendChild(el('img', { attrs: { src: coverUrl, alt: '' } }));
    } else {
      art.appendChild(
        el('span', {
          className: 'game-art-placeholder',
          text: game.gameCode?.slice(0, 2) || titleOf(game).slice(0, 2).toUpperCase(),
          attrs: { 'aria-hidden': 'true' },
        }),
      );
    }

    const favouriteButton = el('button', {
      className: 'btn btn-sm favourite-toggle',
      text: '★',
      attrs: {
        type: 'button',
        'aria-pressed': String(game.favourite),
        'aria-label': game.favourite ? `Remove ${titleOf(game)} from favourites` : `Add ${titleOf(game)} to favourites`,
        title: 'Favourite',
      },
      on: {
        click: async () => {
          const updated = await setFavourite(game.id, !game.favourite);
          favouriteButton.setAttribute('aria-pressed', String(updated.favourite));
          favouriteButton.setAttribute(
            'aria-label',
            updated.favourite ? `Remove ${titleOf(game)} from favourites` : `Add ${titleOf(game)} to favourites`,
          );
        },
      },
    });

    return el('article', {
      className: 'game-card',
      children: [
        art,
        el('div', {
          className: 'game-body',
          children: [
            el('h3', {
              className: 'game-title',
              children: [
                el('a', {
                  text: titleOf(game),
                  attrs: { href: `#/game/${encodeURIComponent(game.id)}` },
                }),
              ],
            }),
            el('div', {
              className: 'game-meta',
              children: [
                el('span', { text: humanBytes(game.size) }),
                el('span', { text: `played ${formatDuration(game.playtimeMs)}` }),
                el('span', { text: `last ${formatRelativeTime(game.lastPlayedAt)}` }),
                game.gameCode ? el('span', { className: 'mono', text: game.gameCode }) : null,
              ],
            }),
            game.tags.length
              ? el('div', {
                  className: 'game-tags',
                  children: game.tags.map((tag) => el('span', { className: 'tag', text: tag })),
                })
              : null,
            game.warnings.length
              ? el('span', {
                  className: 'badge badge-warn',
                  text: `${game.warnings.length} warning${game.warnings.length === 1 ? '' : 's'}`,
                  attrs: { title: game.warnings.join(' ') },
                })
              : null,
          ],
        }),
        el('div', {
          className: 'game-actions',
          children: [
            el('button', {
              className: 'btn btn-sm btn-primary',
              text: 'Play',
              attrs: { type: 'button' },
              on: { click: () => navigate(`/play/${encodeURIComponent(game.id)}`) },
            }),
            el('button', {
              className: 'btn btn-sm btn-icon',
              text: '✏',
              attrs: {
                type: 'button',
                'aria-label': `Edit ${titleOf(game)}: name, cover image and links`,
                title: 'Edit name, cover and links',
              },
              on: {
                click: () => {
                  void openGameEditor({ game, onSaved: () => void refresh() });
                },
              },
            }),
            el('button', {
              className: 'btn btn-sm',
              text: 'Details',
              attrs: { type: 'button' },
              on: { click: () => navigate(`/game/${encodeURIComponent(game.id)}`) },
            }),
            favouriteButton,
          ],
        }),
      ],
    });
  }

  async function refresh(): Promise<void> {
    const [games, tags] = await Promise.all([listGames(query), allTags()]);

    // Rebuild the tag filter without losing the current selection.
    const currentTag = tagSelect.value;
    replace(tagSelect, [
      el('option', { text: 'All tags', attrs: { value: '' } }),
      ...tags.map((tag) => el('option', { text: tag, attrs: { value: tag } })),
    ]);
    tagSelect.value = tags.includes(currentTag) ? currentTag : '';
    query.tag = tagSelect.value || undefined;

    if (games.length === 0) {
      const hasAny = (await listGames()).length > 0;
      replace(listHost, [
        el('div', {
          className: 'empty-state',
          children: hasAny
            ? [
                el('h2', { text: 'No games match' }),
                el('p', { text: 'Try a different search, or clear the filters.' }),
                el('button', {
                  className: 'btn',
                  text: 'Clear filters',
                  attrs: { type: 'button' },
                  on: {
                    click: () => {
                      searchInput.value = '';
                      query.search = '';
                      query.favouritesOnly = false;
                      query.tag = undefined;
                      favouritesToggle.setAttribute('aria-pressed', 'false');
                      tagSelect.value = '';
                      void refresh();
                    },
                  },
                }),
              ]
            : [
                el('h2', { text: 'Your library is empty' }),
                el('p', {
                  text: 'Import a Game Boy Advance ROM you own to get started. Files stay in this browser and are never uploaded.',
                }),
              ],
        }),
      ]);
      return;
    }

    // Covers are stored as blobs, so their object URLs are primed before the
    // cards are built; otherwise the first paint would show placeholders.
    await primeCoversFor(games.map((game) => game.id)).catch(() => undefined);

    const container = el('div', {
      className: app.settings.libraryView === 'list' ? 'library-list' : 'library-grid',
    });
    container.appendChild(frag(games.map((game) => gameCard(game))));
    replace(listHost, [container]);
  }

  await refresh();

  const health = await checkStorageHealth().catch(() => null);
  const banner =
    health && isStoragePressure(health, 0.8)
      ? notice('warn', 'Browser storage is filling up', storagePressureMessage(health))
      : null;

  const element = el('section', {
    children: [
      el('div', {
        className: 'view-header',
        children: [
          el('div', {
            children: [
              el('h1', { text: 'Library' }),
              el('p', {
                text: 'Your ROMs live in this browser only. Export backups from the Storage screen whenever you want a copy outside it.',
              }),
            ],
          }),
          importButton.cloneNode(true) as HTMLElement,
        ],
      }),
      banner,
      dropzone,
      fileInput,
      toolbar,
      listHost,
    ],
  });

  // Re-bind the cloned header button (cloneNode drops listeners).
  const headerButton = element.querySelector<HTMLButtonElement>('button.btn-primary');
  headerButton?.addEventListener('click', () => fileInput.click());

  const onWindowDragOver = (event: DragEvent) => event.preventDefault();
  globalThis.addEventListener('dragover', onWindowDragOver);

  return {
    element,
    dispose: () => {
      globalThis.removeEventListener('dragover', onWindowDragOver);
      for (const url of objectUrls) URL.revokeObjectURL(url);
      releaseCoverUrls();
      void removeGame;
    },
  };
}
