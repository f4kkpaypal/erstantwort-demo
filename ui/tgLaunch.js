'use strict';

// Classic scripts share one global lexical scope. Keep every name inside
// this function so it cannot collide with ui/app.js (which declares `api`).
(function (root, factory) {
  const launch = factory();
  if (typeof module === 'object' && module.exports) module.exports = launch;
  if (root) root.tgLaunch = launch;
})(typeof window !== 'undefined' ? window : null, function () {
  function parseTelegramHash(hash) {
    const raw = String(hash || '');
    const body = raw.startsWith('#') ? raw.slice(1) : raw;
    if (!body || body.startsWith('/')) return { initData: '', startParam: '' };
    const params = new URLSearchParams(body);
    return {
      initData: params.get('tgWebAppData') || '',
      startParam: params.get('tgWebAppStartParam') || '',
    };
  }

  function resolveInitData(source) {
    const fromSdk = String(source?.sdkInitData || '').trim();
    if (fromSdk) return { initData: fromSdk, source: 'sdk', startParam: '' };
    const parsed = parseTelegramHash(source?.hash || '');
    if (!parsed.initData) return { initData: '', source: '', startParam: parsed.startParam };
    return { initData: parsed.initData, source: 'hash', startParam: parsed.startParam };
  }

  return { parseTelegramHash, resolveInitData };
});
