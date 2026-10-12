/**
 * Input mapping: the defaults, the keys we refuse to bind, and the two places the
 * platform decides what happens next (browser-reserved keys and vibration).
 *
 * The reserved-key tests exist because of a real bug: the first release bound quick
 * save to F5 and screenshots to F9, which are "reload" and "Reader View" in Firefox.
 * No page can cancel those, so the app looked like it was ignoring the key.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  DEFAULT_KEYBOARD_MAP,
  RESERVED_CODES,
  clearBinding,
  findConflicts,
  keyLabel,
  reservedBindings,
  resetKeyboardMap,
  validateBinding,
  vibrate,
  type KeyboardMap,
} from '@/input/bindings';

describe('keyboard defaults', () => {
  it('never binds a key the browser keeps for itself', () => {
    const clashes = Object.entries(DEFAULT_KEYBOARD_MAP).filter(([, code]) => RESERVED_CODES.has(code));
    expect(clashes).toEqual([]);
  });

  it('binds every action to a different key', () => {
    expect(findConflicts(DEFAULT_KEYBOARD_MAP)).toEqual([]);
  });

  it('leaves the function keys a browser does not use free for shortcuts', () => {
    // F2/F4/F8 are unclaimed in Chromium and Firefox; the app uses them so no
    // shortcut can trigger browser behaviour instead of the game.
    for (const code of ['F2', 'F4', 'F8']) {
      expect(RESERVED_CODES.has(code)).toBe(false);
      expect(() => validateBinding('quickSave', code)).not.toThrow();
    }
  });

  it('refuses the keys a browser acts on first', () => {
    for (const code of ['F5', 'F9', 'F11', 'F12']) {
      expect(() => validateBinding('screenshot', code)).toThrow(/reserved/i);
    }
  });

  it('reports shortcuts stored by an older build', () => {
    const stale: KeyboardMap = { ...DEFAULT_KEYBOARD_MAP, quickSave: 'F5', screenshot: 'F9' };
    expect(reservedBindings(stale)).toEqual([
      { action: 'quickSave', code: 'F5' },
      { action: 'screenshot', code: 'F9' },
    ]);
    expect(reservedBindings(DEFAULT_KEYBOARD_MAP)).toEqual([]);
  });

  it('treats an unbound action as unbound rather than as a key', () => {
    const cleared = clearBinding(DEFAULT_KEYBOARD_MAP, 'rewind');
    expect(reservedBindings(cleared)).toEqual([]);
    expect(keyLabel(cleared.rewind)).toBe('unassigned');
  });

  it('resets to a map with no reserved keys', () => {
    const stale: KeyboardMap = { ...DEFAULT_KEYBOARD_MAP, quickSave: 'F5' };
    expect(reservedBindings(resetKeyboardMap())).toEqual([]);
    expect(reservedBindings(stale)).toHaveLength(1);
  });
});

describe('key labels', () => {
  it('reads like a key legend rather than a code', () => {
    expect(keyLabel('KeyX')).toBe('X');
    expect(keyLabel('ArrowLeft')).toBe('Left');
    expect(keyLabel('ShiftRight')).toBe('Shift Right');
    expect(keyLabel('Digit1')).toBe('1');
    expect(keyLabel('F2')).toBe('F2');
  });
});

describe('vibration', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'vibrate');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis.navigator, 'vibrate', original);
    else Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, 'vibrate');
  });

  function installVibrate(): number[] {
    const calls: number[] = [];
    Object.defineProperty(globalThis.navigator, 'vibrate', {
      configurable: true,
      writable: true,
      value: (pattern: number | number[]) => {
        calls.push(Array.isArray(pattern) ? pattern.length : pattern);
        return true;
      },
    });
    return calls;
  }

  it('pulses the device when haptics are on', () => {
    const calls = installVibrate();
    vibrate([10, 40, 10], true);
    expect(calls).toEqual([3]);
  });

  it('stays silent when haptics are off', () => {
    const calls = installVibrate();
    vibrate(8, false);
    expect(calls).toEqual([]);
  });

  it('does not throw where the device has no vibration motor', () => {
    Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, 'vibrate');
    expect(() => vibrate(8, true)).not.toThrow();
  });

  it('survives a browser that refuses the request', () => {
    Object.defineProperty(globalThis.navigator, 'vibrate', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('blocked by permissions policy');
      },
    });
    expect(() => vibrate(8, true)).not.toThrow();
  });
});
