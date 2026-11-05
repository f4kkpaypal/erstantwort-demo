'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { signInitData } = require('../../core/uiAuth');
const { buildIntlServer } = require('../../engine/intlServer');

const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'app.js'), 'utf8');

test('every mini-app control reaches a screen or an existing endpoint', () => {
  const wired = [
    ['#/inbox', 'inbox tab'],
    ['#/properties', 'properties tab'],
    ['#/viewings', 'viewings tab'],
    ['#/setup', 'setup tab'],
    ['#/digest', 'digest screen'],
    ['id="openDigest"', 'digest button'],
    ['id="digestSend"', 'digest send'],
    ['/v1/intl/digest/send', 'digest endpoint'],
    ['telegram_delivery', 'digest stays inside the demo'],
    ['id="toggle-manual"', 'manual toggle'],
    ['id="toggle-auto"', 'auto toggle'],
    ['/v1/intl/settings', 'settings endpoint'],
    ['id="stop"', 'stop button'],
    ['/stop', 'stop endpoint'],
    ['id="erase"', 'erase button'],
    ['/erase', 'erase endpoint'],
    ['data-opt', 'reply options'],
    ['/draft', 'draft endpoint'],
    ['id="edit"', 'edit'],
    ['id="sheetDone"', 'done'],
    ['send.onclick', 'send'],
    ['/send', 'send endpoint'],
    ['simulated', 'send stays simulated'],
    ['id="archive"', 'archive'],
    ['/archive', 'archive endpoint'],
    ['id="openArchive"', 'archive screen'],
    ['id="replyText"', 'inline reply'],
    ['contenteditable="true"', 'inline edit'],
    ['id="timePicker"', 'time picker'],
    ['/apply-slot', 'picked time rewrites the reply'],
    ['data-view', 'viewing actions'],
    ['data-act="confirm"', 'confirm viewing'],
    ['data-act', 'cancel viewing'],
    ['data-day', 'day filter'],
    ['data-prop', 'property card'],
    ['propertyId', 'property filter'],
    ['id="saveProp"', 'save property'],
    ['/v1/intl/properties', 'property endpoint'],
    ['id="step-connect"', 'connect step'],
    ['id="step-property"', 'property step'],
    ['id="step-approve"', 'approve step'],
    ['#/simulator', 'simulator'],
    ['id="as-client"', 'send as client'],
    ['id="seed-all"', 'seed'],
    ['lead.draft', 'saved draft is shown again'],
  ];
  for (const [needle, label] of wired) assert.match(appJs, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), label);
  assert.doesNotMatch(appJs, /api\.telegram\.org|graph\.facebook|wa\.me|window\.open|t\.me\//);
});

function openServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-act-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:9',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z') });
  const server = buildIntlServer(config, intl);
  const headers = {
    Authorization: `tma ${signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42 }),
    }, config.TELEGRAM_BOT_TOKEN)}`,
    'Content-Type': 'application/json',
  };
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        intl,
        headers,
        base,
        async close() {
          await new Promise((done) => server.close(done));
          intl.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
        call(pathname, options = {}) {
          return fetch(`${base}${pathname}`, { ...options, headers: { ...headers, ...(options.headers || {}) } })
            .then(async (res) => ({ status: res.status, json: await res.json() }));
        },
      });
    });
  });
}

test('stop, erase, digest, settings and a viewing confirm change state and send nothing', async () => {
  const api = await openServer();
  try {
    const property = await api.call('/v1/intl/properties', {
      method: 'POST',
      body: JSON.stringify({
        id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
      }),
    });
    assert.equal(property.json.ok, true);
    await api.intl.addProperty({
      id: 'P2', title: 'Bay', kind: 'rent', price: 90000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
    }, '42');
    const slot = await api.intl.addSlot('P1', { start_utc: '2026-10-30T07:00:00.000Z' }, '42');
    assert.equal(slot.ok, true);
    const first = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:layla', sender_name: 'Layla', text: 'Can I see it tomorrow?',
      property_id: 'P1', dedup_key: 'ui-act-1', fixture: true,
    });
    const other = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:layla', sender_name: 'Layla', text: 'What is the price?',
      property_id: 'P2', dedup_key: 'ui-act-2', fixture: true,
    });
    assert.notEqual(other.lead_id, first.lead_id);
    const locked = await api.call('/v1/intl/settings', { method: 'POST', body: JSON.stringify({ manual_approval: false }) });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error_code, 'locked');
    const auto = await api.call('/v1/intl/settings', { method: 'POST', body: JSON.stringify({ auto_send_hot: true }) });
    assert.equal(auto.status, 200);
    assert.equal(auto.json.ok, true);
    const saved = await api.call('/v1/intl/settings');
    assert.equal(saved.json.auto_send_hot, true);
    const booked = await api.intl.book(first.lead_id, slot.id, '42');
    const confirmed = await api.call(`/v1/intl/viewings/${booked.id}/confirm`, { method: 'POST', body: '{}' });
    assert.equal(confirmed.json.status, 'confirmed');
    const stopped = await api.call(`/v1/intl/leads/${first.lead_id}/stop`, { method: 'POST', body: '{}' });
    assert.equal(stopped.json.ok, true);
    assert.equal(stopped.json.sent, false);
    assert.equal(stopped.json.simulated, true);
    assert.equal(api.intl.lead(first.lead_id).status, 'stopped');
    assert.equal(api.intl.lead(other.lead_id).status, 'stopped');
    assert.equal(api.intl.store.one('SELECT COUNT(*) AS n FROM i_send').n, 0);
    assert.ok(api.intl.store.one('SELECT channel FROM i_optout'));
    const digest = await api.call('/v1/intl/digest/send', { method: 'POST', body: '{}' });
    assert.equal(digest.json.telegram_delivery, false);
    assert.equal(digest.json.sent, false);
    assert.equal(digest.json.simulated, true);
    assert.equal(digest.json.digest_sent_on_demand, true);
    const erased = await api.call(`/v1/intl/leads/${first.lead_id}/erase`, { method: 'POST', body: '{}' });
    assert.equal(erased.json.ok, true);
    assert.equal(erased.json.optout_kept, true);
    assert.equal(api.intl.lead(first.lead_id), null);
    const missing = await api.call('/v1/intl/leads/missing/stop', { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
  } finally {
    await api.close();
  }
});
