/**
 * Display maths and visual filters.
 *
 * The GBA framebuffer is 240x160 (3:2). Pixel-perfect output means scaling by
 * whole numbers with nearest-neighbour sampling, so the player defaults to
 * integer scaling and only stretches when the user asks for it.
 *
 * Filters are pure CSS applied to the canvas and to a sibling overlay; they
 * never touch the framebuffer, the emulator state or saved data.
 */

export const GBA_WIDTH = 240;
export const GBA_HEIGHT = 160;
export const GBA_ASPECT = GBA_WIDTH / GBA_HEIGHT;

export type FilterId = 'none' | 'scanlines' | 'crt' | 'lcd';

export interface FilterDefinition {
  id: FilterId;
  label: string;
  description: string;
  /** Whether `intensity` changes anything for this filter. */
  hasIntensity: boolean;
  /** Estimated cost, so the UI can warn on low-end devices. */
  cost: 'none' | 'low' | 'medium';
}

export const FILTERS: FilterDefinition[] = [
  {
    id: 'none',
    label: 'Off',
    description: 'Raw pixels, no processing. Recommended for the sharpest image.',
    hasIntensity: false,
    cost: 'none',
  },
  {
    id: 'scanlines',
    label: 'Scanlines',
    description: 'A static dark line every other pixel row, like a CRT at a distance.',
    hasIntensity: true,
    cost: 'low',
  },
  {
    id: 'crt',
    label: 'CRT',
    description: 'Scanlines plus a soft glow and slight colour bloom.',
    hasIntensity: true,
    cost: 'medium',
  },
  {
    id: 'lcd',
    label: 'LCD tint',
    description: 'A gentle contrast and saturation shift toward the original AGB screen.',
    hasIntensity: true,
    cost: 'low',
  },
];

export interface Viewport {
  /** Integer (or fractional for fit mode) scale factor applied to the 240x160 frame. */
  scale: number;
  width: number;
  height: number;
  /** True when scaling is a whole number, i.e. pixels are not resampled. */
  pixelPerfect: boolean;
  /** True when the viewport is smaller than a single 1x frame. */
  cramped: boolean;
}

/**
 * Largest scale that fits `available` while preserving the 3:2 aspect ratio.
 *
 * In `integer` mode the result is floored to a whole number (never below 1, so
 * the game is always visible even in a tiny viewport); `fit` allows fractions so
 * the frame fills the space exactly.
 */
export function computeViewport(
  available: { width: number; height: number },
  mode: 'integer' | 'fit' = 'integer',
): Viewport {
  const width = Math.max(0, Math.floor(available.width));
  const height = Math.max(0, Math.floor(available.height));

  if (width === 0 || height === 0) {
    return { scale: 1, width: GBA_WIDTH, height: GBA_HEIGHT, pixelPerfect: true, cramped: true };
  }

  const rawScale = Math.min(width / GBA_WIDTH, height / GBA_HEIGHT);
  const scale = mode === 'integer' ? Math.max(1, Math.floor(rawScale)) : Math.max(0.25, rawScale);

  return {
    scale,
    width: Math.round(GBA_WIDTH * scale),
    height: Math.round(GBA_HEIGHT * scale),
    pixelPerfect: Number.isInteger(scale),
    cramped: rawScale < 1,
  };
}

export interface FilterStyles {
  /** CSS `filter` value for the canvas element. */
  canvasFilter: string;
  /** Background image used by the overlay layer, if any. */
  overlayImage: string;
  /** Extra overlay opacity (0..1). */
  overlayOpacity: number;
  /** True when the effect changes nothing and the overlay can be removed. */
  disabled: boolean;
}

/** Builds the CSS for a filter at a given intensity (0..1). */
export function filterStyles(filterId: FilterId, intensity = 0.6): FilterStyles {
  const amount = Math.min(Math.max(intensity, 0), 1);

  switch (filterId) {
    case 'scanlines': {
      const alpha = 0.12 + amount * 0.35;
      return {
        canvasFilter: 'none',
        overlayImage: `repeating-linear-gradient(to bottom, rgba(0,0,0,${alpha.toFixed(3)}) 0px, rgba(0,0,0,${alpha.toFixed(3)}) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 2px)`,
        overlayOpacity: 1,
        disabled: false,
      };
    }
    case 'crt': {
      const alpha = 0.18 + amount * 0.4;
      const glow = 0.4 + amount * 0.8;
      return {
        canvasFilter: `contrast(${(100 + amount * 12).toFixed(0)}%) saturate(${(100 + amount * 8).toFixed(0)}%) drop-shadow(0 0 ${glow.toFixed(1)}px rgba(120, 220, 255, ${(0.08 + amount * 0.12).toFixed(3)}))`,
        overlayImage: `repeating-linear-gradient(to bottom, rgba(0,0,0,${alpha.toFixed(3)}) 0px, rgba(0,0,0,${alpha.toFixed(3)}) 1px, rgba(255,255,255,0.02) 1px, rgba(255,255,255,0.02) 3px)`,
        overlayOpacity: 1,
        disabled: false,
      };
    }
    case 'lcd': {
      return {
        canvasFilter: `contrast(${(100 + amount * 10).toFixed(0)}%) saturate(${(100 - amount * 18).toFixed(0)}%) brightness(${(100 + amount * 6).toFixed(0)}%)`,
        overlayImage: 'none',
        overlayOpacity: 0,
        disabled: false,
      };
    }
    case 'none':
    default:
      return { canvasFilter: 'none', overlayImage: 'none', overlayOpacity: 0, disabled: true };
  }
}

/**
 * True when the user has asked for reduced motion.
 *
 * None of the filters animate, but the player still honours the preference by
 * skipping transitions and overlays that could be distracting.
 */
export function prefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  try {
    return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Suggests a cheaper filter when the device cannot keep up.
 *
 * Returns the filter to fall back to, or null when nothing should change.
 */
export function suggestCheaperFilter(current: FilterId, averageFrameMs: number): FilterId | null {
  if (current === 'none' || averageFrameMs <= 0) return null;
  // At 60 fps a frame is 16.7 ms; sustained over ~21 ms means we are dropping frames.
  if (averageFrameMs < 21) return null;
  if (current === 'crt') return 'scanlines';
  return 'none';
}
