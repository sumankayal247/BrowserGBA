/**
 * Transient notifications.
 *
 * Toasts are announced through a live region so screen readers hear them, and
 * errors stay on screen longer than confirmations. Every message shown here is
 * written to be actionable, because "something went wrong" tells the user
 * nothing.
 */
import { el, replace, type Child } from './dom';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  kind?: ToastKind;
  /** Milliseconds before auto-dismiss. Errors default to staying until closed. */
  durationMs?: number;
  /** Optional action button, e.g. "Retry". */
  action?: { label: string; onClick: () => void };
}

const DURATIONS: Record<ToastKind, number> = {
  success: 4000,
  info: 5000,
  warning: 8000,
  error: 0, // 0 = keep until dismissed
};

let region: HTMLElement | null = null;

function getRegion(): HTMLElement {
  if (region && document.body.contains(region)) return region;
  region = el('div', {
    className: 'toast-region',
    attrs: {
      // `polite` so a passing confirmation does not interrupt a screen reader
      // mid-sentence, but errors use `assertive` (see below).
      'aria-live': 'polite',
      'aria-relevant': 'additions',
      role: 'status',
    },
  });
  document.body.appendChild(region);
  return region;
}

export function toast(title: string, body?: Child, options: ToastOptions = {}): () => void {
  const kind = options.kind ?? 'info';
  const duration = options.durationMs ?? DURATIONS[kind];
  const container = getRegion();

  const dismiss = () => {
    node.remove();
    if (container.childElementCount === 0) container.setAttribute('aria-live', 'polite');
  };

  const closeButton = el('button', {
    className: 'toast-close',
    text: '✕',
    attrs: { type: 'button', 'aria-label': 'Dismiss notification' },
    on: { click: dismiss },
  });

  const actionButton = options.action
    ? el('button', {
        className: 'btn btn-sm',
        text: options.action.label,
        attrs: { type: 'button' },
        on: {
          click: () => {
            options.action?.onClick();
            dismiss();
          },
        },
      })
    : null;

  const node = el('div', {
    className: 'toast',
    attrs: {
      'data-kind': kind,
      // Errors are announced immediately; everything else waits its turn.
      role: kind === 'error' ? 'alert' : 'status',
      'aria-live': kind === 'error' ? 'assertive' : 'polite',
    },
    children: [
      el('div', {
        className: 'item-main',
        children: [
          el('strong', { text: title }),
          body ? el('div', { className: 'small muted', children: [body] }) : null,
          actionButton,
        ],
      }),
      closeButton,
    ],
  });

  container.appendChild(node);

  if (duration > 0) {
    const timer = setTimeout(dismiss, duration);
    node.addEventListener('mouseenter', () => clearTimeout(timer));
  }

  return dismiss;
}

export const notify = {
  success: (title: string, body?: Child, options: ToastOptions = {}) =>
    toast(title, body, { ...options, kind: 'success' }),
  info: (title: string, body?: Child, options: ToastOptions = {}) =>
    toast(title, body, { ...options, kind: 'info' }),
  warning: (title: string, body?: Child, options: ToastOptions = {}) =>
    toast(title, body, { ...options, kind: 'warning' }),
  error: (title: string, body?: Child, options: ToastOptions = {}) =>
    toast(title, body, { ...options, kind: 'error' }),
};

/** Test helper: removes all toasts. */
export function clearToasts(): void {
  region?.remove();
  region = null;
  void replace;
}
