/**
 * Per-game links: whatever the user pastes.
 *
 * Deliberately *not* a content filter. BrowserGBA does not judge, rank, resolve,
 * verify or police where a user-supplied link points — that decision belongs to the
 * person who pasted it, and the app never fetches these URLs, so it cannot know
 * anything about them anyway. Nothing here checks for "allowed" or "disallowed"
 * sites, and there is no list of permitted destinations to maintain.
 *
 * The one thing that is enforced is execution safety, which is a different
 * question from content policy: a URL is only ever put into an `href` when the
 * browser can safely navigate to it. `javascript:` and `data:` URLs are not
 * navigation targets, they are code/HTML injection, so a user who pastes one gets
 * it displayed as plain text instead of an active link. Nothing is rejected,
 * rewritten away or hidden — the text is kept exactly as typed.
 */

/** One link attached to a game by the user. */
export interface GameLink {
  id: string;
  /** What the user wants to call it. Falls back to the URL for display. */
  label: string;
  /** Stored verbatim, apart from trimming. Never fetched by the app. */
  url: string;
}

/** Longest URL the UI accepts; longer input is truncated rather than rejected. */
export const MAX_LINK_URL_LENGTH = 2000;
/** Longest custom label kept; longer input is truncated. */
export const MAX_LINK_LABEL_LENGTH = 80;
/** How many links one game may hold. */
export const MAX_LINKS_PER_GAME = 50;

/**
 * Schemes that must never reach an `href`.
 *
 * These are not "bad sites" — they are URLs the browser would *execute* instead of
 * visiting, which is the mechanism behind self-XSS via pasted links. Everything
 * else, including unusual schemes like `steam:`, `ipfs:`, `magnet:` or a custom app
 * protocol, is left alone and rendered as a normal link.
 */
const NON_NAVIGABLE_SCHEMES = new Set(['javascript', 'data', 'vbscript']);

/** Scheme of a URL, lower-cased, or `''` when there is none (relative/schemeless). */
export function linkScheme(url: string): string {
  const match = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  return match ? match[1]!.toLowerCase() : '';
}

/** True when the URL may be used as an `href` in the page. */
export function isNavigableUrl(url: string): boolean {
  const scheme = linkScheme(url);
  if (scheme === '') return false; // Nothing to navigate to (empty or a bare fragment).
  return !NON_NAVIGABLE_SCHEMES.has(scheme);
}

/**
 * Normalises what the user pasted, without changing where it points.
 *
 * A bare `example.com/page` gets an `https://` prefix because that is almost always
 * meant as a web address. Anything that already has a scheme — including one this
 * app has never heard of — is kept exactly as typed.
 */
export function normalizeLinkUrl(input: string): string {
  const trimmed = input.trim().slice(0, MAX_LINK_URL_LENGTH);
  if (trimmed === '') return '';
  if (linkScheme(trimmed) !== '') return trimmed;
  // A leading slash or dot means an in-app/relative path, which is not a link.
  if (/^[/.#?]/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** The host, for display only. Falls back to the raw string when there is no host. */
export function linkHost(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  if (!match) return url.trim();
  return match[1]!.replace(/^www\./i, '');
}

/** What to show for a link when the user did not name it. */
export function linkDisplayLabel(link: GameLink): string {
  const label = link.label.trim();
  if (label !== '') return label;
  return linkHost(link.url) || link.url;
}

/**
 * Builds a stored link from raw user input. Returns `null` only when there is
 * nothing to store (an empty URL after trimming) — never because of *where* it points.
 */
export function makeLink(id: string, label: string, url: string): GameLink | null {
  const normalized = normalizeLinkUrl(url);
  if (normalized === '') return null;
  return { id, label: label.trim().slice(0, MAX_LINK_LABEL_LENGTH), url: normalized };
}

/**
 * Keeps stored links usable after a hand-edited record, an older schema or a backup
 * bundle: drops entries with no URL, trims the rest and caps the list. Order is
 * preserved.
 */
export function normalizeLinks(input: unknown): GameLink[] {
  if (!Array.isArray(input)) return [];
  const out: GameLink[] = [];
  for (const [index, entry] of input.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<GameLink>;
    if (typeof raw.url !== 'string') continue;
    const link = makeLink(
      typeof raw.id === 'string' && raw.id !== '' ? raw.id : `link-${index}`,
      typeof raw.label === 'string' ? raw.label : '',
      raw.url,
    );
    if (link) out.push(link);
    if (out.length >= MAX_LINKS_PER_GAME) break;
  }
  return out;
}

/**
 * Opens a user-supplied link in a new tab.
 *
 * `noopener` and `noreferrer` keep the linked page away from this one's window
 * reference; `nofollow` makes it explicit that BrowserGBA is not endorsing it.
 * Returns `false` for a URL that must be shown as text instead (see above).
 */
export function openExternalLink(url: string, features = 'noopener,noreferrer'): boolean {
  if (!isNavigableUrl(url)) return false;
  globalThis.open?.(url, '_blank', features);
  return true;
}
