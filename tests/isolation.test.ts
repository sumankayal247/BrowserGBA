/**
 * The automatic isolation repair.
 *
 * This decision is the difference between "the page explains itself" and "the page
 * reloads forever", so the cases are pinned here rather than discovered in a browser:
 * the app may reload itself exactly once per tab, never inside a frame, and never
 * without a service worker that could actually deliver the headers.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isolationRecoveryAttempted,
  isolationRecoveryPlan,
  markIsolationRecoveryAttempted,
} from '@/pwa/register';

describe('isolation recovery plan', () => {
  it('does nothing when the page is already isolated', () => {
    expect(isolationRecoveryPlan({ isolated: true })).toEqual({
      action: 'none',
      reason: 'already-isolated',
    });
  });

  it('takes the one reload when repair is possible and untried', () => {
    expect(
      isolationRecoveryPlan({ isolated: false, embedded: false, serviceWorker: true, attempted: false }),
    ).toEqual({ action: 'recover' });
  });

  it('never reloads a frame, where isolation can never arrive', () => {
    expect(
      isolationRecoveryPlan({ isolated: false, embedded: true, serviceWorker: true, attempted: false }),
    ).toEqual({ action: 'manual', reason: 'embedded' });
  });

  it('gives up instead of looping once the tab has tried', () => {
    expect(
      isolationRecoveryPlan({ isolated: false, embedded: false, serviceWorker: true, attempted: true }),
    ).toEqual({ action: 'manual', reason: 'already-attempted' });
  });

  it('does not try without a worker to do the job', () => {
    expect(
      isolationRecoveryPlan({ isolated: false, embedded: false, serviceWorker: false, attempted: false }),
    ).toEqual({ action: 'manual', reason: 'no-service-worker' });
  });

  it('prefers the frame explanation over the retry one, because a retry cannot help', () => {
    const plan = isolationRecoveryPlan({ isolated: false, embedded: true, serviceWorker: false, attempted: true });
    expect(plan).toEqual({ action: 'manual', reason: 'embedded' });
  });
});

describe('the per-tab attempt flag', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('starts unset and stays set after being marked', () => {
    expect(isolationRecoveryAttempted()).toBe(false);
    markIsolationRecoveryAttempted();
    expect(isolationRecoveryAttempted()).toBe(true);
  });

  it('treats blocked storage as "already tried", so a reload loop is impossible', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage is blocked by policy');
      },
    });
    try {
      expect(isolationRecoveryAttempted()).toBe(true);
      expect(() => markIsolationRecoveryAttempted()).not.toThrow();
      expect(isolationRecoveryPlan({ isolated: false, embedded: false, serviceWorker: true })).toEqual({
        action: 'manual',
        reason: 'already-attempted',
      });
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    }
  });

  it('reflects the page state by default rather than guessing', () => {
    // happy-dom reports a non-isolated document, so the default path is the real one.
    const plan = isolationRecoveryPlan({ embedded: false, serviceWorker: true, attempted: false });
    expect(plan.action).toBe('recover');
  });
});
