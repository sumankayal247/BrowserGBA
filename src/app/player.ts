/**
 * Player controller: owns a live emulator session and every input path.
 *
 * Responsibilities are deliberately concentrated here so the rules are in one
 * place and cannot drift between keyboard, gamepad and touch:
 *
 * - One session per game; switching games stops the previous one completely.
 * - Held inputs are released on blur, tab hide and teardown, so a key can never
 *   stay stuck down.
 * - Fast-forward and rewind are *holds*: they end when the button, key or
 *   trigger is released, and always when the session pauses or stops.
 * - Audio starts only after a user gesture (browser requirement).
 */
import {
  GBA_BUTTONS,
  TouchTracker,
  actionForKey,
  readGamepad,
  shouldHandleEvent,
  vibrate,
  type EmulatorAction,
  type GbaButton,
} from '@/input/bindings';
import { downloadBlob, safeFileName } from '@/ui/dom';
import { computeViewport, filterStyles } from '@/render/display';
import type { EmulatorCore } from '@/emulator/core';
import { EmulatorSession, type SaveStateFeedback, type SessionSettings } from '@/emulator/session';
import type { CheatRecord, GameRecord } from '@/storage/records';
import { recordPlaySession } from '@/library/library';
import { notify } from '@/ui/toast';

export interface PlayerOptions {
  core: EmulatorCore;
  game: GameRecord;
  romBytes: Uint8Array;
  settings: SessionSettings;
  keyboard: Record<string, string>;
  onFeedback: (feedback: SaveStateFeedback) => void;
  /** Cheats the core refused. Play continues without them. */
  onCheatsRejected?: (rejected: CheatRecord[], applied: number) => void;
  onSpeedChange: (multiplier: number, isHold: boolean) => void;
  onVolumeChange: (volume: number, muted: boolean) => void;
  onNeedsGesture: () => void;
}

export class PlayerController {
  readonly session: EmulatorSession;
  private readonly options: PlayerOptions;
  private readonly heldKeys = new Set<string>();
  private readonly heldByGamepad = new Set<GbaButton>();
  private readonly touch = new TouchTracker();
  private gamepadFrame: number | null = null;
  private lastGamepadActions = new Set<EmulatorAction>();
  private disposed = false;
  private readonly detachers: Array<() => void> = [];
  private volume: number;
  private muted: boolean;

  private constructor(session: EmulatorSession, options: PlayerOptions) {
    this.session = session;
    this.options = options;
    // BrowserGBA deliberately has no per-app volume control. Audio is sent at
    // unity gain so the browser/OS system volume is the only volume control.
    this.volume = 1;
    this.muted = false;
  }

  static async create(options: PlayerOptions): Promise<PlayerController> {
    const session = await EmulatorSession.start({
      core: options.core,
      game: options.game,
      romBytes: options.romBytes,
      settings: { ...options.settings, volume: 1, muted: false },
      hooks: {
        onSaveStatus: options.onFeedback,
        onSpeedChange: (multiplier, isHold) => options.onSpeedChange(multiplier, isHold),
        onCheatsRejected: (rejected, applied) => options.onCheatsRejected?.(rejected, applied),
      },
    });
    const controller = new PlayerController(session, options);
    controller.attach();
    return controller;
  }

  // --- input ---------------------------------------------------------------

  private attach(): void {
    const onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => this.handleKeyUp(event);
    const onBlur = () => this.releaseAllInputs();
    const onPointerUp = () => this.releaseAllInputs();
    const onVisibility = () => {
      if (document.hidden) {
        this.releaseAllInputs();
        this.session.pause();
      }
    };

    globalThis.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('keyup', onKeyUp);
    globalThis.addEventListener('blur', onBlur);
    globalThis.addEventListener('pointerup', onPointerUp);
    document.addEventListener('visibilitychange', onVisibility);

    this.detachers.push(
      () => globalThis.removeEventListener('keydown', onKeyDown),
      () => globalThis.removeEventListener('keyup', onKeyUp),
      () => globalThis.removeEventListener('blur', onBlur),
      () => globalThis.removeEventListener('pointerup', onPointerUp),
      () => document.removeEventListener('visibilitychange', onVisibility),
    );

    this.pollGamepads();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!shouldHandleEvent(event, event.target)) return;
    const action = actionForKey(this.options.keyboard as never, event);
    if (!action) return;

    // Stop the browser from scrolling or triggering its own shortcut, but only
    // for keys we actually bind.
    event.preventDefault();
    if (this.heldKeys.has(event.code)) return;
    this.heldKeys.add(event.code);

    if (this.isGameButton(action)) {
      this.pressButton(action);
      return;
    }
    this.handleActionDown(action);
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (!this.heldKeys.has(event.code)) return;
    this.heldKeys.delete(event.code);
    const action = actionForKey(this.options.keyboard as never, event);
    if (!action) return;
    if (this.isGameButton(action)) {
      this.releaseButton(action);
      return;
    }
    this.handleActionUp(action);
  }

  /** Runs an emulator action for a key press, or turns on a hold. */
  private handleActionDown(action: EmulatorAction): void {
    switch (action) {
      case 'fastForward':
        if (this.session.getSettings().fastForwardMode === 'hold') {
          this.session.beginFastForward();
        } else {
          this.session.toggleFastForward();
        }
        break;
      case 'rewind':
        this.session.startRewind();
        break;
      case 'quickSave':
        void this.quickSave();
        break;
      case 'quickLoad':
        void this.quickLoad();
        break;
      case 'screenshot':
        void this.screenshot();
        break;
      case 'togglePause':
        this.session.togglePause();
        break;
      case 'toggleMute':
        this.toggleMute();
        break;
      case 'toggleFullscreen':
        this.onToggleFullscreen?.();
        break;
      case 'toggleMenu':
        this.onToggleMenu?.();
        break;
      default:
        break;
    }
  }

  private handleActionUp(action: EmulatorAction): void {
    if (action === 'fastForward' && this.session.getSettings().fastForwardMode === 'hold') {
      this.session.endFastForward();
    }
    if (action === 'rewind') this.session.stopRewind();
  }

  private isGameButton(action: string): action is GbaButton {
    return (GBA_BUTTONS as readonly string[]).includes(action);
  }

  pressButton(button: GbaButton): void {
    if (this.disposed) return;
    this.session.sendInput(button, true);
  }

  releaseButton(button: GbaButton): void {
    this.session.sendInput(button, false);
  }

  /** Releases everything: keys, gamepad buttons, touch and temporary speeds. */
  releaseAllInputs(): void {
    this.session.releaseAllInputs();
    this.heldKeys.clear();
    this.heldByGamepad.clear();
    this.touch.clear();
    this.lastGamepadActions.clear();
    this.session.releaseSpeedOverrides();
  }

  private get core(): EmulatorCore {
    return this.options.core;
  }

  // --- touch ---------------------------------------------------------------

  /**
   * Handles a pointer event from an on-screen control.
   *
   * Returns true when the controller consumed the event, so the view can avoid
   * double-handling it.
   */
  handleTouch(pointerId: number, button: GbaButton, phase: 'down' | 'up'): void {
    if (phase === 'down') {
      const changed = this.touch.press(pointerId, button);
      if (changed) {
        this.session.sendInput(button, true);
        vibrate(8, !this.options.settings.muted);
      }
      return;
    }
    this.touch.release(pointerId);
    // Only release the button if no other finger is holding it.
    if (!this.touch.isHeld(button)) this.session.sendInput(button, false);
  }

  // --- gamepads ------------------------------------------------------------

  private pollGamepads(): void {
    if (this.disposed) return;
    const navigatorWithPads = globalThis.navigator as Navigator & {
      getGamepads?: () => Array<Gamepad | null>;
    };
    const pads = navigatorWithPads.getGamepads?.() ?? [];

    const activeButtons = new Set<GbaButton>();
    const activeActions = new Set<EmulatorAction>();

    for (const pad of pads) {
      if (!pad?.connected) continue;
      const state = readGamepad(pad);
      for (const button of state.buttons) activeButtons.add(button);
      for (const action of state.actions) activeActions.add(action);
    }

    for (const button of GBA_BUTTONS) {
      const wasHeld = this.heldByGamepad.has(button);
      const isHeld = activeButtons.has(button);
      if (isHeld && !wasHeld) {
        this.heldByGamepad.add(button);
        this.session.sendInput(button, true);
      } else if (!isHeld && wasHeld) {
        this.heldByGamepad.delete(button);
        this.session.sendInput(button, false);
      }
    }

    for (const action of activeActions) {
      if (!this.lastGamepadActions.has(action)) this.handleActionDown(action);
    }
    for (const action of this.lastGamepadActions) {
      if (!activeActions.has(action)) this.handleActionUp(action);
    }
    this.lastGamepadActions = activeActions;

    this.gamepadFrame = requestAnimationFrame(() => this.pollGamepads());
  }

  // --- audio ---------------------------------------------------------------

  /** Must be called from a user gesture for the browser to allow audio. */
  unlockAudio(): void {
    this.options.core.applySettings({ volume: this.volume, muted: this.muted });
  }

  setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, 0), 2);
    this.options.core.applySettings({ volume: this.volume, muted: this.muted });
    this.options.onVolumeChange(this.volume, this.muted);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.options.core.applySettings({ volume: this.volume, muted });
    this.options.onVolumeChange(this.volume, muted);
  }

  toggleMute(): void {
    this.setMuted(!this.muted);
  }

  getVolumeState(): { volume: number; muted: boolean } {
    return { volume: this.volume, muted: this.muted };
  }

  // --- actions used by the UI ---------------------------------------------

  onToggleFullscreen: (() => void) | null = null;
  onToggleMenu: (() => void) | null = null;

  async quickSave(slot = 0): Promise<void> {
    try {
      const record = await this.session.quickSave(slot);
      notify.success('State saved', `Slot ${slot} · ${record.coreVersion}`);
    } catch (error) {
      notify.error('Could not save state', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async quickLoad(slot = 0): Promise<void> {
    try {
      await this.session.quickLoad(slot);
      notify.success('State loaded', `Slot ${slot}`);
    } catch (error) {
      notify.error('Could not load state', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async screenshot(): Promise<void> {
    try {
      const shot = await this.session.takeScreenshot();
      downloadBlob(shot.blob, safeFileName(this.options.game.customTitle || this.options.game.title, 'png', 'screenshot'));
      notify.success('Screenshot saved', `${shot.width}×${shot.height} PNG captured from the framebuffer.`);
    } catch (error) {
      notify.error('Screenshot failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async flushSave(): Promise<void> {
    try {
      await this.session.flushSave('manual');
      notify.success('Progress saved');
    } catch (error) {
      notify.error('Could not save', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async reset(): Promise<void> {
    await this.session.reset();
    notify.info('Game reset', 'Battery saves were kept; unsaved progress was not.');
  }

  pause(): void {
    this.session.pause();
  }

  resume(): void {
    this.session.resume();
  }

  togglePause(): void {
    this.session.togglePause();
  }

  setSpeed(multiplier: number): void {
    try {
      this.session.setSpeedMultiplier(multiplier);
    } catch (error) {
      notify.warning('Speed not changed', error instanceof Error ? error.message : 'Invalid speed');
    }
  }

  setRewindEnabled(enabled: boolean): void {
    this.session.setRewindEnabled(enabled);
  }

  startRewind(): void {
    this.session.startRewind();
  }

  stopRewind(): void {
    this.session.stopRewind();
  }

  beginFastForward(): void {
    this.session.beginFastForward();
  }

  endFastForward(): void {
    this.session.endFastForward();
  }

  getSession(): EmulatorSession {
    return this.session;
  }

  /** Records playtime and tears the session down. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAllInputs();
    if (this.gamepadFrame !== null) cancelAnimationFrame(this.gamepadFrame);
    for (const detach of this.detachers.splice(0)) detach();

    const elapsed = this.session.elapsedPlaytimeMs();
    await this.session.stop();
    try {
      if (elapsed > 5_000) await recordPlaySession(this.options.game.id, elapsed);
    } catch {
      // Playtime is a nicety; never let it block leaving the player.
    }
  }
}

/**
 * Applies the viewport size to the screen frame.
 *
 * The canvas keeps its native 240x160 backing store and is only scaled through
 * CSS, so every pixel stays square and crisp.
 */
export function applyViewport(
  frame: HTMLElement,
  canvas: HTMLCanvasElement,
  available: { width: number; height: number },
  mode: 'integer' | 'fit',
): { scale: number; pixelPerfect: boolean } {
  const viewport = computeViewport(available, mode);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  frame.style.width = `${viewport.width}px`;
  frame.style.height = `${viewport.height}px`;
  return { scale: viewport.scale, pixelPerfect: viewport.pixelPerfect };
}

export { filterStyles };
