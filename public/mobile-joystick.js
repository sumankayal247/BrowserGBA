(function () {
  'use strict';

  var MOBILE = '(pointer: coarse), (max-width: 720px)';
  var STYLE_ID = 'browsergba-mobile-joystick-style';
  var LAYOUT_KEY = 'browsergba.touch-layout.v1';
  var READY = 'data-bg-joystick-ready';

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

  function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      body[data-bg-mobile-player="true"] .touch-controls .touch-pad {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      .bg-mobile-joystick {
        position: absolute !important;
        z-index: 8 !important;
        width: 150px;
        height: 150px;
        min-width: 80px;
        min-height: 80px;
        border-radius: 50%;
        touch-action: none !important;
        user-select: none;
        -webkit-user-select: none;
        background: radial-gradient(circle at center, rgba(30, 38, 54, .98) 0 22%, rgba(19, 25, 38, .98) 23% 62%, rgba(11, 15, 24, .98) 63% 100%);
        border: 2px solid rgba(125, 211, 160, .45);
        box-shadow: inset 0 0 0 10px rgba(255,255,255,.025), 0 4px 16px rgba(0,0,0,.28);
      }
      .bg-mobile-joystick::before {
        content: '';
        position: absolute;
        inset: 12%;
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 50%;
        pointer-events: none;
      }
      .bg-mobile-joystick-thumb {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 38%;
        height: 38%;
        transform: translate(-50%, -50%);
        border-radius: 50%;
        background: radial-gradient(circle at 35% 30%, #59677e, #2a3447 62%, #182033);
        border: 2px solid rgba(255,255,255,.14);
        box-shadow: 0 4px 10px rgba(0,0,0,.35);
        pointer-events: none;
        transition: transform .06s linear;
      }
      .bg-mobile-joystick.is-active .bg-mobile-joystick-thumb { transition: none; }
      .touch-controls[data-resize-mode="true"] .bg-mobile-joystick {
        box-shadow: 0 0 0 2px rgba(125,211,160,.2), inset 0 0 0 10px rgba(255,255,255,.025);
        cursor: grab;
      }
      .touch-controls[data-resize-mode="true"] .bg-mobile-joystick::after {
        content: '';
        position: absolute;
        right: 5px;
        bottom: 5px;
        width: 11px;
        height: 11px;
        border-right: 2px solid var(--accent);
        border-bottom: 2px solid var(--accent);
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  function findDirectionButtons(host) {
    var buttons = Array.from(host.querySelectorAll('.touch-key'));
    var result = {};
    for (var button of buttons) {
      var key = button.getAttribute('data-button') || '';
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

  function setupJoystick(host) {
    if (host.getAttribute(READY) === 'true') return;
    var directions = findDirectionButtons(host);
    if (Object.keys(directions).length !== 4) return;

    host.setAttribute(READY, 'true');
    var joystick = document.createElement('div');
    joystick.className = 'bg-mobile-joystick touch-key';
    joystick.setAttribute('data-button', 'joystick');
    joystick.setAttribute('aria-label', 'Virtual directional joystick');
    joystick.setAttribute('role', 'application');
    var thumb = document.createElement('div');
    thumb.className = 'bg-mobile-joystick-thumb';
    joystick.appendChild(thumb);
    host.appendChild(joystick);

    var layout = loadLayout();
    var hostRect = host.getBoundingClientRect();
    var saved = layout.joystick;
    var size = saved?.s ? saved.s * Math.min(hostRect.width, hostRect.height) : Math.min(150, hostRect.height * .72, hostRect.width * .34);
    size = clamp(size, 80, Math.max(80, Math.min(hostRect.width * .55, hostRect.height * .9)));
    var left = saved?.x != null ? saved.x * hostRect.width : 18;
    var top = saved?.y != null ? saved.y * hostRect.height : (hostRect.height - size) / 2;
    left = clamp(left, 0, Math.max(0, hostRect.width - size));
    top = clamp(top, 0, Math.max(0, hostRect.height - size));
    joystick.style.width = size + 'px';
    joystick.style.height = size + 'px';
    joystick.style.left = left + 'px';
    joystick.style.top = top + 'px';

    var held = new Set();
    var activePointer = null;
    var deadZone = .18;
    var maxDistance = .34;

    function persist() {
      var rect = joystick.getBoundingClientRect();
      var current = host.getBoundingClientRect();
      var currentSize = Math.min(rect.width, rect.height);
      layout = loadLayout();
      layout.joystick = {
        x: (rect.left - current.left) / Math.max(current.width, 1),
        y: (rect.top - current.top) / Math.max(current.height, 1),
        s: currentSize / Math.max(Math.min(current.width, current.height), 1),
        aspect: rect.width / Math.max(rect.height, 1),
      };
      saveLayout(layout);
    }

    function releaseAll(event) {
      for (var direction of held) dispatchButton(directions[direction], 'pointerup', event);
      held.clear();
      thumb.style.transform = 'translate(-50%, -50%)';
      joystick.classList.remove('is-active');
      activePointer = null;
    }

    function updateDirection(event) {
      var rect = joystick.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var dx = event.clientX - cx;
      var dy = event.clientY - cy;
      var radius = Math.min(rect.width, rect.height) / 2;
      var distance = Math.sqrt(dx * dx + dy * dy);
      var normalized = Math.min(distance / Math.max(radius, 1), maxDistance) / maxDistance;
      var dead = distance < radius * deadZone;
      var angle = Math.atan2(dy, dx);
      var ux = dead ? 0 : Math.cos(angle);
      var uy = dead ? 0 : Math.sin(angle);
      var thumbDistance = dead ? 0 : radius * .42 * normalized;
      thumb.style.transform = `translate(calc(-50% + ${ux * thumbDistance}px), calc(-50% + ${uy * thumbDistance}px))`;

      var next = new Set();
      if (!dead) {
        var threshold = .38;
        if (ux < -threshold) next.add('left');
        if (ux > threshold) next.add('right');
        if (uy < -threshold) next.add('up');
        if (uy > threshold) next.add('down');
      }

      for (var direction of held) {
        if (!next.has(direction)) dispatchButton(directions[direction], 'pointerup', event);
      }
      for (var direction of next) {
        if (!held.has(direction)) dispatchButton(directions[direction], 'pointerdown', event);
      }
      held = next;
    }

    joystick.addEventListener('pointerdown', function (event) {
      if (host.getAttribute('data-resize-mode') === 'true') return;
      event.preventDefault();
      event.stopPropagation();
      activePointer = event.pointerId;
      joystick.setPointerCapture?.(event.pointerId);
      joystick.classList.add('is-active');
      updateDirection(event);
    });
    joystick.addEventListener('pointermove', function (event) {
      if (activePointer !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      updateDirection(event);
    });
    joystick.addEventListener('pointerup', function (event) {
      if (activePointer !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      releaseAll(event);
    });
    joystick.addEventListener('pointercancel', function (event) {
      if (activePointer !== event.pointerId) return;
      releaseAll(event);
    });

    globalThis.addEventListener('resize', function () {
      var current = loadLayout().joystick;
      var r = host.getBoundingClientRect();
      if (!r.width || !r.height || !current) return;
      var w = clamp(current.s * Math.min(r.width, r.height), 80, Math.max(80, Math.min(r.width * .55, r.height * .9)));
      joystick.style.width = w + 'px';
      joystick.style.height = w + 'px';
      joystick.style.left = clamp(current.x * r.width, 0, Math.max(0, r.width - w)) + 'px';
      joystick.style.top = clamp(current.y * r.height, 0, Math.max(0, r.height - w)) + 'px';
    }, { passive: true });

    // The existing resize editor treats .touch-key as movable/resizable.
    // Persist the joystick's normalized position and size after the editor changes it.
    var last = '';
    setInterval(function () {
      if (!document.contains(joystick)) return;
      if (host.getAttribute('data-resize-mode') !== 'true') {
        var rect = joystick.getBoundingClientRect();
        var current = host.getBoundingClientRect();
        var signature = [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(':');
        if (signature !== last) {
          last = signature;
          persist();
        }
      }
    }, 500);
  }

  function scan() {
    injectStyles();
    if (!isMobile()) return;
    document.body.setAttribute('data-bg-mobile-player', 'true');
    var hosts = document.querySelectorAll('.touch-controls[data-enabled="true"]');
    for (var host of hosts) setupJoystick(host);
  }

  injectStyles();
  var observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis.addEventListener('resize', scan, { passive: true });
  scan();
})();
