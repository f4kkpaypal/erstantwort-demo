'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');
const { loadConfig } = require('../../core/config');
const { parseProposal } = require('../../core/intl/when');
const { createBrokerCalendar } = require('../../core/intl/calendar');
const { brochurePdf, logicalText } = require('../../core/intl/brochure');
const { createIntl } = require('../../core/intl/service');
const { buildIntlServer } = require('../../engine/intlServer');

const NOW = new Date('2026-10-28T04:30:00.000Z');
const ZONE = 'Asia/Dubai';

function dubai(iso) {
  return DateTime.fromISO(iso, { setZone: true }).setZone(ZONE);
}

function openIntl(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-critic-'));
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
    CALENDAR_MODE: extra.mode || 'mock',
  });
  const intl = createIntl(config, {
    file: path.join(dir, 'intl.sqlite'),
    clock: () => NOW,
    getBusy: extra.getBusy,
    timeoutMs: extra.timeoutMs,
    calendar: extra.calendar,
  });
  return { intl, config, dir, close() { intl.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('dates, prices and word fragments are not read as a clock', () => {
  const dated = parseProposal('Thursday 15.11 at 16:00', ZONE, NOW);
  assert.equal(dubai(dated.start_utc).toFormat('yyyy-MM-dd HH:mm'), '2026-10-29 16:00');
  assert.equal(dated.ambiguous, false);
  assert.equal(parseProposal('tomorrow, price 3.50 per sqft?', ZONE, NOW), null);
  assert.equal(parseProposal('call +971 50 123 4567 tomorrow', ZONE, NOW), null);
  assert.equal(parseProposal('Saturday 12am', ZONE, NOW), null);
  const sun = parseProposal('Sun-facing flat, can I see 5pm?', ZONE, NOW);
  assert.equal(dubai(sun.start_utc).weekday, 3);
  assert.equal(dubai(sun.start_utc).toFormat('HH:mm'), '17:00');
  const half = parseProposal('Thursday 4:30', ZONE, NOW);
  assert.equal(dubai(half.start_utc).toFormat('yyyy-MM-dd HH:mm'), '2026-10-29 16:30');
  assert.equal(half.ambiguous, true);
});

test('next weekday, bare hours, noon and the client zone are kept', () => {
  const next = parseProposal('next Thursday', ZONE, NOW);
  assert.equal(dubai(next.start_utc).toFormat('yyyy-MM-dd'), '2026-11-05');
  assert.equal(next.ambiguous, true);
  const at = parseProposal('at 4', ZONE, NOW);
  assert.equal(dubai(at.start_utc).toFormat('yyyy-MM-dd HH:mm'), '2026-10-28 16:00');
  assert.equal(at.ambiguous, true);
  const afternoon = parseProposal('завтра в 4 дня', ZONE, NOW);
  assert.equal(dubai(afternoon.start_utc).toFormat('yyyy-MM-dd HH:mm'), '2026-10-29 16:00');
  assert.equal(afternoon.ambiguous, false);
  assert.equal(dubai(parseProposal('noon', ZONE, NOW).start_utc).toFormat('HH:mm'), '12:00');
  assert.equal(dubai(parseProposal('в 16 часов', ZONE, NOW).start_utc).toFormat('HH:mm'), '16:00');
  assert.equal(dubai(parseProposal('16h', ZONE, NOW).start_utc).toFormat('HH:mm'), '16:00');
  assert.equal(dubai(parseProposal('завтра 16.00', ZONE, NOW).start_utc).toFormat('yyyy-MM-dd HH:mm'), '2026-10-29 16:00');
  const weekend = parseProposal('в эти выходные', ZONE, NOW);
  assert.equal(dubai(weekend.start_utc).toFormat('yyyy-MM-dd HH:mm'), '2026-10-31 12:00');
  assert.equal(weekend.weekend, true);
  const london = parseProposal('Thursday 4pm London time', ZONE, NOW);
  assert.equal(london.zone, 'Europe/London');
  assert.equal(london.zone_explicit, true);
  assert.equal(DateTime.fromISO(london.start_utc, { setZone: true }).setZone('Europe/London').toFormat('yyyy-MM-dd HH:mm'), '2026-10-29 16:00');
  assert.notEqual(london.start_utc, parseProposal('Thursday 4pm', ZONE, NOW).start_utc);
  const moscow = parseProposal('Thursday 4pm по Москве', ZONE, NOW);
  assert.equal(moscow.zone, 'Europe/Moscow');
  assert.equal(DateTime.fromISO(moscow.start_utc, { setZone: true }).setZone('Europe/Moscow').toFormat('HH:mm'), '16:00');
  const plain = parseProposal('Thursday 4pm', ZONE, NOW);
  assert.equal(plain.zone_unspecified, true);
});

test('a missing or broken Google driver offers no slots and does not fall back to mock', async () => {
  const missing = createBrokerCalendar({ CALENDAR_MODE: 'google', BROKER_TZ: ZONE }, { now: () => NOW });
  assert.equal(missing.mode, 'google');
  assert.equal(missing.error, 'calendar_unavailable');
  assert.notEqual(missing.mode, 'mock');
  const hung = createBrokerCalendar({ INTL_CALENDAR_MODE: 'google' }, {
    now: () => NOW,
    timeoutMs: 30,
    getBusy() { return new Promise(() => {}); },
  });
  assert.deepEqual(await hung.freeSlots({ now: NOW, count: 4 }), []);
  assert.equal(hung.error, 'calendar_unavailable');
  const thrown = createBrokerCalendar({ CALENDAR_MODE: 'google' }, {
    now: () => NOW,
    getBusy() { throw new Error('rows.map is not a function'); },
  });
  assert.deepEqual(await thrown.freeSlots({ now: NOW, count: 4 }), []);
  assert.equal(thrown.error, 'calendar_unavailable');
  const odd = createBrokerCalendar({ CALENDAR_MODE: 'google' }, {
    now: () => NOW,
    getBusy() { return Promise.resolve({ rows: [] }); },
  });
  assert.deepEqual(await odd.freeSlots({ now: NOW, count: 2 }), []);
  const live = createBrokerCalendar({ CALENDAR_MODE: 'google' }, {
    now: () => NOW,
    async getBusy() { return []; },
  });
  const slots = await live.freeSlots({ now: NOW, count: 1 });
  assert.equal(slots.length, 1);
  assert.equal(live.error, null);

  const broken = openIntl({
    calendar: createBrokerCalendar({ CALENDAR_MODE: 'google', BROKER_TZ: ZONE }, {
      now: () => NOW,
      getBusy() { return Promise.reject(new Error('down')); },
    }),
  });
  try {
    const saved = await broken.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:cal', sender_name: 'Nina',
      text: 'Can I view it Thursday at 4pm?', dedup_key: 'cal-1', fixture: true,
    });
    const lead = await broken.intl.lead(saved.lead_id);
    assert.equal(lead.calendar_error, 'calendar_unavailable');
    assert.equal(lead.slots.length, 0);
    assert.equal(lead.proposed, null);
    assert.equal(lead.options.some((row) => (row.slot_ids || []).length > 0), false);
  } finally {
    broken.close();
  }
});

test('the brochure keeps Cyrillic and Arabic and names the broker', async () => {
  const pdf = await brochurePdf({
    title: 'Квартира в Марине',
    address: 'شارع الشيخ زايد',
    district: 'Dubai Marina',
    price_en: 'AED 120,000 / year',
  }, { brokerName: 'Агентство Марина', brokerPhone: '+971500000000' });
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: pdf });
  const parsed = await parser.getText();
  await parser.destroy();
  const text = logicalText(parsed.text || '');
  assert.match(text, /Квартира в Марине/);
  assert.match(text, /شارع الشيخ زايد/);
  assert.match(text, /Агентство Марина/);
  assert.equal(text.includes('Erstantwort'), false);
});

test('a long floor plan is stored by id and the client link opens without broker auth', async () => {
  const api = openIntl();
  const server = buildIntlServer(api.config, api.intl);
  try {
    const bytes = Buffer.alloc(420, 9);
    bytes[0] = 0x25;
    const plan = `data:application/pdf;base64,${bytes.toString('base64')}`;
    assert.ok(plan.length > 500);
    await api.intl.addProperty({
      id: 'P9',
      title: 'Marina Gate 2BR',
      kind: 'rent',
      price: 120000,
      currency: 'AED',
      price_period: 'year',
      tz: ZONE,
      plan_url: plan,
      make_brochure: true,
      listing_url: 'https://example.test/marina-gate',
    }, '42');
    const row = api.intl.store.one('SELECT plan_url, brochure_url FROM i_property WHERE id = ?', ['P9']);
    assert.match(row.plan_url, /^file:F-/);
    assert.equal(row.plan_url.includes('data:'), false);
    assert.ok(row.plan_url.length < 80);
    const saved = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:file', sender_name: 'Nina',
      text: 'interested in Marina Gate 2BR', dedup_key: 'file-1', fixture: true,
    });
    const lead = api.intl.lead(saved.lead_id);
    const materials = lead.options.find((item) => item.id === 'materials');
    assert.ok(materials);
    const planItem = materials.attachments.find((item) => item.kind === 'plan');
    const brochureItem = materials.attachments.find((item) => item.kind === 'brochure');
    assert.match(planItem.url, /^\/v1\/intl\/public\/files\//);
    assert.match(brochureItem.url, /^\/v1\/intl\/public\/files\//);
    assert.equal(planItem.url.includes('data:'), false);
    const draft = await api.intl.saveDraft(saved.lead_id, {
      text: materials.text,
      option_id: 'materials',
      slot_ids: [],
      attachments: materials.attachments,
    });
    const stored = JSON.parse(api.intl.store.one('SELECT attachments FROM i_draft WHERE lead_id = ?', [saved.lead_id]).attachments);
    assert.equal(stored.some((item) => String(item.url).startsWith('data:')), false);
    assert.ok(stored.every((item) => String(item.url).length < 500));
    const sent = await api.intl.send(saved.lead_id, { draft_version: draft.version, idempotency_key: 'file-send' }, '42');
    assert.equal(sent.simulated, true);
    const sentPlan = sent.attachments.find((item) => item.kind === 'plan');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}${sentPlan.url}`);
    const got = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.equal(got.equals(bytes), true);
    const denied = await fetch(`http://127.0.0.1:${port}${sentPlan.url.split('?')[0]}`);
    assert.equal(denied.status, 403);
    const brochure = await fetch(`http://127.0.0.1:${port}${brochureItem.url}`);
    assert.equal(brochure.status, 200);
    assert.match(brochure.headers.get('content-type'), /pdf/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    api.close();
  }
});

test('the lead screen previews a file instead of only toasting its size', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'style.css'), 'utf8');
  assert.match(app, /URL\.createObjectURL/);
  assert.match(app, /id="filePreview"/);
  assert.match(css, /\.fileview/);
  assert.match(app, /calendarUnavailable/);
  assert.doesNotMatch(app, /window\.open/);
});
