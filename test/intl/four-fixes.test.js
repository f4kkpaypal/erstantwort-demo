'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { analyze } = require('../../core/intl/analyze');
const { matchProperty } = require('../../core/intl/matchProperty');
const { buildOptions, GREET_OTHER } = require('../../core/intl/options');
const { createIntl } = require('../../core/intl/service');

const NOW = new Date('2026-10-28T04:30:00.000Z');
const ASKING = 'Can I view it Thursday at 4pm?';
const RICHER = 'Can I view it Thursday at 4pm? Budget AED 200000 per year, cash.';

function openIntl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-fix-'));
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
    BROKER_TZ: 'Asia/Dubai',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => NOW });
  return {
    intl,
    close() {
      intl.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function addFlat(intl, id, title) {
  return intl.addProperty({
    id,
    title,
    kind: 'rent',
    price: 120000,
    currency: 'AED',
    price_period: 'year',
    tz: 'Asia/Dubai',
    tz_label_en: 'Dubai time',
    tz_label_ru: 'время Дубая',
    listing_url: `https://example.test/${id}`,
    make_brochure: true,
    plan_url: `https://example.test/${id}.png`,
  }, '42');
}

function outbound(intl, id) {
  return intl.store.all(`SELECT text FROM i_message WHERE lead_id = ? AND direction = 'out' ORDER BY created_at`, [id]);
}

test('F1 only Russian and English get a normal reply; other scripts get one greeting', () => {
  const names = fs.readdirSync(path.join(__dirname, '..', '..', 'ui-intl', 'i18n')).filter((name) => name.endsWith('.json'));
  assert.deepEqual(names.sort(), ['en.json', 'ru.json']);

  const arabic = analyze({ text: 'أريد مشاهدة الشقة غداً' });
  assert.equal(arabic.language, 'other');
  const greet = buildOptions({ analysis: arabic, clean_name: 'Nina' }, { id: 'P1', title: 'Marina Gate 2BR', price: 1, currency: 'AED', price_period: 'year' }, [
    { id: 's', start_utc: '2026-10-29T12:00:00.000Z' },
  ]);
  assert.equal(greet.length, 1);
  assert.equal(greet[0].id, 'greet_other');
  assert.equal(greet[0].text, GREET_OTHER);
  assert.equal(greet[0].text.includes('Marina'), false);
  assert.equal(greet[0].slot_ids.length, 0);
  assert.equal(/\d{1,2}:\d{2}/.test(greet[0].text), false);
  assert.equal(analyze({ text: '' }).language, 'other');
  assert.equal(analyze({ text: '😀' }).language, 'other');
  assert.equal(buildOptions({ analysis: analyze({ text: 'STOP' }) }).length, 0);

  const thursday = analyze({ text: 'Thursday 4pm' });
  assert.equal(thursday.language, 'en');
  assert.equal(buildOptions({ analysis: thursday }).some((row) => row.id === 'greet_other'), false);

  const marina = analyze({ text: 'interested in Marina Gate 2BR' });
  assert.equal(marina.language, 'en');
  assert.equal(buildOptions({ analysis: marina }).some((row) => row.id === 'greet_other'), false);

  const russian = analyze({ text: 'Хочу посмотреть завтра' });
  assert.equal(russian.language, 'ru');
  assert.equal(russian.intent, 'viewing');
  const options = buildOptions({
    analysis: russian,
    clean_name: 'Николай',
  }, {
    id: 'P1', title: 'Marina', ref_ru: 'объекту', price: 1000, currency: 'AED', price_period: 'year', price_ru: '1 000 AED в год', tz: 'Asia/Dubai',
  }, [{ id: 's', start_utc: '2026-10-29T12:00:00.000Z' }]);
  assert.ok(options.length >= 3);
  assert.equal(options.some((row) => row.id === 'greet_other'), false);
  assert.match(options[0].text, /завтра|Здравствуйте|спасибо|время/i);
});

test('F2 materials follow an exact title and ignore a shorter name inside a longer one', async () => {
  const gate = { id: 'G', title: 'Marina Gate 2BR', listing_url: 'https://example.test/gate', brochure_url: '/v1/intl/properties/G/brochure.pdf', plan_url: 'https://example.test/g.png', price: 10, currency: 'AED', price_period: 'year', price_en: 'AED 10 / year' };
  assert.equal(matchProperty('interested in Marina Gate 2BR', [gate]).id, 'G');
  assert.equal(matchProperty('Any 2 bedroom in Marina?', [gate]), null);
  assert.equal(matchProperty('JVC Villa?', [{ id: 'V', title: 'JVC Villa' }]).id, 'V');
  assert.equal(matchProperty('just Villa', [{ id: 'V', title: 'JVC Villa' }]), null);
  const bay = { id: 'B', title: 'Bay' };
  assert.equal(matchProperty('Business Bay', [bay]), null);
  assert.equal(matchProperty('Tower A', [{ id: 'A', title: 'Tower A' }, { id: 'C', title: 'Tower A' }]), null);

  const api = openIntl();
  try {
    await addFlat(api.intl, 'P1', 'Marina Gate 2BR');
    await addFlat(api.intl, 'P2', 'Other Tower');
    const hit = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:f2', sender_name: 'Nina', fixture: true,
      text: 'interested in Marina Gate 2BR', dedup_key: 'f2-hit',
    });
    const lead = api.intl.lead(hit.lead_id);
    assert.equal(lead.property_id, 'P1');
    assert.ok(lead.options.some((row) => row.id === 'materials' && row.attachments.length >= 1));
    const miss = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:f2b', sender_name: 'Omar', fixture: true,
      text: 'Any 2 bedroom in Marina?', dedup_key: 'f2-miss',
    });
    const missed = api.intl.lead(miss.lead_id);
    assert.equal(missed.property_id, 'general');
    assert.equal(missed.options.some((row) => row.id === 'materials'), false);
    const kept = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:f2c', sender_name: 'Ada', property_id: 'P2', fixture: true,
      text: 'Business Bay', dedup_key: 'f2-keep',
    });
    assert.equal(api.intl.lead(kept.lead_id).property_id, 'P2');
  } finally {
    api.close();
  }
});

async function hotLead(intl, sender, received, text = ASKING) {
  return intl.ingest({
    channel: 'wa_sim',
    sender_id: sender,
    sender_name: sender,
    property_id: 'P1',
    fixture: true,
    text,
    dedup_key: sender,
    received_at: received,
  });
}

function afterWindow(intl) {
  intl.setClock(() => new Date(NOW.getTime() + 45000));
}

test('F3 the hotter ready lead keeps the time and both replies are simulated', async () => {
  const api = openIntl();
  try {
    await addFlat(api.intl, 'P1', 'Marina Gate 2BR');
    await addFlat(api.intl, 'P2', 'Other Tower');
    const low = await hotLead(api.intl, 'sim:70', '2026-10-28T05:00:00.000Z');
    const high = await hotLead(api.intl, 'sim:82', '2026-10-28T06:00:00.000Z', RICHER);
    assert.ok(api.intl.lead(high.lead_id).score > api.intl.lead(low.lead_id).score);
    assert.equal(api.intl.lead(low.lead_id).readiness, 'HOT');
    assert.equal(api.intl.lead(high.lead_id).readiness, 'HOT');
    await api.intl.settings({ auto_send_hot: true }, '42');
    afterWindow(api.intl);
    await api.intl.settleHot(high.lead_id);
    const start = api.intl.lead(high.lead_id).proposed_utc;
    const holds = api.intl.store.all(`SELECT * FROM i_time_hold WHERE start_utc = ?`, [start]);
    assert.equal(holds.length, 1);
    assert.equal(holds[0].lead_id, high.lead_id);
    const highText = outbound(api.intl, high.lead_id).map((row) => row.text).join('\n');
    const lowText = outbound(api.intl, low.lead_id).map((row) => row.text).join('\n');
    assert.match(highText, /16:00/);
    assert.equal(lowText.includes('16:00'), false);
    assert.match(lowText, /\d{2}:\d{2}/);
    assert.equal(api.intl.lead(high.lead_id).status, 'sent');
    assert.equal(api.intl.lead(low.lead_id).status, 'sent');
    const sends = api.intl.store.all(`SELECT status FROM i_send`);
    assert.ok(sends.length >= 2);
    assert.ok(sends.every((row) => row.status === 'simulated'));
  } finally {
    api.close();
  }
});

test('F3 a pending holder loses the slot to a hotter lead, a sent holder does not', async () => {
  const api = openIntl();
  try {
    await addFlat(api.intl, 'P1', 'Marina Gate 2BR');
    const first = await hotLead(api.intl, 'sim:first', '2026-10-28T05:00:00.000Z');
    assert.equal(api.intl.lead(first.lead_id).status, 'pending_approval');
    const hotter = await hotLead(api.intl, 'sim:hotter', '2026-10-28T06:00:00.000Z', RICHER);
    assert.ok(api.intl.lead(hotter.lead_id).score > api.intl.lead(first.lead_id).score);
    await api.intl.settings({ auto_send_hot: true }, '42');
    afterWindow(api.intl);
    await api.intl.settleHot(hotter.lead_id);
    const start = api.intl.lead(hotter.lead_id).proposed_utc;
    assert.equal(api.intl.store.one(`SELECT lead_id FROM i_time_hold WHERE start_utc = ?`, [start]).lead_id, hotter.lead_id);
    assert.match(outbound(api.intl, hotter.lead_id).map((row) => row.text).join('\n'), /16:00/);
    assert.equal(outbound(api.intl, first.lead_id).map((row) => row.text).join('\n').includes('16:00'), false);
  } finally {
    api.close();
  }
});

test('F3 a lead who was already sent keeps the slot', async () => {
  const api = openIntl();
  try {
    await addFlat(api.intl, 'P1', 'Marina Gate 2BR');
    await api.intl.settings({ auto_send_hot: true }, '42');
    const sent = await hotLead(api.intl, 'sim:sent', '2026-10-28T05:00:00.000Z');
    const owned = api.intl.lead(sent.lead_id).proposed_utc;
    assert.equal(api.intl.lead(sent.lead_id).status, 'sent');
    assert.equal(api.intl.store.one(`SELECT lead_id FROM i_time_hold WHERE start_utc = ?`, [owned]).lead_id, sent.lead_id);
    const before = outbound(api.intl, sent.lead_id).map((row) => row.text).join('\n');
    const later = await hotLead(api.intl, 'sim:later', '2026-10-28T07:00:00.000Z', RICHER);
    assert.ok(api.intl.lead(later.lead_id).score > api.intl.lead(sent.lead_id).score);
    await api.intl.settleHot(later.lead_id);
    assert.equal(api.intl.store.one(`SELECT lead_id FROM i_time_hold WHERE start_utc = ?`, [owned]).lead_id, sent.lead_id);
    assert.equal(outbound(api.intl, sent.lead_id).map((row) => row.text).join('\n'), before);
    assert.equal(outbound(api.intl, later.lead_id).map((row) => row.text).join('\n').includes('16:00'), false);
  } finally {
    api.close();
  }
});

test('F3 equal scores keep the earlier lead, auto off does nothing, and one broker cannot hold one time twice', async () => {
  const api = openIntl();
  try {
    await addFlat(api.intl, 'P1', 'Marina Gate 2BR');
    await addFlat(api.intl, 'P2', 'Other Tower');
    const early = await hotLead(api.intl, 'sim:early', '2026-10-28T05:00:00.000Z');
    const late = await hotLead(api.intl, 'sim:late', '2026-10-28T06:00:00.000Z');
    assert.equal(api.intl.lead(early.lead_id).score, api.intl.lead(late.lead_id).score);
    assert.equal(api.intl.store.all(`SELECT * FROM i_time_hold`).length, 0);
    assert.equal(api.intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE direction = 'out'`).n, 0);
    await api.intl.settings({ auto_send_hot: true }, '42');
    await api.intl.settleHot(late.lead_id);
    const start = api.intl.lead(early.lead_id).proposed_utc;
    assert.equal(api.intl.store.one(`SELECT lead_id FROM i_time_hold WHERE start_utc = ?`, [start]).lead_id, early.lead_id);

    const other = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:p2', sender_name: 'P2', property_id: 'P2', fixture: true,
      text: ASKING, dedup_key: 'sim:p2', received_at: '2026-10-28T08:00:00.000Z',
    });
    const before = api.intl.store.all(`SELECT lead_id FROM i_time_hold WHERE start_utc = ?`, [start]);
    await api.intl.settleHot(other.lead_id);
    const after = api.intl.store.all(`SELECT lead_id FROM i_time_hold WHERE start_utc = ?`, [start]);
    assert.equal(after.length, 1);
    assert.equal(after[0].lead_id, before[0].lead_id);
  } finally {
    api.close();
  }
});

test('F4 score, grade and readiness stay on the first inbound message', async () => {
  const api = openIntl();
  try {
    await addFlat(api.intl, 'P1', 'Marina Gate 2BR');
    const first = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:freeze', sender_name: 'Nina', property_id: 'P1', fixture: true,
      text: 'hello', dedup_key: 'freeze-1',
    });
    const opened = api.intl.lead(first.lead_id);
    const second = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:freeze', sender_name: 'Nina', property_id: 'P1', fixture: true,
      text: 'I want a viewing tomorrow and my budget is AED 200000 per year', dedup_key: 'freeze-2',
    });
    assert.equal(second.lead_id, first.lead_id);
    const frozen = api.intl.lead(first.lead_id);
    assert.equal(frozen.score, opened.score);
    assert.equal(frozen.grade, opened.grade);
    assert.equal(frozen.readiness, opened.readiness);
    assert.deepEqual(frozen.reasons, opened.reasons);

    const fresh = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:fresh', sender_name: 'Omar', property_id: 'P1', fixture: true,
      text: 'I want a viewing tomorrow and my budget is AED 200000 per year', dedup_key: 'freeze-fresh',
    });
    const calculated = api.intl.lead(fresh.lead_id);
    assert.notEqual(calculated.score, frozen.score);
    assert.equal(calculated.readiness, 'HOT');

    const timed = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:time', sender_name: 'Ada', property_id: 'P1', fixture: true,
      text: 'Thursday 4pm', dedup_key: 'freeze-time',
    });
    const timedScore = api.intl.lead(timed.lead_id).score;
    assert.equal(api.intl.lead(timed.lead_id).readiness, 'HOT');
    await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:time', sender_name: 'Ada', property_id: 'P1', fixture: true,
      text: 'ok 👍', dedup_key: 'freeze-ok',
    });
    assert.equal(api.intl.lead(timed.lead_id).readiness, 'HOT');
    assert.equal(api.intl.lead(timed.lead_id).score, timedScore);
  } finally {
    api.close();
  }
});
