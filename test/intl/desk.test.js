'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');
const { loadConfig } = require('../../core/config');
const { classifyReadiness } = require('../../core/intl/readiness');
const { parseProposal } = require('../../core/intl/when');
const { createBrokerCalendar } = require('../../core/intl/calendar');
const { buildOptions, rewriteReplyTime, sentenceCount } = require('../../core/intl/options');
const { createIntl } = require('../../core/intl/service');

const NOW = new Date('2026-10-28T04:30:00.000Z');
const ZONE = 'Asia/Dubai';

function dubai(iso) {
  return DateTime.fromISO(iso, { setZone: true }).setZone(ZONE).toFormat('HH:mm');
}

function property() {
  return {
    id: 'P1',
    title: '2BR, Dubai Marina',
    ref_en: 'the 2BR in Dubai Marina',
    ref_ru: 'объекту «2BR, Dubai Marina»',
    kind: 'rent',
    price: 120000,
    currency: 'AED',
    price_period: 'year',
    tz: ZONE,
    tz_label_en: 'Dubai time',
    tz_label_ru: 'время Дубая',
    price_en: 'AED 120,000 / year',
    price_ru: '120 000 AED в год',
  };
}

test('readiness marks a viewing, a named time, or cash as HOT', () => {
  const hot = [
    'Can I book a viewing tomorrow?',
    'Thursday 4pm works for a visit',
    'I can come tomorrow at 15:00',
    'Ready to buy, cash is available',
    'I will pay the deposit tomorrow',
    'Можно просмотр завтра?',
    'четверг 16:00, хочу посмотреть',
    'завтра в 15:00 приеду',
    'Готов купить, наличные есть',
    '29 Oct at 16:00',
  ];
  for (const text of hot) assert.equal(classifyReadiness(text).label, 'HOT', text);
});

test('readiness marks a clarifying question as WARM and chatter as COLD', () => {
  const warm = [
    'What is the price?',
    'Where is it located?',
    'How many bedrooms?',
    'Какая цена?',
    'Где это?',
    'Сколько комнат?',
    'What is the deposit?',
    'Is the apartment still available?',
  ];
  for (const text of warm) assert.equal(classifyReadiness(text).label, 'WARM', text);
  const cold = [
    'hi',
    'hello Nina',
    'lol',
    'asdf qwerty',
    'click here https://spam.example/deal',
    'nice weather outside',
  ];
  for (const text of cold) {
    assert.equal(classifyReadiness(text).label, 'COLD', text);
  }
  assert.equal(classifyReadiness('STOP', { intent: 'stop' }).label, 'COLD');
  assert.equal(classifyReadiness('What is the price? Can I view it tomorrow?').label, 'HOT');
});

test('a client clock is kept only when a day sits next to it', () => {
  const thursday = parseProposal('Thursday 4pm works', ZONE, NOW);
  assert.equal(dubai(thursday.start_utc), '16:00');
  assert.equal(DateTime.fromISO(thursday.start_utc, { setZone: true }).setZone(ZONE).toISODate(), '2026-10-29');
  const ru = parseProposal('Можно в четверг в 16:00?', ZONE, NOW);
  assert.equal(dubai(ru.start_utc), '16:00');
  const tomorrow = parseProposal('завтра в 15:00', ZONE, NOW);
  assert.equal(dubai(tomorrow.start_utc), '15:00');
  assert.equal(DateTime.fromISO(tomorrow.start_utc, { setZone: true }).setZone(ZONE).toISODate(), '2026-10-29');
  const pm = parseProposal('tomorrow at 3pm', ZONE, NOW);
  assert.equal(dubai(pm.start_utc), '15:00');
  const today = parseProposal('today at 10:00', ZONE, NOW);
  assert.equal(dubai(today.start_utc), '10:00');
  assert.equal(parseProposal('tomorrow', ZONE, NOW), null);
  assert.equal(parseProposal('around 16:00', ZONE, NOW), null);
  assert.equal(parseProposal('today at 08:00', ZONE, NOW), null);
});

test('the mock calendar skips lunch and injected busy blocks', () => {
  const calendar = createBrokerCalendar({ BROKER_TZ: ZONE }, {
    now: () => NOW,
    busy: [{ start: '2026-10-28T06:00:00.000Z', end: '2026-10-28T07:00:00.000Z' }],
  });
  assert.equal(calendar.mode, 'mock');
  assert.equal(calendar.source, 'mock-schedule');
  assert.equal(calendar.google_hook.includes('getBusy'), true);
  const slots = calendar.freeSlots({ now: NOW, count: 4 });
  assert.equal(dubai(slots[0].start_utc), '11:00');
  assert.equal(slots.some((slot) => dubai(slot.start_utc) === '10:00' && DateTime.fromISO(slot.start_utc, { setZone: true }).setZone(ZONE).toISODate() === '2026-10-28'), false);
  assert.equal(calendar.isFree('2026-10-29T09:00:00.000Z', 45), false);
  assert.equal(calendar.isFree('2026-10-29T12:00:00.000Z', 45), true);
});

test('Google Calendar plugs in through the same free-window call', async () => {
  const pending = createBrokerCalendar({ CALENDAR_MODE: 'google', BROKER_TZ: ZONE }, { now: () => NOW });
  assert.equal(pending.mode, 'google');
  assert.equal(pending.error, 'calendar_unavailable');
  assert.equal(pending.pending_google, undefined);
  assert.deepEqual(pending.freeSlots(), []);
  const calls = [];
  const live = createBrokerCalendar({ INTL_CALENDAR_MODE: 'google', BROKER_TZ: ZONE }, {
    now: () => NOW,
    getBusy(range) {
      calls.push(range);
      return [{ start: '2026-10-28T06:00:00.000Z', end: '2026-10-28T08:00:00.000Z' }];
    },
  });
  assert.equal(live.mode, 'google');
  assert.equal(live.source, 'google-calendar');
  const slots = await live.freeSlots({ now: NOW, count: 2 });
  assert.equal(dubai(slots[0].start_utc), '12:00');
  assert.ok(calls.length >= 1);
  assert.equal(typeof calls[0].start, 'string');
});

test('a free client time is confirmed and a busy one asks for another time', () => {
  const prop = property();
  const early = [
    { id: 'ten', start_utc: '2026-10-29T06:00:00.000Z' },
    { id: 'two', start_utc: '2026-10-29T10:00:00.000Z' },
  ];
  const free = buildOptions({
    analysis: { intent: 'viewing', language: 'en', flags: [], asks_discount: false },
    clean_name: 'Nina',
    proposed: { start_utc: '2026-10-29T12:00:00.000Z', free: true, id: 'client-thu' },
  }, prop, early);
  assert.equal(free[0].id, 'confirm');
  assert.match(free[0].text, /16:00/);
  assert.equal(free[0].text.includes('10:00'), false);
  assert.equal(free[0].text.includes('14:00'), false);
  assert.ok(free.some((row) => row.id === 'one' && row.slot_ids.length === 1));
  assert.ok(free.some((row) => row.id === 'two' && row.slot_ids.length === 2));
  assert.ok(free.some((row) => row.text.includes(prop.price_en)));
  for (const row of free) assert.ok(sentenceCount(row.text) <= 3, row.text);

  const busy = buildOptions({
    analysis: { intent: 'viewing', language: 'ru', flags: [], asks_discount: false },
    clean_name: 'Нина',
    proposed: { start_utc: '2026-10-29T12:00:00.000Z', free: false, id: 'client-thu' },
  }, prop, early);
  assert.equal(busy[0].id, 'other');
  assert.equal(busy[0].label_ru, 'Предложить другое время');
  assert.equal(busy[0].text.includes('16:00'), false);
  assert.ok(busy.some((row) => row.text.includes(prop.price_ru)));
});

test('picking a slot rewrites the prepared reply onto that time', () => {
  const before = 'Hi Nina, thanks for your interest in the 2BR in Dubai Marina. Thu 29 Oct, 10:00 (Dubai time) or Thu 29 Oct, 14:00 (Dubai time). (Not reserved yet.)';
  const after = rewriteReplyTime(before, 'Thu 29 Oct, 16:00 (Dubai time)', 'en');
  assert.match(after, /16:00 \(Dubai time\)/);
  assert.equal(after.includes('10:00'), false);
  assert.equal(after.includes('14:00'), false);
  assert.match(after, /Not reserved yet/);
  assert.match(after, /^Hi Nina/);
});

function openIntl(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-desk-'));
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
    BROKER_TZ: ZONE,
  });
  const intl = createIntl(config, {
    file: path.join(dir, 'intl.sqlite'),
    clock: () => NOW,
    busy: extra.busy,
    getBusy: extra.getBusy,
  });
  return { intl, async close() { intl.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function addMarina(intl) {
  return intl.addProperty({
    id: 'P1', title: '2BR, Dubai Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year',
    tz: ZONE, tz_label_en: 'Dubai time', tz_label_ru: 'время Дубая', ref_en: 'the 2BR in Dubai Marina', ref_ru: 'объекту «2BR, Dubai Marina»',
  }, '42');
}

test('inbox sorts HOT above WARM above COLD and archive leaves the active list', async () => {
  const api = openIntl();
  try {
    await addMarina(api.intl);
    const hot = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:hot', sender_name: 'Nina', text: 'Can I view it Thursday at 4pm?',
      property_id: 'P1', dedup_key: 'desk-hot', fixture: true,
    });
    const warm = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:warm', sender_name: 'Omar', text: 'What is the price?',
      property_id: 'P1', dedup_key: 'desk-warm', fixture: true,
    });
    const cold = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:cold', sender_name: 'Ada', text: 'hello there',
      property_id: 'P1', dedup_key: 'desk-cold', fixture: true,
    });
    const order = api.intl.leads().map((row) => row.id);
    assert.deepEqual(order, [hot.lead_id, warm.lead_id, cold.lead_id]);
    assert.equal(api.intl.lead(hot.lead_id).readiness, 'HOT');
    assert.equal(api.intl.lead(warm.lead_id).readiness, 'WARM');
    assert.equal(api.intl.lead(cold.lead_id).readiness, 'COLD');
    const archived = await api.intl.archive(warm.lead_id, '42');
    assert.equal(archived.status, 'archived');
    assert.equal(api.intl.leads().some((row) => row.id === warm.lead_id), false);
    assert.deepEqual(api.intl.leads({ archived: true }).map((row) => row.id), [warm.lead_id]);
    assert.equal(api.intl.leads().map((row) => row.id).includes(hot.lead_id), true);
  } finally {
    await api.close();
  }
});

test('the reply confirms the client slot when the demo calendar is free', async () => {
  const api = openIntl();
  try {
    await addMarina(api.intl);
    const saved = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:nina', sender_name: 'Nina', text: 'Thursday 4pm please, I want a viewing',
      property_id: 'P1', dedup_key: 'desk-time', fixture: true,
    });
    const lead = api.intl.lead(saved.lead_id);
    assert.equal(lead.proposed.free, true);
    assert.match(lead.proposed.label_en, /16:00/);
    assert.equal(lead.options[0].id, 'confirm');
    assert.match(lead.options[0].text, /16:00/);
    assert.equal(lead.options[0].text.includes('10:00'), false);
    assert.equal(lead.calendar_mode, 'mock');
    const one = lead.options.find((row) => row.id === 'one');
    const two = lead.options.find((row) => row.id === 'two');
    assert.equal(one.slot_ids.length, 1);
    assert.equal(two.slot_ids.length, 2);
    assert.equal(one.slot_ids[0], lead.proposed.id);
    const picked = lead.slots.find((slot) => dubai(slot.start_utc) === '17:00');
    const applied = await api.intl.applySlot(saved.lead_id, { slot_id: picked.id });
    assert.equal(applied.ok, true);
    assert.match(applied.text, /17:00/);
    assert.equal(applied.text.includes('10:00'), false);
    const draft = await api.intl.saveDraft(saved.lead_id, { text: applied.text, option_id: 'one', slot_ids: applied.slot_ids });
    const sent = await api.intl.send(saved.lead_id, { draft_version: draft.version, idempotency_key: 'desk-send' }, '42');
    assert.equal(sent.simulated, true);
    assert.equal(sent.ok, true);
  } finally {
    await api.close();
  }
});

test('a busy client slot puts Suggest another time first', async () => {
  const api = openIntl({
    busy: [{ start: '2026-10-29T12:00:00.000Z', end: '2026-10-29T12:45:00.000Z' }],
  });
  try {
    await addMarina(api.intl);
    const saved = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:busy', sender_name: 'Nina', text: 'четверг 16:00, хочу просмотр',
      property_id: 'P1', dedup_key: 'desk-busy', fixture: true,
    });
    const lead = api.intl.lead(saved.lead_id);
    assert.equal(lead.readiness, 'HOT');
    assert.equal(lead.proposed.free, false);
    assert.equal(lead.options[0].id, 'other');
    assert.equal(lead.options[0].label_en, 'Suggest another time');
    assert.equal(lead.options[0].label_ru, 'Предложить другое время');
    assert.equal(lead.options[0].text.includes('16:00'), false);
    const lunch = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:lunch', sender_name: 'Omar', text: 'tomorrow at 1pm for a viewing',
      property_id: 'P1', dedup_key: 'desk-lunch', fixture: true,
    });
    const lunchLead = api.intl.lead(lunch.lead_id);
    assert.equal(lunchLead.proposed.free, false);
    assert.equal(lunchLead.options[0].id, 'other');
  } finally {
    await api.close();
  }
});
