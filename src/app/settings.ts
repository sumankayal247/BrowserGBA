/**
 * Application settings.
 *
 * One object, persisted to IndexedDB, with hydration that treats stored values
 * as untrusted: anything malformed falls back to the default rather than
 * producing a broken player.
 */
import { settingsRepo } from '@/storage/records';
import { DEFAULT_SESSION_SETTINGS, type SessionSettings } from '@/emulator/session';
import {
  DEFAULT_KEYBOARD_MAP,
  DEFAULT_TOUCH_SETTINGS,
  hydrateKeyboardMap,
  hydrateTouchSettings,
  type KeyboardMap,
  type TouchSettings,
} from '@/input/bindings';
import { FILTERS, type FilterId } from '@/render/display';

export interface AppSettings {
  session: SessionSettings;
  keyboard: KeyboardMap;
  touch: TouchSettings;
  /** Volume is remembered globally as well as per session. */
  startMuted: boolean;
  /** Ask before loading a state over a running session. */
  confirmStateLoad: boolean;
  /** Show an on-screen FPS counter from the core. */
  showFpsCounter: boolean;
  /** Cache recent screenshots in the gallery. */
  keepScreenshots: boolean;
  /** Maximum number of screenshots kept per game (0 = unlimited). */
  screenshotLimit: number;
  /** Ask before removing a game and its progress. */
  confirmGameRemoval: boolean;
  /** Remembered library view mode. */
  libraryView: 'grid' | 'list';
}

export const SETTINGS_KEY = 'app';

export const DEFAULT_SETTINGS: AppSettings = {
  session: { ...DEFAULT_SESSION_SETTINGS },
  keyboard: { ...DEFAULT_KEYBOARD_MAP },
  touch: { ...DEFAULT_TOUCH_SETTINGS },
  startMuted: false,
  confirmStateLoad: true,
  showFpsCounter: false,
  keepScreenshots: true,
  screenshotLimit: 50,
  confirmGameRemoval: true,
  libraryView: 'grid',
};

function isFilterId(value: unknown): value is FilterId {
  return typeof value === 'string' && FILTERS.some((filter) => filter.id === value);
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** Rebuilds a complete, valid settings object from whatever was stored. */
export function hydrateSettings(stored: unknown): AppSettings {
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    session: { ...DEFAULT_SESSION_SETTINGS },
    keyboard: { ...DEFAULT_KEYBOARD_MAP },
    touch: { ...DEFAULT_TOUCH_SETTINGS },
  };
  if (!stored || typeof stored !== 'object') return settings;

  const input = stored as Partial<AppSettings>;

  if (input.session && typeof input.session === 'object') {
    const session = input.session as Partial<SessionSettings>;
    settings.session = {
      speedMultiplier: boundedNumber(session.speedMultiplier, 0.1, 10, DEFAULT_SESSION_SETTINGS.speedMultiplier),
      fastForwardMultiplier: boundedNumber(
        session.fastForwardMultiplier,
        1,
        10,
        DEFAULT_SESSION_SETTINGS.fastForwardMultiplier,
      ),
      fastForwardMode: session.fastForwardMode === 'toggle' ? 'toggle' : 'hold',
      volume: boundedNumber(session.volume, 0, 2, DEFAULT_SESSION_SETTINGS.volume),
      muted: Boolean(session.muted),
      rewindEnabled: Boolean(session.rewindEnabled),
      rewindBufferCapacity: Math.round(
        boundedNumber(session.rewindBufferCapacity, 1, 10000, DEFAULT_SESSION_SETTINGS.rewindBufferCapacity),
      ),
      rewindBufferInterval: Math.round(
        boundedNumber(session.rewindBufferInterval, 1, 60, DEFAULT_SESSION_SETTINGS.rewindBufferInterval),
      ),
      filterId: isFilterId(session.filterId) ? session.filterId : DEFAULT_SESSION_SETTINGS.filterId,
      scaling: session.scaling === 'fit' ? 'fit' : 'integer',
      screenshotFormat: session.screenshotFormat === 'scaled' ? 'scaled' : 'native',
    };
  }

  settings.keyboard = hydrateKeyboardMap(input.keyboard);
  settings.touch = hydrateTouchSettings(input.touch);
  settings.startMuted = Boolean(input.startMuted);
  settings.confirmStateLoad = input.confirmStateLoad !== false;
  settings.showFpsCounter = Boolean(input.showFpsCounter);
  settings.keepScreenshots = input.keepScreenshots !== false;
  settings.screenshotLimit = Math.round(boundedNumber(input.screenshotLimit, 0, 1000, 50));
  settings.confirmGameRemoval = input.confirmGameRemoval !== false;
  settings.libraryView = input.libraryView === 'list' ? 'list' : 'grid';

  return settings;
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const stored = await settingsRepo.get<unknown>(SETTINGS_KEY, null);
    return hydrateSettings(stored);
  } catch {
    // A storage failure must not stop the app from working; defaults are safe.
    return hydrateSettings(null);
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await settingsRepo.set(SETTINGS_KEY, settings);
}

export async function resetSettings(): Promise<AppSettings> {
  const settings = hydrateSettings(null);
  await saveSettings(settings);
  return settings;
}
