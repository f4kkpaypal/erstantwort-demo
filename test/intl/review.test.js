'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { analyze } = require('../../core/intl/analyze');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');

const NOW = new Date('2026-10-28T04:30:00.000Z');

function openIntl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TG_TEST_LEAD_IDS: '42',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:8791',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => NOW });
  return { dir, config, intl };
}

test('STOP phrases win and ordinary words that contain stop do not', () => {
  const stops = [
    'Hi is it available? STOP',
    'STOP - how much is it?',
    'please stop',
    'remove me',
    'remove me from your list',
    'Please stop. Is it available',
    "don't message me again",
    'Стоп, а какая цена?',
    'пожалуйста стоп',
    'удалите меня',
  ];
  const keeps = [
    'Can I stop by on Friday to see the flat?',
    'The bus stop is near the marina. What is the price?',
    'I want a non-stop flight and a viewing tomorrow',
    'stopwatch',
  ];
  for (const text of stops) {
    assert.equal(analyze({ text }, { propertyKind: 'rent', propertyCurrency: 'AED' }).intent, 'stop', text);
  }
  for (const text of keeps) {
    assert.notEqual(analyze({ text }, { propertyKind: 'rent', propertyCurrency: 'AED' }).intent, 'stop', text);
  }
});

test('retention clears expired message text and erase keeps the opt-out hash', async () => {
  const { intl } = openIntl();
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  const stopped = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:stop-person', sender_name: 'Layla', text: 'please stop',
    property_id: 'P1', dedup_key: 'rev-stop', fixture: true,
  });
  const kept = intl.store.one('SELECT * FROM i_optout');
  assert.ok(kept);
  const erased = await intl.erase(stopped.lead_id, '42');
  assert.equal(erased.optout_kept, true);
  assert.equal(intl.store.one('SELECT id FROM i_lead WHERE id = ?', [stopped.lead_id]), null);
  assert.equal(intl.store.one('SELECT id FROM i_message WHERE lead_id = ?', [stopped.lead_id]), null);
  assert.equal(intl.store.one('SELECT sender_hash FROM i_optout WHERE sender_hash = ?', [kept.sender_hash]).sender_hash, kept.sender_hash);

  const open = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:keep-person', sender_name: 'Omar Secret', text: 'My budget is AED 90000 a year',
    property_id: 'P1', dedup_key: 'rev-keep', fixture: true,
  });
  intl.store.run(`UPDATE i_lead SET retention_until = ? WHERE id = ?`, ['2020-01-01T00:00:00.000Z', open.lead_id]);
  assert.equal(intl.retain(), 1);
  assert.equal(intl.store.one('SELECT text FROM i_message WHERE lead_id = ?', [open.lead_id]).text, '');
  assert.equal(intl.store.one('SELECT sender_name, clean_name FROM i_lead WHERE id = ?', [open.lead_id]).sender_name, '');
  assert.ok(intl.store.one('SELECT id FROM i_audit WHERE action = ?', ['erase']));
  intl.close();
});

test('property, slot, settings, pipeline and a taken slot are rejected', async () => {
  const { intl } = openIntl();
  const badPrice = await intl.addProperty({
    title: 'X', kind: 'rent', price: -5, currency: 'XYZ', price_period: 'week', tz: 'Asia/Dubai',
  }, '42');
  assert.equal(badPrice.error_code, 'invalid_property');
  const badZone = await intl.addProperty({
    title: 'X', kind: 'rent', price: 10, currency: 'AED', price_period: 'year', tz: 'Mars/Base',
  }, '42');
  assert.equal(badZone.error_code, 'invalid_timezone');
  const once = await intl.addProperty({
    title: 'Sale', kind: 'sale', price: 10, currency: 'USD', price_period: 'once', tz: 'Asia/Dubai',
  }, '42');
  assert.equal(once.ok, true);
  assert.equal(intl.store.one('SELECT price_period FROM i_property WHERE id = ?', [once.id]).price_period, 'total');
  const property = await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  assert.equal(property.ok, true);
  const slot = await intl.addSlot('P1', { start_utc: '2026-10-29T13:00:00.000Z', duration_min: 45 }, '42');
  assert.equal(slot.ok, true);
  assert.equal((await intl.addSlot('P1', { start_utc: '2026-10-30T13:00:00.000Z', duration_min: 20 }, '42')).error_code, 'invalid_slot');
  assert.equal((await intl.settings({ broker_tz: 'Mars/Base' }, '42')).error_code, 'invalid_timezone');
  assert.equal((await intl.settings({ lang: 'de' }, '42')).error_code, 'invalid_settings');
  const lead = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:slot', sender_name: 'Nina', text: 'Can I view it tomorrow?',
    property_id: 'P1', dedup_key: 'rev-slot', fixture: true,
  });
  intl.store.run(`UPDATE i_slot SET status = 'booked' WHERE id = ?`, [slot.id]);
  const draft = await intl.saveDraft(lead.lead_id, {
    text: 'Hi Nina. Thu 29 Oct, 17:00 (Dubai time). (Not reserved yet.)',
    option_id: 'two',
    slot_ids: [slot.id],
  });
  const sent = await intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'rev-slot-send' }, '42');
  assert.equal(sent.error_code, 'slot_unavailable');
  const pipeline = await intl.setPipeline(lead.lead_id, 'nope', '42');
  assert.equal(pipeline.error_code, 'invalid_pipeline');
  assert.equal((await intl.setPipeline(lead.lead_id, 'viewing', '42')).ok, true);
  intl.close();
});

test('free_host refuses to invent a new HASH_SALT', () => {
  const env = { ...process.env };
  delete env.HASH_SALT;
  const result = spawnSync(process.execPath, ['scripts/free_host.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stderr}`, /hash_salt_missing/);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'free_host.js'), 'utf8');
  assert.equal(/HASH_SALT:\s*secret\(/.test(source), false);
});

test('a Telegram text without /lead is not attached to P1', async () => {
  const { intl } = openIntl();
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  const created = await intl.telegram({
    update_id: 11,
    message: { message_id: 4, chat: { id: '42' }, text: 'What is the price?', from: { first_name: 'A' } },
  });
  assert.equal(created.stored, true);
  assert.equal(intl.lead(created.lead_id).property_id, 'general');
  intl.close();
});

test('a failed send rolls the send row back', async () => {
  const { intl } = openIntl();
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  const lead = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:tx', sender_name: 'Omar', text: 'Can I view it tomorrow?',
    property_id: 'P1', dedup_key: 'tx-1', fixture: true,
  });
  const draft = await intl.saveDraft(lead.lead_id, { text: 'Hello Omar. Which day and time suit you?', option_id: 'ask' });
  const original = intl.store.run.bind(intl.store);
  intl.store.run = (sql, params) => {
    if (String(sql).includes('INSERT INTO i_message') && String(sql).includes("'out'")) throw new Error('boom');
    return original(sql, params);
  };
  await assert.rejects(() => intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'tx-send' }, '42'));
  intl.store.run = original;
  assert.equal(intl.store.one('SELECT COUNT(*) AS n FROM i_send WHERE lead_id = ?', [lead.lead_id]).n, 0);
  assert.equal(intl.lead(lead.lead_id).status, 'pending_approval');
  intl.close();
});

test('holdout exits 0 only when every stated expectation matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-'));
  const good = path.join(dir, 'good.json');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(good, JSON.stringify({
    messages: [{ id: 'H', text: 'STOP', property_id: 'P1', expected: { intent: 'stop', language: 'en', grade: 'COLD' } }],
  }));
  fs.writeFileSync(bad, JSON.stringify({
    messages: [{ id: 'H', text: 'STOP', property_id: 'P1', expected: { intent: 'price', language: 'en', grade: 'HOT' } }],
  }));
  const run = (file) => spawnSync(process.execPath, ['scripts/holdout.js', file], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
  });
  const ok = run(good);
  const no = run(bad);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).pass, true);
  assert.equal(no.status, 1);
  assert.equal(JSON.parse(no.stdout).pass, false);
});
