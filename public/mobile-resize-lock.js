(function () {
  'use strict';

  var MOBILE = '(pointer: coarse), (max-width: 720px)';

  function isMobile() {
    return globalThis.matchMedia?.(MOBILE).matches ?? globalThis.innerWidth <= 720;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function setup(host) {
    if (host.getAttribute('data-bg-proportional-resize') === 'true') return;
    host.setAttribute('data-bg-proportional-resize', 'true');

    host.addEventListener('pointermove', function (event) {
      if (!isMobile() || host.getAttribute('data-resize-mode') !== 'true') return;

      var button = event.target.closest?.('.touch-key');
      if (!button || !host.contains(button)) return;

      // The resize editor runs first in capture phase. At this point it has
      // already changed the element size. Force a square bounding box so
      // dragging the resize handle can never deform the control.
      var width = button.getBoundingClientRect().width;
      var height = button.getBoundingClientRect().height;
      var size = Math.max(width, height, 44);
      var hostRect = host.getBoundingClientRect();
      size = Math.min(size, hostRect.width * 0.35, hostRect.height * 0.35);
      size = Math.max(44, size);

      var left = parseFloat(button.style.left) || 0;
      var top = parseFloat(button.style.top) || 0;
      left = clamp(left, 0, Math.max(0, hostRect.width - size));
      top = clamp(top, 0, Math.max(0, hostRect.height - size));

      button.style.width = size + 'px';
      button.style.height = size + 'px';
      button.style.left = left + 'px';
      button.style.top = top + 'px';
    }, false);
  }

  function scan() {
    if (!isMobile()) return;
    document.querySelectorAll('.touch-controls[data-enabled="true"]').forEach(setup);
  }

  var observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis.addEventListener('resize', scan, { passive: true });
  scan();
})();
