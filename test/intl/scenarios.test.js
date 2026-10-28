'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');

const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
const NOW = new Date('2026-10-28T04:30:00.000Z');

function openIntl(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TG_TEST_LEAD_IDS: '42,9300000001,9300000002,9400000001,9400000002,9400000003,9200000001,9200000002,tg:9200000001,tg:9200000002',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:8791',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
    ...extra,
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => NOW });
  return { dir, config, intl };
}

async function properties(intl) {
  for (const [id, row] of Object.entries(PACK.meta.properties)) {
    await intl.addProperty({
      id, title: row.title, kind: row.kind, price: row.price, currency: row.cur, price_period: row.period,
      tz: row.tz, tz_label_en: row.tz_label_en, tz_label_ru: row.tz_label_ru, ref_en: row.ref_en, ref_ru: row.ref_ru,
    }, '42');
  }
}

async function inbound(intl, fields) {
  return intl.ingest({
    channel: fields.channel,
    sender_id: fields.sender_id,
    sender_name: 'Demo',
    text: fields.text,
    property_id: fields.property_id,
    dedup_key: fields.dedup_key || `${fields.channel}:${fields.sender_id}:${fields.property_id}:${fields.text}:${Math.random()}`,
    reply_target: fields.sender_id,
  });
}

async function draftAndSend(intl, leadId, text, key) {
  const saved = await intl.saveDraft(leadId, { text, option_id: 'two' });
  return intl.send(leadId, { draft_version: saved.version, idempotency_key: key }, '42');
}

test('SC1 a second message keeps the budget and allows the same template again', async () => {
  const { intl } = openIntl();
  await properties(intl);
  const first = await inbound(intl, { channel: 'wa_sim', sender_id: 'sim:s1', property_id: 'P1', text: 'Is the Marina flat still available?' });
  const card = intl.lead(first.lead_id);
  assert.equal(card.intent, 'avail');
  assert.equal(card.status, 'pending_approval');
  assert.ok(card.options.length >= 3 && card.options.length <= 4);
  const sent = await draftAndSend(intl, first.lead_id, 'Hello, the broker will confirm this personally.', 'sc1-a');
  assert.equal(sent.ok, true);
  assert.equal(intl.lead(first.lead_id).status, 'sent');
  const second = await inbound(intl, { channel: 'wa_sim', sender_id: 'sim:s1', property_id: 'P1', text: 'Can you do 100,000 AED per year? Can I see it tomorrow?' });
  assert.equal(second.lead_id, first.lead_id);
  const again = intl.lead(first.lead_id);
  assert.equal(again.intent, 'viewing');
  assert.deepEqual(again.also, ['price']);
  assert.equal(again.budget_amount, 100000);
  assert.equal(again.budget_currency, 'AED');
  assert.equal(again.budget_period, 'year');
  assert.equal(again.timing_class, 'concrete');
  assert.equal(again.status, 'pending_approval');
  assert.equal(again.draft, null);
  assert.ok(again.options.length >= 3);
  const resent = await draftAndSend(intl, first.lead_id, 'Hello, the broker will confirm this personally.', 'sc1-b');
  assert.equal(resent.ok, true);
  intl.close();
});

test('SC2 opt-out stops every lead from that sender', async () => {
  const { intl } = openIntl();
  await properties(intl);
  const a = await inbound(intl, { channel: 'telegram', sender_id: 'tg:9200000001', property_id: 'P1', text: 'Can I view the flat Friday?' });
  const b = await inbound(intl, { channel: 'telegram', sender_id: 'tg:9200000002', property_id: 'P1', text: 'Is it available?' });
  assert.equal(intl.lead(a.lead_id).status, 'pending_approval');
  const stop = await inbound(intl, { channel: 'telegram', sender_id: 'tg:9200000001', property_id: 'P1', text: 'STOP' });
  assert.equal(intl.lead(stop.lead_id).status, 'stopped');
  assert.equal(intl.lead(stop.lead_id).optout, true);
  const other = await inbound(intl, { channel: 'telegram', sender_id: 'tg:9200000001', property_id: 'P2', text: 'What is the price?' });
  assert.notEqual(other.lead_id, a.lead_id);
  assert.equal(intl.lead(other.lead_id).status, 'stopped');
  assert.equal(intl.lead(other.lead_id).options.length, 0);
  const blocked = await intl.send(a.lead_id, { manual: true, idempotency_key: 'sc2' }, '42');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error_code, 'lead_stopped');
  assert.equal(intl.lead(b.lead_id).status, 'pending_approval');
  assert.equal(intl.lead(b.lead_id).optout, false);
  intl.close();
});

test('SC3 a manual reply is reachable from review and blocked after STOP', async () => {
  const { intl } = openIntl();
  await properties(intl);
  const review = await inbound(intl, { channel: 'wa_sim', sender_id: 'sim:s3', property_id: 'P4', text: 'asdf ### click here: promo-link' });
  const card = intl.lead(review.lead_id);
  assert.equal(card.status, 'review');
  assert.equal(card.options.length, 0);
  assert.equal(card.manual_allowed, true);
  const draft = await intl.saveDraft(review.lead_id, { text: 'Hello! Could you tell me what you are looking for?', option_id: null });
  const sent = await intl.send(review.lead_id, { draft_version: draft.version, manual: true, idempotency_key: 'sc3a' }, '42');
  assert.equal(sent.ok, true);
  const out = intl.store.one(`SELECT text FROM i_message WHERE lead_id=? AND direction='out'`, [review.lead_id]);
  assert.match(out.text, /AI-assisted/);
  assert.equal(out.text.split('Reply STOP to opt out.').length - 1, 1);
  const plain = await intl.send(review.lead_id, { draft_version: draft.version, idempotency_key: 'sc3-nom' }, '42');
  assert.equal(plain.error_code, 'manual_required');
  const next = await inbound(intl, { channel: 'wa_sim', sender_id: 'sim:s3b', property_id: 'P1', text: 'Can I view it Friday?' });
  const rejected = await intl.reject(next.lead_id, '42');
  assert.equal(rejected.status, 'review');
  assert.equal(intl.lead(next.lead_id).draft, null);
  const manual = await intl.saveDraft(next.lead_id, { text: 'Hi, Friday 11:00 works if you confirm with the broker.', option_id: null });
  const sent2 = await intl.send(next.lead_id, { draft_version: manual.version, manual: true, idempotency_key: 'sc3b' }, '42');
  assert.equal(sent2.ok, true);
  const stopped = await inbound(intl, { channel: 'wa_sim', sender_id: 'sim:s3c', property_id: 'P1', text: 'STOP' });
  const no = await intl.send(stopped.lead_id, { manual: true, idempotency_key: 'sc3c' }, '42');
  assert.equal(no.error_code, 'lead_stopped');
  intl.close();
});

test('SC4 a stale sending row fails on restart and a new send is allowed', async () => {
  const { dir, config, intl } = openIntl();
  await properties(intl);
  const lead = await inbound(intl, { channel: 'wa_sim', sender_id: 'sim:s4', property_id: 'P1', text: 'Can I view it tomorrow?' });
  intl.store.run(
    `INSERT INTO i_send (send_id, lead_id, reply_to_message_id, draft_hash, manual, idempotency_key, status, created_at, updated_at)
     VALUES ('stale', ?, 'old', 'old-hash', 0, 'stale-key', 'sending', ?, ?)`,
    [lead.lead_id, new Date(NOW.getTime() - 300000).toISOString(), new Date(NOW.getTime() - 300000).toISOString()],
  );
  const file = intl.store.file;
  intl.close();
  const again = createIntl(config, { file, clock: () => NOW });
  const row = again.store.one(`SELECT status, fail_reason FROM i_send WHERE send_id='stale'`);
  assert.equal(row.status, 'failed');
  assert.equal(row.fail_reason, 'stale_sending');
  assert.equal(again.lead(lead.lead_id).stale_sending, true);
  const saved = await again.saveDraft(lead.lead_id, { text: 'A fresh reply.', option_id: 'two' });
  const sent = await again.send(lead.lead_id, { draft_version: saved.version, idempotency_key: 'sc4' }, '42');
  assert.equal(sent.ok, true);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SC5 the same Telegram update is one message and another chat is a second', async () => {
  const { intl } = openIntl();
  await properties(intl);
  await intl.telegram({ update_id: 1, message: { message_id: 77, chat: { id: '9300000001' }, text: 'Is it available?', from: { first_name: 'A' } } });
  await intl.telegram({ update_id: 1, message: { message_id: 77, chat: { id: '9300000001' }, text: 'Is it available?' } });
  assert.equal(intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE direction='in'`).n, 1);
  await intl.telegram({ update_id: 2, message: { message_id: 77, chat: { id: '9300000002' }, text: 'Is it available?', from: { first_name: 'B' } } });
  assert.equal(intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE direction='in'`).n, 2);
  intl.close();
});

test('SC6 Business replies need can_reply and a 24 hour window', async () => {
  const { intl } = openIntl();
  await properties(intl);
  const young = Math.floor((NOW.getTime() - 2 * 3600000) / 1000);
  await intl.telegram({ business_connection: { id: 'bc_test_1', is_enabled: true, rights: { can_reply: true } } });
  const ok = await intl.telegram({
    business_message: { message_id: 1, chat: { id: '9400000001' }, text: 'Hi, price?', date: young, business_connection_id: 'bc_test_1', from: { first_name: 'A' } },
  });
  assert.equal(ok.stored, true);
  const saved = await intl.saveDraft(ok.lead_id, { text: 'The listed price is on the property.', option_id: 'price' });
  const sent = await intl.send(ok.lead_id, { draft_version: saved.version, idempotency_key: 'sc6a' }, '42');
  assert.equal(sent.ok, true);
  await intl.telegram({ business_connection: { id: 'bc_test_2', is_enabled: true, rights: { can_reply: false } } });
  const blockedLead = await intl.telegram({
    business_message: { message_id: 2, chat: { id: '9400000002' }, text: 'Hi, price?', date: young, business_connection_id: 'bc_test_2', from: { first_name: 'B' } },
  });
  const draft = await intl.saveDraft(blockedLead.lead_id, { text: 'The listed price is on the property.', option_id: 'price' });
  const denied = await intl.send(blockedLead.lead_id, { draft_version: draft.version, idempotency_key: 'sc6b' }, '42');
  assert.equal(denied.error_code, 'cannot_reply');
  await intl.telegram({
    business_message: { message_id: 8, chat: { id: '9400000002' }, text: 'Hi, price?', date: young, business_connection_id: 'bc_test_2', can_reply: true, from: { first_name: 'B' } },
  });
  assert.equal(intl.store.one('SELECT can_reply FROM i_tg_conn WHERE business_connection_id = ?', ['bc_test_2']).can_reply, 0);
  const aged = await intl.telegram({
    business_message: { message_id: 3, chat: { id: '9400000001' }, text: 'Is it available now?', date: Math.floor((NOW.getTime() - 25 * 3600000) / 1000), business_connection_id: 'bc_test_1', from: { first_name: 'A' } },
  });
  const agedDraft = await intl.saveDraft(aged.lead_id, { text: 'Still checking the listing.', option_id: 'ask' });
  const late = await intl.send(aged.lead_id, { draft_version: agedDraft.version, idempotency_key: 'sc6c' }, '42');
  assert.equal(late.error_code, 'window_closed');
  const foreign = await intl.telegram({
    business_message: { message_id: 9, chat: { id: '9999999999' }, text: 'Hi', business_connection_id: 'bc_x', can_reply: true },
  });
  assert.equal(foreign.stored, false);
  assert.equal(intl.store.one(`SELECT value FROM i_settings WHERE key='dropped_non_test'`).value, '1');
  intl.close();
});

test('SC7 an edited Business message stays on the same lead and a delete clears the text', async () => {
  const { intl } = openIntl();
  await properties(intl);
  const created = await intl.telegram({
    business_message: { message_id: 5, chat: { id: '9400000003' }, text: 'Can I view Friday?', business_connection_id: 'bc_test_3', can_reply: true, from: { first_name: 'C' } },
  });
  assert.equal(intl.lead(created.lead_id).intent, 'viewing');
  await intl.saveDraft(created.lead_id, { text: 'A draft that the edit must drop.', option_id: 'ask' });
  const before = intl.store.one('SELECT COUNT(*) AS n FROM i_lead').n;
  await intl.telegram({
    edited_business_message: { message_id: 5, chat: { id: '9400000003' }, text: 'Can I view Saturday?' },
  });
  assert.equal(intl.store.one('SELECT COUNT(*) AS n FROM i_lead').n, before);
  assert.equal(intl.lead(created.lead_id).intent, 'viewing');
  assert.equal(intl.store.one('SELECT lead_id FROM i_draft WHERE lead_id = ?', [created.lead_id]), null);
  assert.match(intl.store.one('SELECT text FROM i_message WHERE dedup_key = ?', ['telegram:9400000003:5']).text, /Saturday/);
  await intl.telegram({
    edited_business_message: { message_id: 5, chat: { id: '9400000003' }, text: 'please stop' },
  });
  assert.equal(intl.lead(created.lead_id).status, 'stopped');
  const other = await intl.telegram({
    message: { message_id: 5, chat: { id: '9400000001' }, text: '/lead P1 Keep this text', from: { first_name: 'Z' } },
  });
  assert.equal(other.stored, true);
  await intl.telegram({ deleted_business_messages: { chat: { id: '9400000003' }, message_ids: [5] } });
  assert.equal(intl.store.one('SELECT text FROM i_message WHERE dedup_key = ?', ['telegram:9400000003:5']).text, '');
  assert.match(intl.store.one('SELECT text FROM i_message WHERE dedup_key = ?', ['telegram:9400000001:5']).text, /Keep this text/);
  intl.close();
});

test('SC8 the morning digest sends once, catches up late, and /digest stays on the allow list', async () => {
  const { dir, config, intl } = openIntl();
  let clock = new Date('2026-10-28T04:30:00.000Z');
  intl.setClock(() => clock);
  const first = intl.digestTick('schedule', '42');
  assert.equal(first.digest_sent, 1);
  assert.equal(first.label, '');
  clock = new Date('2026-10-28T04:31:00.000Z');
  const repeat = intl.digestTick('schedule', '42');
  assert.equal(repeat.digest_sent, 1);
  assert.equal(repeat.skipped, true);
  intl.close();
  clock = new Date('2026-10-29T11:00:00.000Z');
  const restarted = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => clock });
  const late = restarted.digestTick('startup', '42');
  assert.equal(late.digest_sent, 2);
  assert.equal(late.label, 'late');
  const allowed = restarted.digestTick('demand', '42');
  const foreign = restarted.digestTick('demand', '99');
  assert.equal(allowed.digest_sent_on_demand, true);
  assert.equal(foreign.digest_sent_on_demand, false);
  restarted.close();
});
