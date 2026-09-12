(function () {
  'use strict';

  const host = window.location.hostname.toLowerCase();
  const referrer = document.referrer.toLowerCase();
  const isCrazyGames = Boolean(
    window.CrazyGames ||
    host.endsWith('crazygames.com') ||
    referrer.includes('crazygames.com')
  );
  const state = {
    isCrazyGames,
    adsenseEnabled: false,
    crazyGamesReady: false
  };

  function loadScript(src, attributes) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        if (existing.dataset.loaded === 'true') resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      Object.entries(attributes || {}).forEach(([key, value]) => script.setAttribute(key, value));
      script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve(); }, { once: true });
      script.addEventListener('error', reject, { once: true });
      document.head.appendChild(script);
    });
  }

  function loadAdSense() {
    const safeHost = window.location.hostname && (
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.endsWith('forestbrawl.fun') ||
      window.location.hostname.endsWith('forestbrawl.io')
    );
    if (!safeHost || !state.adsenseEnabled) return Promise.resolve(undefined);
    try {
      if (!window.adsbygoogle) {
        const existing = document.querySelector('script[src^="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]');
        if (!existing) {
          const script = document.createElement('script');
          script.async = true;
          script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
          script.setAttribute('crossorigin', 'anonymous');
          document.head.appendChild(script);
        }
      }
    } catch (_) {}
    return Promise.resolve(undefined);
  }

  function loadCrazyGames() {
    if (window.CrazyGames) return Promise.resolve(window.CrazyGames);
    return loadScript('https://sdk.crazygames.com/crazygames-sdk-v3.js')
      .then(() => window.CrazyGames || null)
      .catch(() => null);
  }

  function setupGameShell() {
    if (!/\/play\.html$/.test(window.location.pathname)) return;

    if (localStorage.getItem('fb_coin_economy_version') !== '1') {
      localStorage.setItem('fb_gold', '0');
      localStorage.setItem('fb_coin_economy_version', '1');
    }

    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const style = document.createElement('style');
    style.textContent = `
      @media (orientation: landscape) and (pointer: coarse) {
        html, body { width: 100%; height: 100%; min-height: 100%; overflow: hidden; }
        #gameCanvas, #game-ui-layer { width: 100% !important; height: 100% !important; }
        #ui-top { top: max(6px, env(safe-area-inset-top)); right: max(6px, env(safe-area-inset-right)); }
        #ref-player-panel { top: max(6px, env(safe-area-inset-top)); left: max(6px, env(safe-area-inset-left)); }
        #minimap { left: max(6px, env(safe-area-inset-left)); bottom: max(6px, env(safe-area-inset-bottom)); }
        #resource-hud { right: max(6px, env(safe-area-inset-right)); bottom: max(6px, env(safe-area-inset-bottom)); }
        #ui-bottom { bottom: max(6px, env(safe-area-inset-bottom)); width: min(72vw, 34rem); }
      }
    `;
    document.head.appendChild(style);

    const lockLandscape = () => {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => undefined);
      }
    };
    document.addEventListener('pointerdown', lockLandscape, { capture: true, once: true });
  }

  setupGameShell();

  const ready = isCrazyGames ? loadCrazyGames().then(api => {
    state.crazyGamesReady = Boolean(api);
    return api;
  }) : Promise.resolve(null);

  window.forestBrawlPlatform = {
    state,
    ready,
    async showMidgameAd() {
      if (!isCrazyGames) return false;
      const api = await ready;
      const ad = api && api.SDK && api.SDK.ad;
      if (!ad || typeof ad.requestAd !== 'function') return false;
      try {
        await ad.requestAd('midgame');
        return true;
      } catch (error) {
        return false;
      }
    }
  };
})();
