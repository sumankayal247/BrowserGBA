/**
 * The "edit this game" dialog.
 *
 * One dialog, opened from the pencil on a library card and from the game screen, so
 * editing a name, a cover image, tags, notes or links always behaves the same way.
 * Cover images are handled by `@/storage/covers` (validated, downscaled to a
 * thumbnail and stored per game); everything else is written straight to the game
 * record.
 *
 * Links are whatever the user pastes. Nothing here vets destinations — see
 * `@/library/links` for the one rule that exists, which is about not letting a
 * pasted URL execute code.
 */
import { notify } from '@/ui/toast';
import { el } from '@/ui/dom';
import { openDialog } from '@/ui/dialog';
import {
  makeLink,
  MAX_LINK_LABEL_LENGTH,
  MAX_LINKS_PER_GAME,
  MAX_LINK_URL_LENGTH,
  normalizeLinks,
  type GameLink,
} from '@/library/links';
import {
  invalidateCoverUrl,
  MAX_COVER_BYTES,
  primeCoverUrl,
  removeCover,
  setCover,
} from '@/storage/covers';
import { updateGame, titleOf } from '@/library/library';
import type { GameRecord } from '@/storage/records';

export interface GameEditorOptions {
  game: GameRecord;
  /** Called after a successful save, so the caller can re-render. */
  onSaved?: () => void;
}

interface CoverState {
  blob: Blob | null;
  /** Set when the user picked a new file in this dialog. */
  pendingFile: File | null;
  removed: boolean;
}

/** Opens the editor. Resolves when the dialog closes. */
export async function openGameEditor({ game, onSaved }: GameEditorOptions): Promise<void> {
  const title = titleOf(game);
  const cover: CoverState = { blob: null, pendingFile: null, removed: false };

  // An existing cover is loaded lazily; the dialog opens immediately either way.
  void primeCoverUrl(game.id).then(async (url) => {
    if (url) {
      const response = await fetch(url).catch(() => null);
      const stored = response ? await response.blob().catch(() => null) : null;
      if (stored && !cover.pendingFile) {
        cover.blob = stored;
        renderCoverPreview();
      }
    }
  });

  const titleInput = el('input', {
    attrs: { type: 'text', maxlength: '80', id: 'edit-game-title', placeholder: 'Display title' },
    props: { value: title },
  });

  const coverHost = el('div', { className: 'cover-preview' });
  const coverInput = el('input', {
    className: 'visually-hidden',
    attrs: { type: 'file', accept: 'image/*', id: 'edit-game-cover' },
  });

  function renderCoverPreview(): void {
    const source = cover.pendingFile ?? (cover.removed ? null : cover.blob);
    const url = source instanceof File ? URL.createObjectURL(source) : null;
    const previewUrl = url ?? (cover.blob && !cover.removed && !cover.pendingFile ? currentCoverUrl : null);
    if (url) setTimeout(() => URL.revokeObjectURL(url), 10_000);
    if (!previewUrl) {
      coverHost.replaceChildren(
        el('div', { className: 'cover-placeholder', children: [el('span', { text: 'No cover art' })] }),
      );
      return;
    }
    coverHost.replaceChildren(
      el('img', { attrs: { src: previewUrl, alt: `Cover art for ${title}` } }),
    );
  }

  let currentCoverUrl: string | null = null;
  void primeCoverUrl(game.id).then((url) => {
    currentCoverUrl = url;
    if (!cover.pendingFile) {
      if (url && !cover.removed) coverHost.replaceChildren(el('img', { attrs: { src: url, alt: `Cover art for ${title}` } }));
    }
  });

  coverInput.addEventListener('change', () => {
    const file = coverInput.files?.[0];
    coverInput.value = '';
    if (!file) return;
    if (file.size > MAX_COVER_BYTES) {
      notify.warning('That image is too large', 'Cover images must be under 4 MiB. Pick a smaller file or resize it first.');
      return;
    }
    cover.pendingFile = file;
    cover.removed = false;
    const previewUrl = URL.createObjectURL(file);
    coverHost.replaceChildren(el('img', { attrs: { src: previewUrl, alt: 'Selected cover art' } }));
  });

  const coverButtons = el('div', {
    className: 'btn-row',
    children: [
      el('button', {
        className: 'btn btn-sm',
        text: cover.blob ? 'Replace image' : 'Add image',
        attrs: { type: 'button' },
        on: { click: () => coverInput.click() },
      }),
      el('button', {
        className: 'btn btn-sm',
        text: 'Remove image',
        attrs: { type: 'button' },
        on: {
          click: () => {
            cover.pendingFile = null;
            cover.removed = true;
            renderCoverPreview();
          },
        },
      }),
    ],
  });

  const tagsInput = el('input', {
    attrs: { type: 'text', maxlength: '200', placeholder: 'pokemon, romhack, favourite' },
    props: { value: game.tags.join(', ') },
  });

  const notesInput = el('textarea', {
    attrs: { rows: '3', maxlength: '2000', placeholder: 'Anything you want to remember' },
  });
  notesInput.value = game.notes ?? '';

  // --- links ---------------------------------------------------------------

  let links: GameLink[] = normalizeLinks(game.links);
  const linkList = el('div', { className: 'link-editor' });
  let linkCounter = links.length;

  function renderLinks(): void {
    if (links.length === 0) {
      linkList.replaceChildren(
        el('p', {
          className: 'small muted',
          text: 'No links yet. Paste any address you like — links are stored on this device and are never opened, checked or sent anywhere by the app.',
        }),
      );
      return;
    }
    linkList.replaceChildren(
      ...links.map((link, index) => {
        const labelInput = el('input', {
          attrs: {
            type: 'text',
            maxlength: String(MAX_LINK_LABEL_LENGTH),
            placeholder: 'Label (optional)',
            'aria-label': 'Link label',
          },
          props: { value: link.label },
        });
        const urlInput = el('input', {
          className: 'mono',
          attrs: {
            type: 'text',
            maxlength: String(MAX_LINK_URL_LENGTH),
            placeholder: 'example.com/page',
            inputmode: 'url',
            'aria-label': 'Link address',
          },
          props: { value: link.url },
        });
        // Read from the element on input rather than from the event, so the
        // handler signature stays the simple one `el()` accepts.
        labelInput.addEventListener('input', () => {
          links[index] = { ...links[index]!, label: labelInput.value };
        });
        urlInput.addEventListener('input', () => {
          links[index] = { ...links[index]!, url: urlInput.value };
        });
        return el('div', {
          className: 'link-row',
          children: [
            labelInput,
            urlInput,
            el('button', {
              className: 'btn btn-sm btn-icon',
              text: '✕',
              attrs: { type: 'button', 'aria-label': `Remove link ${index + 1}`, title: 'Remove link' },
              on: {
                click: () => {
                  links = links.filter((_, position) => position !== index);
                  renderLinks();
                },
              },
            }),
          ],
        });
      }),
    );
  }

  const addLinkButton = el('button', {
    className: 'btn btn-sm',
    text: 'Add link',
    attrs: { type: 'button' },
    on: {
      click: () => {
        if (links.length >= MAX_LINKS_PER_GAME) {
          notify.warning('Link limit reached', `A game can hold up to ${MAX_LINKS_PER_GAME} links.`);
          return;
        }
        linkCounter += 1;
        links = [...links, { id: `link-${linkCounter}-${Date.now().toString(36)}`, label: '', url: '' }];
        renderLinks();
        linkList.querySelector<HTMLInputElement>('.link-row:last-child input')?.focus();
      },
    },
  });

  renderLinks();
  renderCoverPreview();

  const content = el('div', {
    className: 'form-grid',
    children: [
      el('div', {
        className: 'field',
        children: [el('label', { text: 'Name', attrs: { for: 'edit-game-title' } }), titleInput,
          el('div', { className: 'small muted', text: `Imported as “${game.title}”. Changing this only affects how the game is listed here.` })],
      }),
      el('div', {
        className: 'field',
        children: [
          el('label', { text: 'Cover image', attrs: { for: 'edit-game-cover' } }),
          coverHost,
          coverButtons,
          el('div', { className: 'small muted', text: 'Stored on this device only. Images are checked and downscaled before saving.' }),
        ],
      }),
      el('div', {
        className: 'field',
        children: [el('label', { text: 'Tags' }), tagsInput],
      }),
      el('div', {
        className: 'field',
        children: [el('label', { text: 'Notes' }), notesInput],
      }),
      el('div', {
        className: 'field',
        children: [
          el('label', { text: 'Links' }),
          linkList,
          addLinkButton,
          el('div', {
            className: 'small muted',
            text: 'BrowserGBA does not filter, rank or verify links. What you paste is what you get — treat any link you did not write yourself with the same care as one in an email.',
          }),
        ],
      }),
      coverInput,
    ],
  });

  const { result } = openDialog({
    title: `Edit ${title}`,
    description: 'Everything here is stored in this browser. The ROM file itself is never modified.',
    content,
    confirmLabel: 'Save changes',
    cancelLabel: 'Cancel',
  });

  const confirmed = await result;
  if (!confirmed) return;

  // A half-filled row is dropped rather than saved as an empty link.
  const cleaned = normalizeLinks(
    links.map((link, index) => makeLink(link.id || `link-${index}`, link.label, link.url) ?? link).filter((link) => link.url.trim() !== ''),
  );

  await updateGame(game.id, {
    customTitle: titleInput.value.trim().slice(0, 80) || undefined,
    tags: tagsInput.value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 20),
    notes: notesInput.value.slice(0, 2000),
    links: cleaned,
  });

  try {
    if (cover.pendingFile) {
      await setCover(game.id, cover.pendingFile);
    } else if (cover.removed) {
      await removeCover(game.id);
    }
    invalidateCoverUrl(game.id);
    await primeCoverUrl(game.id);
  } catch (error) {
    notify.warning(
      'Saved, but the cover image could not be stored',
      error instanceof Error ? error.message : 'The image could not be processed.',
    );
    onSaved?.();
    return;
  }

  notify.success('Game updated', 'Name, cover and links are saved on this device.');
  onSaved?.();
}
