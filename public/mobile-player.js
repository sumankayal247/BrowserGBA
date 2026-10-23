(function () {
  'use strict';

  var STYLE_ID = 'browsergba-mobile-player-style';
  var STORAGE_KEY = 'browsergba.touch-layout.v1';
  var MOBILE = '(pointer: coarse), (max-width: 720px)';

  function isMobile() {
    return globalThis.matchMedia?.(MOBILE).matches ?? globalThis.innerWidth <= 720;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      body[data-bg-mobile-player="true"] .player-bar { position: relative; }
      body[data-bg-mobile-player="true"] .screen-frame {
        width: min(68vw, 320px) !important;
        height: auto !important;
        aspect-ratio: 3 / 2;
      }
      body[data-bg-mobile-player="true"] .screen-frame canvas {
        width: 100% !important;
        height: 100% !important;
      }
      body[data-bg-mobile-player="true"] .player-fullscreen-host {
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      body[data-bg-mobile-player="true"] .control-strip {
        display: none !important;
      }
      body[data-bg-mobile-player="true"] .touch-controls[data-enabled="true"] {
        min-height: 42vh !important;
        height: 42vh !important;
        overflow: hidden;
      }
      .bg-mobile-menu-button {
        min-width: 44px !important;
        width: 44px;
        padding: 0 !important;
        font-size: 1.25rem !important;
        line-height: 1;
      }
      .bg-mobile-menu-panel {
        position: absolute;
        top: calc(100% + 0.45rem);
        right: 0;
        z-index: 40;
        width: min(92vw, 340px);
        display: none;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.4rem;
        padding: 0.5rem;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        background: var(--surface);
        box-shadow: var(--shadow-lg);
      }
      .bg-mobile-menu-panel[data-open="true"] { display: grid; }
      .bg-mobile-menu-panel .btn { width: 100%; min-width: 0; }
      .bg-mobile-menu-panel .bg-resize-controls {
        grid-column: 1 / -1;
        border-color: var(--accent-dim);
        color: var(--accent);
      }
      body[data-bg-mobile-player="true"] .touch-controls[data-resize-mode="true"] {
        min-height: 42vh !important;
        height: 42vh !important;
        background-color: var(--bg-sunken) !important;
        background-image:
          linear-gradient(rgba(125, 211, 160, 0.12) 1px, transparent 1px),
          linear-gradient(90deg, rgba(125, 211, 160, 0.12) 1px, transparent 1px) !important;
        background-size: 24px 24px !important;
        border-color: var(--accent-dim) !important;
      }
      .touch-controls[data-resize-mode="true"] .touch-pad,
      .touch-controls[data-resize-mode="true"] .touch-buttons,
      .touch-controls[data-resize-mode="true"] .touch-shoulders {
        display: contents !important;
      }
      .touch-controls[data-resize-mode="true"] .touch-key {
        position: absolute !important;
        margin: 0 !important;
        z-index: 3;
        box-shadow: 0 0 0 2px rgba(125, 211, 160, 0.18);
        touch-action: none !important;
      }
      .touch-controls[data-resize-mode="true"] .touch-hint {
        display: block !important;
        z-index: 4;
        pointer-events: none;
        color: var(--accent);
        background: rgba(8, 10, 15, 0.72);
        padding: 0.2rem 0.4rem;
        border-radius: 4px;
        bottom: 0.35rem;
      }
      .bg-resize-exit {
        grid-column: 1 / -1;
        margin-top: 0.1rem;
      }
      @media (min-width: 721px) and (pointer: fine) {
        .bg-mobile-menu-button,
        .bg-mobile-menu-panel { display: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function loadLayout() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var value = raw ? JSON.parse(raw) : null;
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function saveLayout(layout) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Layout customisation is best-effort if storage is unavailable.
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function keyFor(button) {
    return button.getAttribute('data-button') || button.textContent?.trim() || 'button';
  }

  function enterResizeMode(touchHost, exitButton) {
    if (touchHost.getAttribute('data-resize-mode') === 'true') return;
    touchHost.setAttribute('data-resize-mode', 'true');
    exitButton.textContent = 'Done resizing';

    var layout = loadLayout();
    var hostRect = touchHost.getBoundingClientRect();
    var buttons = Array.from(touchHost.querySelectorAll('.touch-key'));

    for (var button of buttons) {
      var key = keyFor(button);
      var rect = button.getBoundingClientRect();
      var saved = layout[key];
      var width = saved?.s ? saved.s * Math.min(hostRect.width, hostRect.height) : rect.width;
      var height = saved?.s ? width / (saved.aspect || rect.width / Math.max(rect.height, 1)) : rect.height;
      var left = saved?.x != null ? saved.x * hostRect.width : rect.left - hostRect.left;
      var top = saved?.y != null ? saved.y * hostRect.height : rect.top - hostRect.top;

      width = clamp(width, 44, Math.max(44, hostRect.width * 0.35));
      height = clamp(height, 44, Math.max(44, hostRect.height * 0.35));
      left = clamp(left, 0, Math.max(0, hostRect.width - width));
      top = clamp(top, 0, Math.max(0, hostRect.height - height));

      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
      button.style.width = `${width}px`;
      button.style.height = `${height}px`;
    }

    var active = null;

    function finish(event) {
      if (!active) return;
      event.preventDefault();
      var button = active.button;
      try { button.releasePointerCapture?.(event.pointerId); } catch {}
      var rect = button.getBoundingClientRect();
      var currentHost = touchHost.getBoundingClientRect();
      var size = Math.min(rect.width, rect.height);
      layout[keyFor(button)] = {
        x: (rect.left - currentHost.left) / Math.max(currentHost.width, 1),
        y: (rect.top - currentHost.top) / Math.max(currentHost.height, 1),
        s: size / Math.max(Math.min(currentHost.width, currentHost.height), 1),
        aspect: rect.width / Math.max(rect.height, 1),
      };
      saveLayout(layout);
      active = null;
    }

    function pointerDown(event) {
      var button = event.target.closest?.('.touch-key');
      if (!button || !touchHost.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      var rect = button.getBoundingClientRect();
      var hostRectNow = touchHost.getBoundingClientRect();
      var resizeZone = Math.min(28, Math.max(18, rect.width * 0.25));
      var localX = event.clientX - rect.left;
      var localY = event.clientY - rect.top;
      var resizing = localX >= rect.width - resizeZone && localY >= rect.height - resizeZone;
      active = {
        button,
        pointerId: event.pointerId,
        mode: resizing ? 'resize' : 'drag',
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left - hostRectNow.left,
        top: rect.top - hostRectNow.top,
        width: rect.width,
        height: rect.height,
      };
      button.setPointerCapture?.(event.pointerId);
    }

    function pointerMove(event) {
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      var hostRectNow = touchHost.getBoundingClientRect();
      var dx = event.clientX - active.startX;
      var dy = event.clientY - active.startY;
      if (active.mode === 'drag') {
        var left = clamp(active.left + dx, 0, Math.max(0, hostRectNow.width - active.width));
        var top = clamp(active.top + dy, 0, Math.max(0, hostRectNow.height - active.height));
        active.button.style.left = `${left}px`;
        active.button.style.top = `${top}px`;
        active.button.style.cursor = 'grabbing';
        return;
      }

      var scaleDelta = Math.max(dx, dy);
      var nextWidth = clamp(active.width + scaleDelta, 44, Math.max(44, hostRectNow.width * 0.35));
      var nextHeight = clamp(active.height + scaleDelta, 44, Math.max(44, hostRectNow.height * 0.35));
      active.button.style.width = `${nextWidth}px`;
      active.button.style.height = `${nextHeight}px`;
      active.button.style.left = `${clamp(active.left, 0, Math.max(0, hostRectNow.width - nextWidth))}px`;
      active.button.style.top = `${clamp(active.top, 0, Math.max(0, hostRectNow.height - nextHeight))}px`;
    }

    touchHost.addEventListener('pointerdown', pointerDown, true);
    touchHost.addEventListener('pointermove', pointerMove, true);
    touchHost.addEventListener('pointerup', finish, true);
    touchHost.addEventListener('pointercancel', finish, true);

    exitButton._bgResizeCleanup = function () {
      touchHost.removeEventListener('pointerdown', pointerDown, true);
      touchHost.removeEventListener('pointermove', pointerMove, true);
      touchHost.removeEventListener('pointerup', finish, true);
      touchHost.removeEventListener('pointercancel', finish, true);
      for (var button of buttons) {
        button.style.removeProperty('left');
        button.style.removeProperty('top');
        button.style.removeProperty('width');
        button.style.removeProperty('height');
        button.style.removeProperty('cursor');
      }
      touchHost.removeAttribute('data-resize-mode');
      exitButton.textContent = 'Resize controls';
    };
  }

  function toggleResize(touchHost, exitButton) {
    if (touchHost.getAttribute('data-resize-mode') === 'true') {
      exitButton._bgResizeCleanup?.();
    } else {
      enterResizeMode(touchHost, exitButton);
    }
  }

  function setupPlayer(player) {
    if (!isMobile() || player.getAttribute('data-bg-mobile-ready') === 'true') return;

    var controlStrip = player.querySelector('.control-strip');
    var titleBar = player.querySelector('.player-bar');
    var touchHost = player.querySelector('.touch-controls');
    if (!controlStrip || !titleBar || !touchHost) return;

    player.setAttribute('data-bg-mobile-ready', 'true');
    document.body.setAttribute('data-bg-mobile-player', 'true');

    // Remove the app volume slider so browser/device volume is the only volume control.
    var volume = controlStrip.querySelector('input[type="range"][aria-label="Volume"]');
    if (volume) volume.remove();
    var volumeLabel = controlStrip.querySelector('label[for="player-volume"]');
    if (volumeLabel) volumeLabel.remove();

    var originalMenu = Array.from(controlStrip.querySelectorAll('button')).find(function (button) {
      return button.textContent?.trim() === 'Menu';
    });
    if (!originalMenu) return;

    var hamburger = document.createElement('button');
    hamburger.type = 'button';
    hamburger.className = 'btn btn-sm bg-mobile-menu-button';
    hamburger.textContent = '☰';
    hamburger.setAttribute('aria-label', 'Open emulator controls');
    hamburger.setAttribute('aria-expanded', 'false');

    var panel = document.createElement('div');
    panel.className = 'bg-mobile-menu-panel';
    panel.setAttribute('data-open', 'false');
    panel.setAttribute('aria-label', 'Emulator controls');

    var resizeButton = document.createElement('button');
    resizeButton.type = 'button';
    resizeButton.className = 'btn btn-sm bg-resize-controls';
    resizeButton.textContent = 'Resize controls';
    resizeButton.addEventListener('click', function () {
      toggleResize(touchHost, resizeButton);
      closeMenu();
    });

    panel.appendChild(resizeButton);

    // Keep the existing advanced Menu button, but place every other emulator action here too.
    var children = Array.from(controlStrip.children);
    for (var child of children) {
      if (child === volume || child === volumeLabel) continue;
      if (child === originalMenu) {
        originalMenu.textContent = '⚙ Settings';
      }
      panel.appendChild(child);
    }

    titleBar.appendChild(hamburger);
    titleBar.appendChild(panel);

    function closeMenu() {
      panel.setAttribute('data-open', 'false');
      hamburger.setAttribute('aria-expanded', 'false');
    }

    hamburger.addEventListener('click', function (event) {
      event.stopPropagation();
      var open = panel.getAttribute('data-open') !== 'true';
      panel.setAttribute('data-open', String(open));
      hamburger.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('pointerdown', function (event) {
      if (!panel.contains(event.target) && event.target !== hamburger) closeMenu();
    });

    touchHost.addEventListener('contextmenu', function (event) {
      if (touchHost.getAttribute('data-resize-mode') === 'true') event.preventDefault();
    });
  }

  function scan() {
    injectStyles();
    if (!isMobile()) return;
    var player = document.querySelector('.player');
    if (player) setupPlayer(player);
  }

  injectStyles();
  var observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis.addEventListener('resize', scan, { passive: true });
  globalThis.addEventListener('orientationchange', function () { setTimeout(scan, 120); }, { passive: true });
  scan();
})();
