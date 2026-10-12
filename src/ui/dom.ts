/**
 * Minimal DOM helpers.
 *
 * Deliberately tiny and dependency-free: this app renders a handful of screens,
 * so a full framework would cost more (bundle size, build complexity, licence
 * surface) than it saves. Everything here is safe by construction — text is
 * always set as text, never as HTML, so imported ROM titles and user notes can
 * never be interpreted as markup.
 */

export type Child = Node | string | number | null | undefined | false;

export interface ElementOptions {
  className?: string;
  text?: string;
  /** Applied with `setAttribute`, so `aria-*` and `data-*` work naturally. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** Applied as DOM properties (value, checked, disabled, ...). */
  props?: Record<string, unknown>;
  children?: Child[];
  on?: Partial<Record<keyof HTMLElementEventMap, (event: never) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyOptions(node, options);
  return node;
}

/** Builds a document fragment, ignoring null/false children. */
export function frag(children: Child[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

export function applyOptions(node: HTMLElement, options: ElementOptions): void {
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;

  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [key, value] of Object.entries(options.props ?? {})) {
    (node as unknown as Record<string, unknown>)[key] = value;
  }
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(event, handler as EventListener);
  }
  if (options.children) appendChildren(node, options.children);
}

export function appendChildren(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Replaces a container's contents with new nodes. */
export function replace(container: Element, children: Child[]): void {
  container.textContent = '';
  appendChildren(container, children);
}

export function clear(container: Element): void {
  container.textContent = '';
}

/** Finds a required element, failing loudly during development if it is absent. */
export function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Expected to find ${selector}`);
  return found;
}

export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  event: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(event, handler as EventListener, options);
  return () => target.removeEventListener(event, handler as EventListener, options);
}

// --- formatting ------------------------------------------------------------

export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

export function formatRelativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return 'never';
  const diff = now - timestamp;
  if (diff < 0) return formatDateTime(timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return formatDateTime(timestamp);
}

/** Bytes as a short human string. */
export function humanBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Filename-safe version of a title for downloads.
 *
 * Deliberately conservative: only letters, digits, spaces, dashes, underscores
 * and parentheses survive, so nothing can escape a download folder or inject a
 * path separator.
 */
export function safeFileName(title: string, extension: string, suffix = ''): string {
  const base = title
    .replace(/[^\w\d\-() ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const parts = [base || 'game'];
  if (suffix) parts.push(suffix);
  parts.push(stamp);
  return `${parts.join(' - ')}.${extension}`;
}

/** Triggers a download without leaking an object URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { props: { href: url, download: fileName } });
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
