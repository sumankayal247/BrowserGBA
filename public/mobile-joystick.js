(function () {
  'use strict';

  var MOBILE = '(pointer: coarse), (max-width: 720px)';
  var STYLE_ID = 'browsergba-mobile-dpad-style';
  var LAYOUT_KEY = 'browsergba.touch-layout.v1';
  var READY = 'data-bg-dpad-ready';

  function isMobile() {
    return globalThis.matchMedia?.(MOBILE).matches ?? globalThis.innerWidth <= 720;
  }

  function loadLayout() {
    try {
      var value = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch { return {}; }
  }

  function saveLayout(layout) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      body[data-bg-mobile-player="true"] .touch-controls .touch-pad {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      .bg-mobile-dpad {
        position: absolute !important;
        z-index: 8 !important;
        width: 156px;
        height: 156px;
        min-width: 96px;
        min-height: 96px;
        border-radius: 22%;
        touch-action: none !important;
        user-select: none;
        -webkit-user-select: none;
        background: transparent;
      }
      .bg-mobile-dpad-button {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        margin: 0;
        border: 1px solid rgba(255,255,255,.10);
        background: linear-gradient(180deg, #303b50, #202a3c);
        color: #f3f6fb;
        font: 700 clamp(18px, 6vw, 28px)/1 system-ui, sans-serif;
        text-shadow: 0 1px 2px rgba(0,0,0,.45);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 3px 9px rgba(0,0,0,.28);
        -webkit-tap-highlight-color: transparent;
        pointer-events: none;
      }
      .bg-mobile-dpad-button.is-pressed {
        background: linear-gradient(180deg, #1b2435, #111827);
        box-shadow: inset 0 2px 5px rgba(0,0,0,.42);
        transform: translateY(1px);
      }
      .bg-mobile-dpad-up {
        left: 29%; top: 0; width: 42%; height: 38%;
        border-radius: 20% 20% 7% 7%;
      }
      .bg-mobile-dpad-down {
        left: 29%; bottom: 0; width: 42%; height: 38%;
        border-radius: 7% 7% 20% 20%;
      }
      .bg-mobile-dpad-left {
        left: 0; top: 29%; width: 38%; height: 42%;
        border-radius: 20% 7% 7% 20%;
      }
      .bg-mobile-dpad-right {
        right: 0; top: 29%; width: 38%; height: 42%;
        border-radius: 7% 20% 20% 7%;
      }
      .bg-mobile-dpad-center {
        position: absolute;
        left: 31%; top: 31%; width: 38%; height: 38%;
        border-radius: 18%;
        background: #202a3c;
        box-shadow: inset 0 2px 6px rgba(0,0,0,.34);
        pointer-events: none;
      }
      .touch-controls[data-resize-mode="true"] .bg-mobile-dpad {
        box-shadow: 0 0 0 2px rgba(125,211,160,.25);
        cursor: grab;
      }
      .touch-controls[data-resize-mode="true"] .bg-mobile-dpad::after {
        content: '';
        position: absolute;
        right: 3px;
        bottom: 3px;
        width: 12px;
        height: 12px;
        border-right: 2px solid var(--accent);
        border-bottom: 2px solid var(--accent);
        pointer-events: none;
      }
      .touch-controls[data-resize-mode="true"] .bg-mobile-dpad-button,
      .touch-controls[data-resize-mode="true"] .bg-mobile-dpad-center {
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  function findDirectionButtons(host) {
    var buttons = Array.from(host.querySelectorAll('.touch-pad .touch-key'));
    var result = {};
    for (var button of buttons) {
      var key = (button.getAttribute('data-button') || '').toLowerCase();
      if (key === 'up' || key === 'down' || key === 'left' || key === 'right') result[key] = button;
    }
    return result;
  }

  function dispatchButton(button, type, sourceEvent) {
    if (!button) return;
    var event;
    try {
      event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: sourceEvent.pointerId,
        pointerType: 'touch',
        clientX: sourceEvent.clientX,
        clientY: sourceEvent.clientY,
        buttons: type === 'pointerdown' ? 1 : 0,
      });
    } catch {
      event = new MouseEvent(type === 'pointerdown' ? 'mousedown' : 'mouseup', { bubbles: true, cancelable: true });
    }
    button.dispatchEvent(event);
  }

  function setupDpad(host) {
    if (host.getAttribute(READY) === 'true') return;
    var directions = findDirectionButtons(host);
    if (Object.keys(directions).length !== 4) return;

    host.setAttribute(READY, 'true');

    var dpad = document.createElement('div');
    dpad.className = 'bg-mobile-dpad touch-key';
    dpad.setAttribute('data-button', 'dpad');
    dpad.setAttribute('aria-label', 'Directional pad');
    dpad.setAttribute('role', 'application');

    var visualDirections = [
      ['up', '▲'],
      ['down', '▼'],
      ['left', '◀'],
      ['right', '▶'],
    ];
    for (var item of visualDirections) {
      var button = document.createElement('div');
      button.className = 'bg-mobile-dpad-button bg-mobile-dpad-' + item[0];
      button.textContent = item[1];
      button.setAttribute('aria-hidden', 'true');
      dpad.appendChild(button);
    }
    var center = document.createElement('div');
    center.className = 'bg-mobile-dpad-center';
    center.setAttribute('aria-hidden', 'true');
    dpad.appendChild(center);
    host.appendChild(dpad);

    var layout = loadLayout();
    var saved = layout.dpad;

    function applySaved() {
      var rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var size = saved?.s ? saved.s * Math.min(rect.width, rect.height) : Math.min(156, rect.height * .62, rect.width * .36);
      size = clamp(size, 96, Math.max(96, Math.min(rect.width * .55, rect.height * .9)));
      var left = saved?.x != null ? saved.x * rect.width : 18;
      var top = saved?.y != null ? saved.y * rect.height : (rect.height - size) / 2;
      left = clamp(left, 0, Math.max(0, rect.width - size));
      top = clamp(top, 0, Math.max(0, rect.height - size));
      dpad.style.width = size + 'px';
      dpad.style.height = size + 'px';
      dpad.style.left = left + 'px';
      dpad.style.top = top + 'px';
    }

    applySaved();

    var held = null;
    var activePointer = null;
    var lastDirection = null;

    function setVisual(direction, pressed) {
      var visual = dpad.querySelector('.bg-mobile-dpad-' + direction);
      if (visual) visual.classList.toggle('is-pressed', pressed);
    }

    function release(event) {
      if (held) {
        dispatchButton(directions[held], 'pointerup', event);
        setVisual(held, false);
      }
      held = null;
      lastDirection = null;
      activePointer = null;
    }

    function directionAt(event) {
      var rect = dpad.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var dx = event.clientX - cx;
      var dy = event.clientY - cy;
      var distance = Math.hypot(dx, dy);
      var radius = Math.min(rect.width, rect.height) * .5;

      // Keep a forgiving centre zone. Once a direction is held, require a
      // meaningful change before switching so normal thumb movement does not chatter.
      if (distance < radius * .20) return held;

      if (Math.abs(dx) > Math.abs(dy) * .72) return dx < 0 ? 'left' : 'right';
      if (Math.abs(dy) > Math.abs(dx) * .72) return dy < 0 ? 'up' : 'down';
      return lastDirection || held || (Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'));
    }

    function update(event) {
      var next = directionAt(event);
      if (!next || next === held) return;

      if (held) {
        dispatchButton(directions[held], 'pointerup', event);
        setVisual(held, false);
      }
      held = next;
      lastDirection = next;
      dispatchButton(directions[next], 'pointerdown', event);
      setVisual(next, true);
    }

    dpad.addEventListener('pointerdown', function (event) {
      if (host.getAttribute('data-resize-mode') === 'true') return;
      event.preventDefault();
      event.stopPropagation();
      activePointer = event.pointerId;
      dpad.setPointerCapture?.(event.pointerId);
      update(event);
    });

    dpad.addEventListener('pointermove', function (event) {
      if (activePointer !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      update(event);
    });

    dpad.addEventListener('pointerup', function (event) {
      if (activePointer !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      release(event);
    });

    dpad.addEventListener('pointercancel', function (event) {
      if (activePointer !== event.pointerId) return;
      release(event);
    });

    globalThis.addEventListener('resize', function () {
      saved = loadLayout().dpad;
      applySaved();
    }, { passive: true });

    // Resize mode is owned by mobile-player.js. Persist this single d-pad group
    // after the editor changes its position or size, never its four visual arrows.
    var last = '';
    setInterval(function () {
      if (!document.contains(dpad)) return;
      if (host.getAttribute('data-resize-mode') !== 'true') {
        var rect = dpad.getBoundingClientRect();
        var current = host.getBoundingClientRect();
        var signature = [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(':');
        if (signature !== last) {
          last = signature;
          layout = loadLayout();
          layout.dpad = {
            x: (rect.left - current.left) / Math.max(current.width, 1),
            y: (rect.top - current.top) / Math.max(current.height, 1),
            s: Math.min(rect.width, rect.height) / Math.max(Math.min(current.width, current.height), 1),
            aspect: rect.width / Math.max(rect.height, 1),
          };
          saveLayout(layout);
        }
      }
    }, 350);
  }

  function scan() {
    injectStyles();
    if (!isMobile()) return;
    document.body.setAttribute('data-bg-mobile-player', 'true');
    var hosts = document.querySelectorAll('.touch-controls[data-enabled="true"]');
    for (var host of hosts) setupDpad(host);
  }

  injectStyles();
  var observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis.addEventListener('resize', scan, { passive: true });
  scan();
})();
