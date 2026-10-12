/**
 * Storage view: what is on this device and how to get it out.
 *
 * The privacy promise ("your data stays here") is only honest if the user can
 * see it and take it with them, so this screen lists real numbers and provides
 * working exports — including a full-library backup with no ROMs in it.
 */
import { el, humanBytes, formatDateTime, downloadBlob, replace } from '@/ui/dom';
import { notify } from '@/ui/toast';
import { confirmDialog, openDialog } from '@/ui/dialog';
import { gamesRepo, screenshotsRepo, saveStatesRepo, cheatsRepo, batterySavesRepo } from '@/storage/records';
import { STORE, count, transact, request } from '@/storage/db';
import { estimateStorage, formatBytes, formatDuration, requestPersistentStorage } from '@/storage/quota';
import { listGames, titleOf } from '@/library/library';
import { buildBackupBundle, backupFileName, parseBackupBundle, restoreBackupBundle } from '@/storage/backup';
import { getCover, releaseCoverUrls } from '@/storage/covers';
import { notice, type ViewContext, type ViewInstance } from '@/app/app';

interface UsageRow {
  label: string;
  detail: string;
  bytes: number | null;
  count: number;
}

export async function renderStorageView(context: ViewContext): Promise<ViewInstance> {
  const { app, navigate } = context;
  const estimate = await estimateStorage();
  const games = await listGames();
  const rowsHost = el('div');
  const detailHost = el('div');
  const importInput = el('input', {
    className: 'visually-hidden',
    attrs: { type: 'file', accept: 'application/json,.json', multiple: true },
  }) as HTMLInputElement;

  async function collectUsage(): Promise<UsageRow[]> {
    const romsCount = await count(STORE.roms);
    const savesCount = await count(STORE.batterySaves);
    const statesCount = await count(STORE.saveStates);
    const cheatsCount = await count(STORE.cheats);
    const shotsCount = await count(STORE.screenshots);
    const coversCount = await count(STORE.covers);

    // Blob and ArrayBuffer sizes are the honest measure of what a record costs,
    // so they are summed from the records rather than estimated.
    const romBytes = games.reduce((total, game) => total + game.size, 0);

    const saveBytes = await sumBytes<{ bytes: ArrayBuffer }>(STORE.batterySaves, (row) => row.bytes?.byteLength ?? 0);
    const stateBytes = await sumBytes<{ bytes: ArrayBuffer; thumbnail: Blob | null }>(
      STORE.saveStates,
      (row) => (row.bytes?.byteLength ?? 0) + (row.thumbnail?.size ?? 0),
    );
    const shotBytes = await sumBytes<{ blob: Blob }>(STORE.screenshots, (row) => row.blob?.size ?? 0);
    const coverBytes = await sumBytes<{ blob: Blob }>(STORE.covers, (row) => row.blob?.size ?? 0);

    return [
      {
        label: 'ROM images',
        detail: `${romsCount} file${romsCount === 1 ? '' : 's'} — the largest part of your library`,
        bytes: romBytes,
        count: romsCount,
      },
      {
        label: 'Battery saves',
        detail: `${savesCount} generation${savesCount === 1 ? '' : 's'} of in-game save data`,
        bytes: saveBytes,
        count: savesCount,
      },
      {
        label: 'Save states',
        detail: `${statesCount} snapshot${statesCount === 1 ? '' : 's'}, including thumbnails`,
        bytes: stateBytes,
        count: statesCount,
      },
      {
        label: 'Cheats',
        detail: `${cheatsCount} code${cheatsCount === 1 ? '' : 's'} (text only, effectively free)`,
        bytes: null,
        count: cheatsCount,
      },
      {
        label: 'Screenshots',
        detail: `${shotsCount} image${shotsCount === 1 ? '' : 's'} at 240×160 PNG`,
        bytes: shotBytes,
        count: shotsCount,
      },
      {
        label: 'Cover art',
        detail: `${coversCount} image${coversCount === 1 ? '' : 's'} you supplied`,
        bytes: coverBytes,
        count: coversCount,
      },
    ];
  }

  async function sumBytes<T>(store: (typeof STORE)[keyof typeof STORE], size: (row: T) => number): Promise<number> {
    try {
      const rows = await transact(store, 'readonly', (tx) => request<T[]>(tx.objectStore(store).getAll()));
      return rows.reduce((total, row) => total + size(row), 0);
    } catch {
      return 0;
    }
  }

  async function renderUsage(): Promise<void> {
    const rows = await collectUsage();
    const measured = rows.reduce((total, row) => total + (row.bytes ?? 0), 0);

    const table = el('div', {
      className: 'usage-table',
      children: rows.map((row) =>
        el('div', {
          className: 'usage-row',
          children: [
            el('div', {
              className: 'item-main',
              children: [
                el('strong', { text: row.label }),
                el('span', { className: 'small muted', text: row.detail }),
              ],
            }),
            el('span', { className: 'mono', text: row.bytes === null ? `${row.count}` : humanBytes(row.bytes) }),
          ],
        }),
      ),
    });

    const quotaLine = estimate.supported
      ? el('p', {
          children: [
            el('strong', { text: `${formatBytes(estimate.usage)} used` }),
            ` of ${formatBytes(estimate.quota, 'an unreported quota')} available to this site. Records you can see account for ${humanBytes(measured)}. `,
            estimate.persisted
              ? 'The browser has agreed to keep this data.'
              : 'The browser has not agreed to keep this data, so it may be cleared when space runs low.',
          ],
        })
      : el('p', {
          text: 'This browser does not report a storage quota. Exports still work, and they are the only copy that survives clearing site data.',
        });

    replace(rowsHost, [quotaLine, table]);
  }

  // --- per-game detail ---------------------------------------------------

  async function renderDetail(): Promise<void> {
    if (games.length === 0) {
      replace(detailHost, [
        notice('info', 'Nothing stored yet', 'Import a ROM to start building your library.'),
      ]);
      return;
    }

    const rows = await Promise.all(
      games.map(async (game) => {
        const [saves, states, cheats, shots] = await Promise.all([
          batterySavesRepo.listForGame(game.id),
          saveStatesRepo.listForGame(game.id),
          cheatsRepo.listForGame(game.id),
          screenshotsRepo.listForGame(game.id),
        ]);
        return el('li', {
          className: 'item-row',
          children: [
            el('div', {
              className: 'item-main',
              children: [
                el('strong', { text: titleOf(game) }),
                el('div', {
                  className: 'small muted',
                  text: `${humanBytes(game.size)} · ${saves.length} save(s) · ${states.length} state(s) · ${cheats.length} cheat(s) · ${shots.length} screenshot(s) · played ${formatDuration(game.playtimeMs)}`,
                }),
                el('div', {
                  className: 'small faint',
                  text: `Added ${formatDateTime(game.addedAt)} · hash ${game.contentHash.slice(0, 16)}…`,
                }),
              ],
            }),
            el('button', {
              className: 'btn btn-sm',
              text: 'Back up',
              attrs: { type: 'button' },
              on: {
                click: async () => {
                  const bundle = await buildBackupBundle(game.id);
                  downloadBlob(
                    new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
                    backupFileName(titleOf(game)),
                  );
                  notify.success('Backup downloaded', `${bundle.saves.length} save(s) and ${bundle.states.length} state(s).`);
                },
              },
            }),
            el('button', {
              className: 'btn btn-sm',
              text: 'Details',
              attrs: { type: 'button' },
              on: { click: () => navigate(`/game/${encodeURIComponent(game.id)}`) },
            }),
          ],
        });
      }),
    );

    replace(detailHost, [el('ul', { className: 'item-list', children: rows })]);
  }

  // --- whole-library backup ---------------------------------------------

  async function exportLibrary(): Promise<void> {
    if (games.length === 0) {
      notify.warning('Nothing to export', 'Your library is empty.');
      return;
    }
    try {
      const bundles = [];
      for (const game of games) bundles.push(await buildBackupBundle(game.id));
      const payload = {
        format: 'browsergba.library',
        version: 1,
        exportedAt: new Date().toISOString(),
        note: 'Contains saves, save states, cheat codes and library details. ROM images are deliberately excluded.',
        games: bundles,
      };
      downloadBlob(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        `BrowserGBA library backup ${new Date().toISOString().slice(0, 10)}.json`,
      );
      notify.success(
        'Library exported',
        `${bundles.length} game(s) with saves, states and cheats. ROMs are never included, so you must keep your own copies of those files.`,
      );
    } catch (error) {
      notify.error('Export failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  importInput.addEventListener('change', async () => {
    const files = [...(importInput.files ?? [])];
    importInput.value = '';
    if (files.length === 0) return;

    let restored = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        const text = await file.text();
        const trimmed = text.trim();
        if (trimmed.startsWith('{') && trimmed.includes('"browsergba.library"')) {
          const parsed = JSON.parse(trimmed) as { games?: unknown[] };
          for (const entry of parsed.games ?? []) {
            const bundle = parseBackupBundle(JSON.stringify(entry));
            const result = await restoreBackupBundle(bundle);
            restored += result.states + result.saves;
          }
        } else {
          const bundle = parseBackupBundle(trimmed);
          const result = await restoreBackupBundle(bundle);
          restored += result.states + result.saves;
        }
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : 'import failed'}`);
      }
    }

    if (restored > 0) notify.success('Backup restored', `${restored} record(s) added.`);
    for (const failure of failures) notify.error('Could not restore', failure);
    await app.renderRoute();
  });

  // --- maintenance -------------------------------------------------------

  async function clearScreenshots(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Delete all screenshots?',
      description: 'Saves, states and cheats are not affected.',
      confirmLabel: 'Delete screenshots',
      danger: true,
    });
    if (!confirmed) return;
    const rows = await transact(STORE.screenshots, 'readonly', (tx) => request<Array<{ id: string }>>(tx.objectStore(STORE.screenshots).getAll()));
    for (const row of rows) await screenshotsRepo.remove(row.id);
    notify.info('Screenshots deleted', `${rows.length} removed.`);
    await renderAll();
  }

  async function clearCovers(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Delete all cover images?',
      description: 'Games keep their saves and details; only the pictures are removed.',
      confirmLabel: 'Delete covers',
      danger: true,
    });
    if (!confirmed) return;
    const rows = await transact(STORE.covers, 'readonly', (tx) => request<Array<{ gameId: string }>>(tx.objectStore(STORE.covers).getAll()));
    for (const row of rows) {
      const cover = await getCover(row.gameId);
      if (cover) {
        await transact(STORE.covers, 'readwrite', (tx) => request(tx.objectStore(STORE.covers).delete(row.gameId)));
      }
    }
    releaseCoverUrls();
    notify.info('Cover images deleted');
    await renderAll();
  }

  async function pruneAutoSaves(): Promise<void> {
    const gamesToPrune = await gamesRepo.all();
    let removed = 0;
    for (const game of gamesToPrune) removed += await batterySavesRepo.pruneAuto(game.id, 2);
    notify.info('Old automatic saves removed', `${removed} record(s). Manual saves and imports are never pruned automatically.`);
    await renderAll();
  }

  function renderMaintenance(): HTMLElement {
    return el('div', {
      className: 'btn-row',
      children: [
        el('button', {
          className: 'btn',
          text: 'Export whole library',
          attrs: { type: 'button' },
          on: { click: () => void exportLibrary() },
        }),
        el('button', {
          className: 'btn',
          text: 'Restore backup files',
          attrs: { type: 'button' },
          on: { click: () => importInput.click() },
        }),
        el('button', {
          className: 'btn',
          text: 'Keep storage permanently',
          attrs: { type: 'button' },
          on: {
            click: async () => {
              const granted = await requestPersistentStorage();
              notify.info(granted ? 'Storage will be kept' : 'The browser declined', granted ? 'Data will not be cleared automatically.' : 'Back up anything important.');
              await renderAll();
            },
          },
        }),
        el('button', {
          className: 'btn',
          text: 'Prune old automatic saves',
          attrs: { type: 'button' },
          on: { click: () => void pruneAutoSaves() },
        }),
        el('button', {
          className: 'btn',
          text: 'Delete screenshots',
          attrs: { type: 'button' },
          on: { click: () => void clearScreenshots() },
        }),
        el('button', {
          className: 'btn',
          text: 'Delete cover images',
          attrs: { type: 'button' },
          on: { click: () => void clearCovers() },
        }),
      ],
    });
  }

  async function renderAll(): Promise<void> {
    await renderUsage();
    await renderDetail();
  }

  await renderAll();

  const element = el('section', {
    className: 'view-storage',
    children: [
      el('h1', { text: 'Storage' }),
      el('p', {
        text: 'Everything BrowserGBA stores lives in this browser’s IndexedDB. There is no server, no account and no upload.',
      }),
      el('div', { className: 'card', children: [el('h2', { text: 'What is taking up space' }), rowsHost] }),
      el('div', { className: 'card', children: [el('h2', { text: 'Backup and restore' }), renderMaintenance()] }),
      el('div', { className: 'card', children: [el('h2', { text: 'Your games' }), detailHost] }),
      importInput,
      el('div', {
        className: 'card',
        children: [
          el('h2', { text: 'How to keep your progress safe' }),
          el('ul', {
            children: [
              el('li', { text: 'Export a backup after a milestone. Backups contain saves, states and cheats but never the ROM.' }),
              el('li', { text: 'Keep your ROM files yourself — this app cannot re-download them, by design.' }),
              el('li', { text: 'Clearing site data in the browser removes everything here. Nothing is recoverable afterwards.' }),
              el('li', { text: 'Private/incognito windows may discard storage as soon as the window closes.' }),
            ],
          }),
        ],
      }),
    ],
  });

  return {
    element,
    dispose: () => {
      importInput.value = '';
      void openDialog;
    },
  };
}
