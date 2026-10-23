(function () {
  'use strict';

  var STYLE_ID = 'browsergba-mobile-player-layout-fix';
  var MOBILE = '(pointer: coarse), (max-width: 720px)';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* Mobile only: reserve a fixed upper game area and a separate lower control area. */
      body[data-bg-mobile-player="true"] .stage-wrap {
        height: 78vh !important;
        min-height: 0 !important;
        display: flex !important;
        flex-direction: column !important;
      }

      body[data-bg-mobile-player="true"] .player-fullscreen-host {
        flex: 0 0 50vh !important;
        width: 100% !important;
        height: 50vh !important;
        min-height: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        overflow: hidden !important;
      }

      body[data-bg-mobile-player="true"] .player-fullscreen-host .player-bar {
        flex: 0 0 auto !important;
        width: 100% !important;
      }

      body[data-bg-mobile-player="true"] .screen-frame {
        flex: 1 1 auto !important;
        width: 100% !important;
        height: auto !important;
        max-width: none !important;
        min-width: 0 !important;
        min-height: 0 !important;
        aspect-ratio: auto !important;
      }

      body[data-bg-mobile-player="true"] .screen-frame canvas {
        display: block !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        object-fit: fill !important;
      }

      body[data-bg-mobile-player="true"] .player-hud,
      body[data-bg-mobile-player="true"] .orientation-hint {
        display: none !important;
      }

      body[data-bg-mobile-player="true"] .touch-controls[data-enabled="true"] {
        flex: 0 0 28vh !important;
        width: 100% !important;
        height: 28vh !important;
        min-height: 28vh !important;
        max-height: 28vh !important;
        margin: 0 !important;
        overflow: hidden !important;
        position: relative !important;
        box-sizing: border-box !important;
      }

      body[data-bg-mobile-player="true"] .touch-controls[data-resize-mode="true"] {
        flex: 0 0 28vh !important;
        height: 28vh !important;
        min-height: 28vh !important;
        max-height: 28vh !important;
      }
    `;
    document.head.appendChild(style);
  }

  function scan() {
    injectStyles();
    var mobile = globalThis.matchMedia?.(MOBILE).matches ?? globalThis.innerWidth <= 720;
    if (!mobile) return;
    var player = document.querySelector('.player');
    if (!player) return;
    document.body.setAttribute('data-bg-mobile-player', 'true');
  }

  injectStyles();
  var observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis.addEventListener('resize', scan, { passive: true });
  globalThis.addEventListener('orientationchange', function () { setTimeout(scan, 120); }, { passive: true });
  scan();
})();
