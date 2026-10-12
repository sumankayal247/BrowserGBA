/**
 * Shared test environment.
 *
 * `fake-indexeddb/auto` installs a spec-compliant in-memory IndexedDB on
 * `globalThis`, which is what our persistence layer targets. The DOM is provided
 * by happy-dom (see vitest.config.ts).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'vitest';

// Tests may install timers/stubs; make sure nothing leaks between files.
beforeEach(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});

afterEach(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});

// happy-dom does not implement these; several UI modules feature-detect them.
if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

if (typeof globalThis.requestAnimationFrame !== 'function') {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (handle: number) => clearTimeout(handle),
  });
}
