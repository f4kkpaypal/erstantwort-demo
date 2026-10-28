'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebServer } = require('../web/server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('the app root is HTML even when the client does not ask for HTML', async () => {
  const server = createWebServer({ engine: 'http://127.0.0.1:9' });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { Accept: '*/*' } });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(text, /Erstantwort/);
    const legal = await fetch(`http://127.0.0.1:${port}/datenschutz`, { headers: { Accept: '' } });
    const page = await legal.text();
    assert.equal(legal.status, 200);
    assert.match(page, /Nürnberg/);
    assert.match(page, /Erstantwort/);
    const css = await fetch(`http://127.0.0.1:${port}/app.css`);
    assert.match(await css.text(), /flex-wrap:\s*wrap/);
    assert.doesNotMatch(page, /REPLACE_ME/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
