import { describe, it, expect } from 'vitest';
import { APP_NAME, DB_SCHEMA_VERSION } from '@/version';

describe('baseline', () => {
  it('exposes app identity', () => {
    expect(APP_NAME).toBe('BrowserGBA');
    expect(DB_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
