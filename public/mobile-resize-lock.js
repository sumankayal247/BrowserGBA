(function () {
  'use strict';

  var MOBILE = '(pointer: coarse), (max-width: 720px)';
  var STORAGE_KEY = 'browsergba.touch-layout.v1';

  /*
    Previous implementation kept the resize result inside 35% of the
    controller host height/width. That caused the D-pad to stop growing
    vertically even though there was still usable controller space.

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function setup(host) {
      host.addEventListener('pointermove', function (event) {
        var button = event.target.closest?.('.touch-key');
        if (!button || host.getAttribute('data-resize-mode') !== 'true') return;

        var width = button.getBoundingClientRect().width;
        var height = button.getBoundingClientRect().height;
        var size = Math.max(width, height, 44);
        var hostRect = host.getBoundingClientRect();
        size = Math.min(size, hostRect.width * 0.35, hostRect.height * 0.35);

        button.style.width = size + 'px';
        button.style.height = size + 'px';
      });
    }
  */

  function isMobile() {
    return globalThis.matchMedia?.(MOBILE).matches ?? globalThis.innerWidth <= 720;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
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

  function keyFor(button) {
    return button.getAttribute('data-button') || button.textContent?.trim() || 'button';
  }

  function applySavedLayout(host) {
    if (!isMobile() || host.getAttribute('data-custom-layout') !== 'true') return;

    var layout = loadLayout();
    var hostRect = host.getBoundingClientRect();

    host.querySelectorAll('.touch-key').forEach(function (button) {
      var saved = layout[keyFor(button)];
      if (!saved) return;

      var base = Math.max(Math.min(hostRect.width, hostRect.height), 1);
      var size = Math.max((saved.s || 0.15) * base, 44);
      var left = (saved.x || 0) * hostRect.width;
      var top = (saved.y || 0) * hostRect.height;

      // Keep the control square and inside the controller canvas. There is
      // intentionally no 35% height cap: the available canvas is the limit.
      size = Math.min(size, hostRect.width, hostRect.height);
      left = clamp(left, 0, Math.max(0, hostRect.width - size));
      top = clamp(top, 0, Math.max(0, hostRect.height - size));

      button.style.left = size + 0 === size ? left + 'px' : button.style.left;
      button.style.top = top + 'px';
      button.style.width = size + 'px';
      button.style.height = size + 'px';
    });
  }

  function setup(host) {
    if (host.getAttribute('data-bg-resize-override') === 'true') return;
    host.setAttribute('data-bg-resize-override', 'true');

    var active = null;

    // Capture on document so this runs before mobile-player.js's existing
    // resize handler on the touch-controls element.
    document.addEventListener('pointerdown', function (event) {
      if (!isMobile() || host.getAttribute('data-resize-mode') !== 'true') return;

      var button = event.target.closest?.('.touch-key');
      if (!button || !host.contains(button)) return;

      var rect = button.getBoundingClientRect();
      var resizeZone = Math.min(28, Math.max(18, rect.width * 0.25));
      var localX = event.clientX - rect.left;
      var localY = event.clientY - rect.top;
      var resizing = localX >= rect.width - resizeZone && localY >= rect.height - resizeZone;
      if (!resizing) return;

      var hostRect = host.getBoundingClientRect();
      active = {
        button: button,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left - hostRect.left,
        top: rect.top - hostRect.top,
        size: Math.max(rect.width, rect.height),
      };

      event.preventDefault();
      event.stopImmediatePropagation();
      button.setPointerCapture?.(event.pointerId);
    }, true);

    document.addEventListener('pointermove', function (event) {
      if (!active || event.pointerId !== active.pointerId) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      var hostRect = host.getBoundingClientRect();
      var dx = event.clientX - active.startX;
      var dy = event.clientY - active.startY;
      var delta = Math.max(dx, dy);
      var maxSize = Math.min(
        Math.max(44, hostRect.width - active.left),
        Math.max(44, hostRect.height - active.top)
      );
      var size = clamp(active.size + delta, 44, maxSize);

      active.button.style.left = clamp(active.left, 0, Math.max(0, hostRect.width - size)) + 'px';
      active.button.style.top = clamp(active.top, 0, Math.max(0, hostRect.height - size)) + 'px';
      active.button.style.width = size + 'px';
      active.button.style.height = size + 'px';
    }, true);

    function finish(event) {
      if (!active || event.pointerId !== active.pointerId) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      var button = active.button;
      var hostRect = host.getBoundingClientRect();
      var rect = button.getBoundingClientRect();
      var size = Math.min(rect.width, rect.height);
      var layout = loadLayout();

      layout[keyFor(button)] = {
        x: (rect.left - hostRect.left) / Math.max(hostRect.width, 1),
        y: (rect.top - hostRect.top) / Math.max(hostRect.height, 1),
        s: size / Math.max(Math.min(hostRect.width, hostRect.height), 1),
        aspect: 1,
      };
      saveLayout(layout);

      try { button.releasePointerCapture?.(event.pointerId); } catch {}
      active = null;
    }

    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', finish, true);

    var observer = new MutationObserver(function () {
      if (host.getAttribute('data-resize-mode') !== 'true') {
        // mobile-player.js calls applySavedLayout() when resize mode closes;
        // re-apply our uncapped saved size afterwards.
        setTimeout(function () { applySavedLayout(host); }, 0);
      }
    });
    observer.observe(host, { attributes: true, attributeFilter: ['data-resize-mode', 'data-custom-layout'] });

    applySavedLayout(host);
  }

  function scan() {
    if (!isMobile()) return;
    document.querySelectorAll('.touch-controls[data-enabled="true"]').forEach(setup);
    document.querySelectorAll('.touch-controls[data-custom-layout="true"]').forEach(applySavedLayout);
  }

  var observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis.addEventListener('resize', scan, { passive: true });
  globalThis.addEventListener('orientationchange', function () { setTimeout(scan, 120); }, { passive: true });
  scan();
})();
