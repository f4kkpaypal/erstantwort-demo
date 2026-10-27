'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTelegramHash, resolveInitData } = require('../ui/tgLaunch');
const { signInitData, verifyInitData } = require('../core/uiAuth');
const { createWebServer } = require('../web/server');

const NOW = new Date('2026-10-21T10:00:00.000Z');
const TOKEN = '123456:bot-token';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('the page hash is a fallback for initData when the Telegram script is absent', () => {
  const initData = signInitData({
    auth_date: String(Math.floor(NOW.getTime() / 1000)),
    user: JSON.stringify({ id: 4242, first_name: 'Maria' }),
  }, TOKEN);
  const hash = `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=7.2&tgWebAppPlatform=tdesktop&tgWebAppStartParam=L-20261021-0105`;
  const parsed = parseTelegramHash(hash);
  assert.equal(parsed.initData, initData);
  assert.equal(parsed.startParam, 'L-20261021-0105');
  assert.equal(verifyInitData(parsed.initData, TOKEN, { maxAgeS: 3600, now: NOW }).ok, true);
  const fromHash = resolveInitData({ sdkInitData: '', hash });
  assert.equal(fromHash.source, 'hash');
  assert.equal(fromHash.initData, initData);
  const fromSdk = resolveInitData({ sdkInitData: 'sdk-value', hash });
  assert.equal(fromSdk.source, 'sdk');
  assert.equal(fromSdk.initData, 'sdk-value');
  assert.equal(parseTelegramHash('#/anfragen').initData, '');
  assert.equal(resolveInitData({ sdkInitData: '', hash: '#/objekte' }).initData, '');
});

test('the mini app stays on first-party scripts and still serves the hash reader', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  assert.match(html, /src="\/tgLaunch\.js"/);
  assert.match(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, /telegram\.org|script src="https?:/i);
  assert.match(app, /tgWebAppData|resolveInitData/);
  assert.doesNotMatch(app, /telegram\.org/);
  const reader = fs.readFileSync(path.join(__dirname, '..', 'ui', 'tgLaunch.js'), 'utf8');
  assert.match(reader, /function \(root, factory\)/);
  assert.doesNotMatch(reader, /^(?:const|let|var|function|async function) api\b/m);
  const server = createWebServer({ engine: 'http://127.0.0.1:9' });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tgLaunch.js`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(body, /tgWebAppData/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
