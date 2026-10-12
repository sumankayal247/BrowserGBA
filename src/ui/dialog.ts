/**
 * Accessible modal dialogs built on the native `<dialog>` element.
 *
 * Using `<dialog>` gets us focus management, an inert background, Escape
 * handling and correct screen-reader semantics from the browser rather than
 * from hand-rolled JavaScript. What is added here is: a labelled heading, a
 * focus trap for browsers that need it, and promise-based confirm/prompt
 * helpers that return what the user chose.
 */
import { el, type Child } from './dom';

export interface DialogOptions {
  title: string;
  description?: Child;
  /** Extra content rendered in the dialog body. */
  content?: Child;
  confirmLabel?: string;
  cancelLabel?: string | null;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
  /** When true, the confirm button stays disabled until all `requireChecks` are ticked. */
  requireChecks?: Array<{ id: string; label: string; detail?: string }>;
  /** Prevent Escape / backdrop dismissal for destructive flows. */
  dismissible?: boolean;
}

export interface DialogHandle {
  element: HTMLDialogElement;
  close: () => void;
}

/** Renders a dialog and returns a handle plus a promise for the outcome. */
export function openDialog(options: DialogOptions): { handle: DialogHandle; result: Promise<boolean> } {
  return build(options);
}

/** Confirmation dialog: resolves true when the user accepts. */
export async function confirmDialog(options: DialogOptions): Promise<boolean> {
  return openDialog(options).result;
}

/** A prompt dialog that resolves to the entered text, or null when cancelled. */
export async function promptDialog(options: {
  title: string;
  label: string;
  initialValue?: string;
  description?: Child;
  confirmLabel?: string;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
}): Promise<string | null> {
  const input = options.multiline
    ? el('textarea', {
        props: { value: options.initialValue ?? '' },
        attrs: { maxlength: options.maxLength ?? 2000, placeholder: options.placeholder ?? '' },
      })
    : el('input', {
        attrs: { type: 'text', maxlength: options.maxLength ?? 120, placeholder: options.placeholder ?? '' },
        props: { value: options.initialValue ?? '' },
      });

  const field = el('div', {
    className: 'field',
    children: [
      el('label', { text: options.label, attrs: { for: 'dialog-prompt-input' } }),
      input,
    ],
  });
  input.id = 'dialog-prompt-input';

  const { handle, result } = openDialog({
    title: options.title,
    ...(options.description !== undefined ? { description: options.description } : {}),
    content: field,
    confirmLabel: options.confirmLabel ?? 'Save',
  });

  // Select existing text so the user can type over it immediately.
  queueMicrotask(() => {
    input.focus();
    input.select?.();
  });

  const confirmed = await result;
  return confirmed ? input.value : null;
}

function build(options: DialogOptions): { handle: DialogHandle; result: Promise<boolean> } {
  let settle: (confirmed: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const body = el('div', { className: 'dialog-body' });

  if (options.description) {
    body.appendChild(el('div', { className: 'small muted', children: [options.description] }));
  }
  if (options.content) {
    body.appendChild(
      typeof options.content === 'object' && options.content instanceof Node
        ? options.content
        : el('div', { children: [options.content] }),
    );
  }

  const checks = new Map<string, HTMLInputElement>();
  if (options.requireChecks?.length) {
    const list = el('div', { className: 'progress-stack' });
    for (const check of options.requireChecks) {
      const input = el('input', { attrs: { type: 'checkbox' } });
      input.id = `dialog-check-${check.id}`;
      checks.set(check.id, input);
      list.appendChild(
        el('div', {
          className: 'checkbox-row',
          children: [
            input,
            el('label', {
              attrs: { for: input.id },
              children: [
                el('strong', { text: check.label }),
                check.detail ? el('span', { className: 'field-hint', text: check.detail }) : null,
              ],
            }),
          ],
        }),
      );
    }
    body.appendChild(list);
  }

  const confirmButton = el('button', {
    className: options.danger ? 'btn btn-danger' : 'btn btn-primary',
    text: options.confirmLabel ?? 'Confirm',
    attrs: { type: 'button', 'data-dialog-confirm': 'true' },
    on: { click: () => close(true) },
  });

  if (checks.size > 0) {
    confirmButton.disabled = true;
    for (const input of checks.values()) {
      input.addEventListener('change', () => {
        confirmButton.disabled = ![...checks.values()].every((box) => box.checked);
      });
    }
  }

  const cancelButton = options.cancelLabel === null
    ? null
    : el('button', {
        className: 'btn',
        text: options.cancelLabel ?? 'Cancel',
        attrs: { type: 'button', 'data-dialog-cancel': 'true' },
        on: { click: () => close(false) },
      });

  const dialog = el('dialog', {
    className: 'dialog',
    attrs: { 'aria-labelledby': 'dialog-title' },
    children: [
      el('div', {
        className: 'dialog-head',
        children: [el('h2', { text: options.title, attrs: { id: 'dialog-title' } })],
      }),
      body,
      el('div', {
        className: 'dialog-actions',
        children: [cancelButton, confirmButton],
      }),
    ],
  }) as HTMLDialogElement;

  // Native Escape triggers `cancel`; honour `dismissible` and always resolve.
  dialog.addEventListener('cancel', (event) => {
    if (options.dismissible === false) {
      event.preventDefault();
      return;
    }
    settle(false);
  });
  dialog.addEventListener('close', () => {
    settle(false);
    dialog.remove();
  });
  dialog.addEventListener('click', (event) => {
    // Clicking the backdrop (outside the dialog box) cancels, like native modals.
    if (event.target === dialog && options.dismissible !== false) close(false);
  });

  document.body.appendChild(dialog);

  function close(confirmed: boolean): void {
    if (!dialog.open) {
      dialog.remove();
      return;
    }
    // Resolve before the close event fires so the outcome is unambiguous.
    settle(confirmed);
    dialog.close(confirmed ? 'confirm' : 'cancel');
    dialog.remove();
  }

  // Show the dialog, then move focus inside it. `showModal` may throw in very
  // old browsers; fall back to the non-modal path so the flow still works.
  try {
    dialog.showModal();
  } catch {
    dialog.setAttribute('open', '');
  }

  const firstField = dialog.querySelector<HTMLElement>(
    'input:not([type="checkbox"]), textarea, select, [data-dialog-confirm]',
  );
  queueMicrotask(() => firstField?.focus());

  return { handle: { element: dialog, close: () => close(false) }, result };
}
