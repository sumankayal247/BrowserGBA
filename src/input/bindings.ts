/**
 * Input mapping for keyboard, gamepads and on-screen touch controls.
 *
 * The emulator core's own keyboard handling is switched off (`toggleInput(false)`),
 * so this module is the single source of truth for what a physical input does.
 * That is what makes remapping, gamepad support, "don't type into the game" and
 * "the overlay swallows input" all work through one code path.
 */

export const GBA_BUTTONS = ['A', 'B', 'L', 'R', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right'] as const;
export type GbaButton = (typeof GBA_BUTTONS)[number];

export const EMULATOR_ACTIONS = [
  'fastForward',
  'rewind',
  'quickSave',
  'quickLoad',
  'screenshot',
  'togglePause',
  'toggleMenu',
  'toggleMute',
  'toggleFullscreen',
] as const;
export type EmulatorAction = (typeof EMULATOR_ACTIONS)[number];

export type InputAction = GbaButton | EmulatorAction;

const GBA_BUTTON_SET = new Set<string>(GBA_BUTTONS);
const EMULATOR_ACTION_SET = new Set<string>(EMULATOR_ACTIONS);

export function isGbaButton(action: string): action is GbaButton {
  return GBA_BUTTON_SET.has(action);
}

export function isEmulatorAction(action: string): action is EmulatorAction {
  return EMULATOR_ACTION_SET.has(action);
}

/** Human labels for the settings UI. */
export const ACTION_LABELS: Record<InputAction, string> = {
  A: 'A',
  B: 'B',
  L: 'L',
  R: 'R',
  Start: 'Start',
  Select: 'Select',
  Up: 'D-pad up',
  Down: 'D-pad down',
  Left: 'D-pad left',
  Right: 'D-pad right',
  fastForward: 'Fast-forward (hold)',
  rewind: 'Rewind (hold)',
  quickSave: 'Quick save state',
  quickLoad: 'Quick load state',
  screenshot: 'Screenshot',
  togglePause: 'Pause / resume',
  toggleMenu: 'Open emulator menu',
  toggleMute: 'Mute / unmute',
  toggleFullscreen: 'Fullscreen',
};

/**
 * Keyboard defaults, expressed as `KeyboardEvent.code` values so they follow the
 * physical key layout rather than the user's keyboard language.
 */
export const DEFAULT_KEYBOARD_MAP: Record<InputAction, string> = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  A: 'KeyX',
  B: 'KeyZ',
  L: 'KeyA',
  R: 'KeyS',
  Start: 'Enter',
  Select: 'ShiftRight',
  fastForward: 'Space',
  rewind: 'KeyR',
  quickSave: 'F2',
  quickLoad: 'F4',
  screenshot: 'F8',
  togglePause: 'Escape',
  toggleMenu: 'KeyM',
  toggleMute: 'KeyN',
  toggleFullscreen: 'KeyF',
};

export type KeyboardMap = Record<InputAction, string>;

export interface BindingConflict {
  code: string;
  actions: InputAction[];
}

/**
 * Finds keys bound to more than one action.
 *
 * Duplicate bindings are allowed but reported: two game buttons on one key
 * silently drops an input, which players experience as "the button is broken".
 */
export function findConflicts(map: KeyboardMap): BindingConflict[] {
  const byCode = new Map<string, InputAction[]>();
  for (const [action, code] of Object.entries(map) as Array<[InputAction, string]>) {
    if (!code) continue;
    const list = byCode.get(code) ?? [];
    list.push(action);
    byCode.set(code, list);
  }
  return [...byCode.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([code, actions]) => ({ code, actions }));
}

export class BindingError extends Error {
  constructor(message: string, readonly code: 'unbound' | 'reserved' | 'unknown-action') {
    super(message);
    this.name = 'BindingError';
  }
}

/**
 * Keys we refuse to bind because the browser or the operating system needs them.
 * Rebinding these would break the page in ways users cannot easily undo.
 *
 * The list is deliberately about *this app's* ability to receive the key, and it is
 * checked against both browsers we target:
 *
 *   F1  help, F3 find-again, F5 reload, F6 address bar, F7 caret browsing,
 *   F9  Reader View (Firefox), F10 menu bar, F11 fullscreen, F12 developer tools
 *
 * A page cannot cancel those, so a game bound to one of them would appear to ignore
 * the key — or worse, reload the page in the middle of a battle. F2, F4 and F8 are
 * free in Chromium and Firefox alike and are what the defaults use.
 */
export const RESERVED_CODES = new Set([
  'F1',
  'F3',
  'F5',
  'F6',
  'F7',
  'F9',
  'F10',
  'F11',
  'F12',
  'Tab',
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'ContextMenu',
  'PrintScreen',
]);

/**
 * Shortcuts already stored in settings that this release would refuse to bind.
 *
 * Older builds offered F5/F9 for quick save and screenshots. Browsers keep those
 * keys for themselves, so a player who upgrades keeps a shortcut that quietly
 * reloads the page; the settings screen uses this to say so and offer a rebind.
 */
export function reservedBindings(map: KeyboardMap): Array<{ action: InputAction; code: string }> {
  return (Object.entries(map) as Array<[InputAction, string]>)
    .filter(([, code]) => Boolean(code) && RESERVED_CODES.has(code))
    .map(([action, code]) => ({ action, code }));
}

/**
 * Human-readable key names for `KeyboardEvent.code` values, shared by the settings
 * screen and the in-player button tooltips so they can never disagree.
 */
export function keyLabel(code: string): string {
  if (!code) return 'unassigned';
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Arrow/, '')
    .replace(/^Numpad/, 'Numpad ')
    .replace(/(Left|Right)$/, ' $1')
    .replace(/^BracketLeft$/, '[')
    .replace(/^BracketRight$/, ']')
    .trim();
}

export function validateBinding(action: string, code: string): void {
  if (!isGbaButton(action) && !isEmulatorAction(action)) {
    throw new BindingError(`Unknown action “${action}”.`, 'unknown-action');
  }
  if (!code) {
    throw new BindingError('Press a key to bind, or clear the binding to leave the action unbound.', 'unbound');
  }
  if (RESERVED_CODES.has(code)) {
    throw new BindingError(
      `${code.replace(/^(Key|Digit)/, '')} is reserved by the browser and cannot be used.`,
      'reserved',
    );
  }
}

export function remapKey(map: KeyboardMap, action: InputAction, code: string): KeyboardMap {
  validateBinding(action, code);
  return { ...map, [action]: code };
}

export function clearBinding(map: KeyboardMap, action: InputAction): KeyboardMap {
  return { ...map, [action]: '' };
}

export function resetKeyboardMap(): KeyboardMap {
  return { ...DEFAULT_KEYBOARD_MAP };
}

/** Merges stored bindings over the defaults, ignoring anything unrecognised. */
export function hydrateKeyboardMap(stored: unknown): KeyboardMap {
  const map = resetKeyboardMap();
  if (!stored || typeof stored !== 'object') return map;
  for (const [action, code] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof code !== 'string') continue;
    if (!isGbaButton(action) && !isEmulatorAction(action)) continue;
    map[action as InputAction] = code;
  }
  return map;
}

/** Converts a keyboard event to a binding code, or null when it is not usable. */
export function bindingFromEvent(event: KeyboardEvent): string | null {
  if (!event.code) return null;
  if (RESERVED_CODES.has(event.code)) return null;
  return event.code;
}

/**
 * Turns a physical key into an action.
 *
 * Returns null when the key is unbound so the caller can decide whether to let
 * the browser handle it.
 */
export function actionForKey(map: KeyboardMap, event: KeyboardEvent): InputAction | null {
  const code = bindingFromEvent(event);
  if (!code) return null;
  for (const [action, bound] of Object.entries(map) as Array<[InputAction, string]>) {
    if (bound && bound === code) return action;
  }
  return null;
}

/**
 * Whether a key event should be delivered to the game.
 *
 * Typing in a field, or interacting with any control, must never reach the
 * emulator. This is checked before `preventDefault` so the browser keeps its
 * normal behaviour inside forms.
 */
export function shouldHandleEvent(event: KeyboardEvent, target: EventTarget | null): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.repeat) return false;
  const element = target as HTMLElement | null;
  if (!element) return true;
  const tag = element.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
  if (element.isContentEditable) return false;
  if (element.closest?.('[data-blocks-game-input="true"]')) return false;
  return true;
}

// --- gamepads --------------------------------------------------------------

/**
 * Standard-mapping gamepad button indices used by GBA controls.
 *
 * Values follow the W3C "standard gamepad" layout, which browsers report for
 * most modern pads (Xbox, DualShock/DualSense, 8BitDo in XInput mode).
 */
export const GAMEPAD_BUTTON_MAP: Record<number, GbaButton> = {
  0: 'A', // bottom face button (Xbox A / Cross)
  1: 'B', // right face button (Xbox B / Circle)
  2: 'B', // left face (Xbox X) — incidental convenience
  3: 'A', // top face (Xbox Y / Triangle)
  4: 'L', // left bumper
  5: 'R', // right bumper
  8: 'Select',
  9: 'Start',
  12: 'Up',
  13: 'Down',
  14: 'Left',
  15: 'Right',
};

export const GAMEPAD_ACTIONS: Record<number, EmulatorAction> = {
  6: 'rewind', // left trigger
  7: 'fastForward', // right trigger
  16: 'toggleMenu', // guide
};

/** Left stick dead zone; below this the stick is treated as centred. */
export const STICK_DEADZONE = 0.45;

export interface GamepadState {
  connected: boolean;
  id: string;
  /** Buttons currently held, after mapping. */
  buttons: GbaButton[];
  /** Actions currently held. */
  actions: EmulatorAction[];
}

/** Reads a gamepad snapshot into the actions it is currently holding. */
export function readGamepad(pad: Gamepad): GamepadState {
  const buttons: GbaButton[] = [];
  const actions: EmulatorAction[] = [];

  pad.buttons.forEach((button, index) => {
    if (!button.pressed) return;
    const mapped = GAMEPAD_BUTTON_MAP[index];
    if (mapped) buttons.push(mapped);
    const action = GAMEPAD_ACTIONS[index];
    if (action) actions.push(action);
  });

  const [axisX = 0, axisY = 0] = pad.axes;
  if (axisX <= -STICK_DEADZONE || axisX >= STICK_DEADZONE) {
    buttons.push(axisX < 0 ? 'Left' : 'Right');
  }
  if (axisY <= -STICK_DEADZONE || axisY >= STICK_DEADZONE) {
    buttons.push(axisY < 0 ? 'Up' : 'Down');
  }

  if (pad.mapping !== 'standard') {
    // Non-standard pads still report button 0/1/2/3 in most cases; the mapping
    // above is a best effort and the UI says so rather than claiming support.
  }

  return { connected: true, id: pad.id, buttons: [...new Set(buttons)], actions };
}

// --- touch controls --------------------------------------------------------

export type TouchLayoutId = 'classic' | 'split' | 'minimal';

export interface TouchLayout {
  id: TouchLayoutId;
  label: string;
  description: string;
}

export const TOUCH_LAYOUTS: TouchLayout[] = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'D-pad bottom-left, A/B bottom-right, shoulders above. Best for landscape.',
  },
  {
    id: 'split',
    label: 'Split',
    description: 'Wider spacing for large phones and tablets.',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Smaller, translucent controls that cover less of the screen.',
  },
];

export interface TouchSettings {
  layout: TouchLayoutId;
  /** Control scale, 0.75 (small) to 1.35 (large). */
  scale: number;
  /** Opacity, 0.3 to 1. */
  opacity: number;
  haptics: boolean;
  /** Show L/R shoulder buttons on screen. */
  showShoulders: boolean;
}

export const DEFAULT_TOUCH_SETTINGS: TouchSettings = {
  layout: 'classic',
  scale: 1,
  opacity: 0.85,
  haptics: false,
  showShoulders: true,
};

export function hydrateTouchSettings(stored: unknown): TouchSettings {
  const settings = { ...DEFAULT_TOUCH_SETTINGS };
  if (!stored || typeof stored !== 'object') return settings;
  const input = stored as Partial<TouchSettings>;
  if (input.layout && TOUCH_LAYOUTS.some((layout) => layout.id === input.layout)) {
    settings.layout = input.layout;
  }
  if (typeof input.scale === 'number') settings.scale = Math.min(Math.max(input.scale, 0.75), 1.35);
  if (typeof input.opacity === 'number') settings.opacity = Math.min(Math.max(input.opacity, 0.3), 1);
  if (typeof input.haptics === 'boolean') settings.haptics = input.haptics;
  if (typeof input.showShoulders === 'boolean') settings.showShoulders = input.showShoulders;
  return settings;
}

/**
 * Tracks which buttons are held by which pointer.
 *
 * Multi-touch needs this: a finger sliding off a button must release *that*
 * button and no other, and a button must stay held while a second finger presses
 * elsewhere.
 */
export class TouchTracker {
  private readonly byPointer = new Map<number, GbaButton>();

  press(pointerId: number, button: GbaButton): boolean {
    if (this.byPointer.get(pointerId) === button) return false;
    this.release(pointerId);
    this.byPointer.set(pointerId, button);
    return true;
  }

  release(pointerId: number): GbaButton | null {
    const button = this.byPointer.get(pointerId);
    if (!button) return null;
    this.byPointer.delete(pointerId);
    return button;
  }

  /** Buttons currently held, de-duplicated across pointers. */
  heldButtons(): GbaButton[] {
    return [...new Set(this.byPointer.values())];
  }

  /** True when another pointer is still holding this button. */
  isHeld(button: GbaButton): boolean {
    return [...this.byPointer.values()].includes(button);
  }

  clear(): GbaButton[] {
    const held = this.heldButtons();
    this.byPointer.clear();
    return held;
  }
}

/** Optional haptic pulse; silently ignored where unsupported. */
export function vibrate(pattern: number | number[], enabled: boolean): void {
  if (!enabled) return;
  const nav = globalThis.navigator as (Navigator & { vibrate?: (p: number | number[]) => boolean }) | undefined;
  try {
    nav?.vibrate?.(pattern);
  } catch {
    /* Vibration API is best-effort only. */
  }
}
