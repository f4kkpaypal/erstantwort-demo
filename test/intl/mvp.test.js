'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { analyze } = require('../../core/intl/analyze');
const { scoreChat } = require('../../core/intl/score');
const { buildOptions, sentenceCount, BROKER_EN, BROKER_RU } = require('../../core/intl/options');
const { createIntl } = require('../../core/intl/service');
const { signInitData } = require('../../core/uiAuth');
const { buildIntlServer, bootError } = require('../../engine/intlServer');

const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
const RULES = PACK.reply_rules;
const NOW = new Date('2026-10-28T04:30:00.000Z');

function propertyOf(id) {
  const row = PACK.meta.properties[id];
  return { ...row, currency: row.cur, price_period: row.period };
}

function judged(message) {
  const property = propertyOf(message.property_id);
  const analysis = analyze({ kind: 'text', text: message.text }, { propertyKind: property.kind, senderName: message.sender_name });
  const scored = scoreChat(analysis, property, 3.6725);
  const flags = new Set(analysis.flags);
  if (scored.budget_low) flags.add('budget_low');
  return { analysis, scored, flags };
}

function cfg(dir, extra = {}) {
  return loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TG_TEST_LEAD_IDS: '42,9300000001,9300000002,9400000001,9400000002,9400000003,9200000001,9200000002',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:8791',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
    ...extra,
  });
}

function openIntl(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-'));
  const config = cfg(dir, extra);
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => NOW });
  return { dir, config, intl };
}

test('D1 D2 D3 the 25 messages match intent, fields, score and grade', () => {
  const grades = { HOT: 0, WARM: 0, COLD: 0 };
  for (const message of PACK.messages) {
    const { analysis, scored, flags } = judged(message);
    const expected = message.expected;
    assert.equal(analysis.intent, expected.intent, message.id);
    assert.equal(analysis.language, expected.language, message.id);
    assert.deepEqual(analysis.also, expected.also, message.id);
    assert.deepEqual(analysis.budget, expected.budget, message.id);
    assert.equal(analysis.timing ? analysis.timing.class : null, expected.timing_class, message.id);
    assert.equal(analysis.cash, expected.cash, message.id);
    assert.deepEqual([...flags].sort(), [...expected.flags].sort(), message.id);
    assert.equal(scored.score, expected.score, message.id);
    assert.equal(scored.grade, expected.grade, message.id);
    grades[scored.grade] += 1;
  }
  assert.deepEqual(grades, { HOT: 6, WARM: 8, COLD: 11 });
});

test('D5 and D6 reply options stay inside the rules', () => {
  const re = { en: new RegExp(RULES.never_regex.en, 'i'), ru: new RegExp(RULES.never_regex.ru, 'i') };
  let withOptions = 0;
  let without = 0;
  for (const message of PACK.messages) {
    const property = propertyOf(message.property_id);
    const { analysis } = judged(message);
    const options = buildOptions(
      { analysis, clean_name: analysis.name.name },
      property,
      property.slots.map((start) => ({ start_utc: start })),
    );
    if (message.expected.options.count === 0) {
      without += 1;
      assert.equal(options.length, 0, message.id);
      continue;
    }
    withOptions += 1;
    assert.ok(options.length >= 3 && options.length <= 4, message.id);
    const lang = analysis.language === 'ru' ? 'ru' : 'en';
    const price = lang === 'ru' ? property.price_ru : property.price_en;
    assert.ok(options.some((row) => row.text.includes(price)), message.id);
    const needPhrase = ['docs', 'finance', 'details', 'area', 'avail'].includes(analysis.intent) || analysis.asks_discount;
    for (const row of options) {
      assert.ok(sentenceCount(row.text) <= 3, `${message.id} ${row.text}`);
      const low = row.text.toLowerCase();
      for (const piece of RULES.never_substrings[lang]) assert.equal(low.includes(piece), false, piece);
      assert.equal(re[lang].test(row.text), false, row.text);
      if (needPhrase) assert.ok(row.text.includes(lang === 'ru' ? BROKER_RU : BROKER_EN));
    }
  }
  assert.equal(withOptions, 18);
  assert.equal(without, 7);
});

test('D7 D8 D9 D18 D26 D27 seeded leads do not send until asked', async () => {
  const { intl } = openIntl();
  const counts = await intl.seed(PACK, 'all');
  assert.deepEqual(counts, { HOT: 6, WARM: 8, COLD: 11 });
  assert.equal(intl.store.one('SELECT COUNT(*) AS n FROM i_send').n, 0);
  assert.equal(intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE direction='out'`).n, 0);
  const digest = intl.digest();
  assert.deepEqual(digest.write_first.map((row) => row.id), PACK.expected_digest.write_first_top5);
  assert.deepEqual(digest.listed_value.map((row) => row.sum).sort(), [175000, 310000]);
  const stopped = await intl.send('T14', { manual: true, idempotency_key: 'k-stop' }, '42');
  assert.equal(stopped.error_code, 'lead_stopped');
  const draft = await intl.saveDraft('T01', { text: 'Hello from the broker.', option_id: 'two', base_version: null });
  assert.equal(draft.ok, true);
  const first = await intl.send('T01', { draft_version: draft.version, idempotency_key: 'k1' }, '42');
  const again = await intl.send('T01', { draft_version: draft.version, idempotency_key: 'k1' }, '42');
  assert.equal(first.ok, true);
  assert.equal(again.send_id, first.send_id);
  const dup = await intl.send('T01', { draft_version: draft.version, idempotency_key: 'k2' }, '42');
  assert.equal(dup.error_code, 'duplicate_send');
  const missing = await intl.send('T02', { idempotency_key: '' }, '42');
  assert.equal(missing.error_code, 'idempotency_required');
  await intl.ingest({
    channel: 'wa_sim', fixture: true, sender_id: PACK.messages[0].sender_id, sender_name: 'Omar',
    property_id: 'P1', text: 'Can I see it tomorrow?', dedup_key: 'second-omar',
  });
  await intl.saveDraft('T01', { text: 'Hello from the broker.', option_id: 'two', base_version: null });
  const resent = await intl.send('T01', { draft_version: 1, idempotency_key: 'k3' }, '42');
  assert.equal(resent.ok, true);
  const review = await intl.ingest({
    channel: 'wa_sim', fixture: true, sender_id: 'sim:s3', sender_name: 'Ada', property_id: 'P4',
    text: 'asdf ### click here: promo-link', dedup_key: 's3',
  });
  assert.equal(review.status, 'review');
  const manual = await intl.saveDraft(review.lead_id, { text: 'Hello, what are you looking for?', option_id: null });
  const sent = await intl.send(review.lead_id, { draft_version: manual.version, manual: true, idempotency_key: 'man' }, '42');
  assert.equal(sent.ok, true);
  const out = intl.store.one(`SELECT text FROM i_message WHERE lead_id = ? AND direction = 'out'`, [review.lead_id]);
  assert.match(out.text, /AI-assisted/);
  assert.equal(out.text.split('Reply STOP to opt out.').length - 1, 1);
  intl.close();
});

test('D13 D15 boot refuses real data and a public demo without auth', () => {
  const https = cfg(fs.mkdtempSync(path.join(os.tmpdir(), 'intl-')), {
    DEMO_UI_NO_AUTH: 'true',
    UI_PUBLIC_BASE: 'https://example.onrender.com',
  });
  assert.equal(bootError(https), 'demo_ui_no_auth_blocked');
  const real = cfg(fs.mkdtempSync(path.join(os.tmpdir(), 'intl-')), { REAL_DATA_ALLOWED: 'true' });
  assert.equal(bootError(real), 'real_data_blocked');
});

test('D24 D29 telegram fixtures dedupe and respect the test list', async () => {
  const { intl } = openIntl();
  await intl.addProperty({
    id: 'P1', title: '2BR', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year',
    tz: 'Asia/Dubai', tz_label_en: 'Dubai time', tz_label_ru: 'время Дубая',
  }, '42');
  const first = await intl.telegram({ update_id: 1, message: { message_id: 77, chat: { id: 9300000001 }, text: '/lead P1 Is it available?', from: { first_name: 'A' } } });
  const repeat = await intl.telegram({ update_id: 1, message: { message_id: 77, chat: { id: 9300000001 }, text: '/lead P1 Is it available?' } });
  const other = await intl.telegram({ update_id: 2, message: { message_id: 77, chat: { id: 9300000002 }, text: '/lead P1 Is it available?', from: { first_name: 'B' } } });
  const foreign = await intl.telegram({ update_id: 3, message: { message_id: 1, chat: { id: 999 }, text: 'Hi' } });
  assert.equal(repeat.duplicate, true);
  assert.equal(foreign.stored, false);
  assert.equal(intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE direction='in'`).n, 2);
  assert.ok(first.lead_id);
  assert.ok(other.lead_id);
  intl.store.run(
    `INSERT INTO i_send (send_id, lead_id, reply_to_message_id, draft_hash, manual, idempotency_key, status, created_at, updated_at)
     VALUES ('old', ?, 'm', 'h', 0, 'old-key', 'sending', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    [first.lead_id],
  );
  intl.close();
  const again = createIntl(cfg(path.dirname(intl.store.file)), { file: intl.store.file, clock: () => NOW });
  const row = again.store.one(`SELECT status, fail_reason FROM i_send WHERE send_id='old'`);
  assert.equal(row.status, 'failed');
  assert.equal(row.fail_reason, 'stale_sending');
  again.close();
});

test('D28 normalization catches digits, bidi marks, homoglyphs and long text', () => {
  const digits = analyze({ text: 'бюджет ٩٠٠٠ дирхамов в месяц' }, { propertyKind: 'rent' });
  assert.equal(digits.budget.amount, 9000);
  assert.equal(digits.budget.currency, 'AED');
  const hidden = analyze({ text: 's\u200btop' }, {});
  assert.equal(hidden.intent, 'stop');
  const wide = analyze({ text: 'price ＄３００' }, { propertyKind: 'sale' });
  assert.equal(wide.budget && wide.budget.amount, 300);
  const empty = analyze({ text: '   ' }, {});
  assert.equal(empty.intent, 'unclear');
  const long = analyze({ text: 'a'.repeat(2001) }, {});
  assert.equal(long.intent, 'unclear');
  const photo = analyze({ kind: 'non_text', non_text_type: 'photo' }, {});
  assert.ok(photo.flags.includes('non_text'));
  const named = analyze({ text: 'Hi' }, { senderName: '<img onerror=alert(1)>' });
  assert.equal(named.name.name, '');
  assert.equal(named.name.sanitized, true);
});

test('D11 warmed rules stay under one second', () => {
  const sample = PACK.messages[0];
  const property = propertyOf(sample.property_id);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 100; i += 1) {
    const analysis = analyze({ text: sample.text }, { propertyKind: property.kind });
    scoreChat(analysis, property, 3.6725);
    buildOptions({ analysis, clean_name: 'Omar' }, property, []);
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms / 100 < 1000, String(ms));
});

test('D10 a grounded mock can be rejected and a stop from the model is ignored', async () => {
  const { analyzeWithLlm } = require('../../core/intl/llm');
  const kept = await analyzeWithLlm('asdf', {
    config: cfg(os.tmpdir()),
    llm: async () => ({ content: JSON.stringify({ intent: 'price', budget: { amount: 999, currency: 'USD', period: 'total' }, language: 'en', confidence: 0.9 }) }),
  });
  assert.equal(kept.source, 'rules');
  const stop = await analyzeWithLlm('hello there friend', {
    config: cfg(os.tmpdir()),
    llm: async () => ({ content: JSON.stringify({ intent: 'stop', language: 'en', confidence: 1 }) }),
  });
  assert.notEqual(stop.intent, 'stop');
});

test('D17 D20 a sixth slot is refused and a restart keeps the rows', async () => {
  const { dir, config, intl } = openIntl();
  const file = intl.store.file;
  await intl.addProperty({
    id: 'P9', title: 'Test', kind: 'rent', price: 1000, currency: 'USD', price_period: 'month',
    tz: 'Asia/Dubai', tz_label_en: 'Dubai time', tz_label_ru: 'время Дубая',
  }, '42');
  const past = await intl.addSlot('P9', { start_utc: '2020-01-01T10:00:00.000Z' }, '42');
  assert.equal(past.error_code, 'slot_in_past');
  for (let i = 1; i <= 5; i += 1) {
    const added = await intl.addSlot('P9', { start_utc: new Date(NOW.getTime() + i * 86400000).toISOString() }, '42');
    assert.equal(added.ok, true, String(i));
  }
  const sixth = await intl.addSlot('P9', { start_utc: new Date(NOW.getTime() + 8 * 86400000).toISOString() }, '42');
  assert.equal(sixth.error_code, 'slot_limit');
  await intl.seed(PACK, 'all');
  const before = intl.store.one('SELECT COUNT(*) AS n FROM i_lead').n;
  intl.close();
  const again = createIntl(config, { file, clock: () => NOW });
  assert.equal(again.store.one('SELECT COUNT(*) AS n FROM i_lead').n, before);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EN and RU dictionaries have the same keys', () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'i18n', 'en.json'), 'utf8'));
  const ru = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'i18n', 'ru.json'), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
});

test('signed initData opens the intl API and a stranger is refused', async () => {
  const { config, intl } = openIntl();
  const server = buildIntlServer(config, intl);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const headersFor = (id) => ({
    Authorization: `tma ${signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id }),
    }, config.TELEGRAM_BOT_TOKEN)}`,
  });
  const closed = await fetch(`http://127.0.0.1:${port}/v1/intl/leads`);
  const foreign = await fetch(`http://127.0.0.1:${port}/v1/intl/leads`, { headers: headersFor(7) });
  const allowed = await fetch(`http://127.0.0.1:${port}/v1/intl/leads`, { headers: headersFor(42) });
  assert.equal(closed.status, 401);
  assert.equal(foreign.status, 403);
  assert.equal(allowed.status, 200);
  server.close();
  intl.close();
});
