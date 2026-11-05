'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { brochurePdf } = require('../../core/intl/brochure');
const { createIntl } = require('../../core/intl/service');
const { buildIntlServer } = require('../../engine/intlServer');

const NOW = new Date('2026-10-28T04:30:00.000Z');
const ASKING = 'Can I view it Thursday at 4pm?';
const RICHER = 'Can I view it Thursday at 4pm? Budget AED 200000 per year, cash.';

function openIntl(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-demo-'));
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
  let clock = extra.clock || (() => NOW);
  const intl = createIntl(config, {
    file: path.join(dir, 'intl.sqlite'),
    clock: () => clock(),
    calendar: extra.calendar,
  });
  return {
    intl,
    config,
    setClock(fn) { clock = fn; intl.setClock(fn); },
    close() {
      intl.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function flat(intl, id, title) {
  return intl.addProperty({
    id, title, kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
    listing_url: `https://example.test/${id}`, make_brochure: true, plan_url: `https://example.test/${id}.png`,
  }, '42');
}

function ask(intl, sender, received, text = ASKING, propertyId = 'P1') {
  return intl.ingest({
    channel: 'wa_sim', sender_id: sender, sender_name: sender, property_id: propertyId, fixture: true,
    text, dedup_key: sender, received_at: received,
  });
}

function outs(intl, id) {
  return intl.store.all(`SELECT text FROM i_message WHERE lead_id = ? AND direction = 'out' ORDER BY created_at`, [id])
    .map((row) => row.text).join('\n');
}

test('D1 one HOT is sent at once and two HOT wait 45 seconds on one due time', async () => {
  const alone = openIntl();
  try {
    await flat(alone.intl, 'P1', 'Marina Gate 2BR');
    await alone.intl.settings({ auto_send_hot: true }, '42');
    const one = await ask(alone.intl, 'sim:one', '2026-10-28T05:00:00.000Z');
    assert.equal(alone.intl.lead(one.lead_id).status, 'sent');
    assert.match(outs(alone.intl, one.lead_id), /16:00/);
    assert.equal(alone.intl.store.one(`SELECT competition_due_at FROM i_time_hold`).competition_due_at, null);
  } finally {
    alone.close();
  }

  const api = openIntl();
  try {
    await flat(api.intl, 'P1', 'Marina Gate 2BR');
    const low = await ask(api.intl, 'sim:low', '2026-10-28T05:00:00.000Z');
    const high = await ask(api.intl, 'sim:high', '2026-10-28T06:00:00.000Z', RICHER);
    assert.ok(api.intl.lead(high.lead_id).score > api.intl.lead(low.lead_id).score);
    assert.equal(api.intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE direction = 'out'`).n, 0);
    await api.intl.settings({ auto_send_hot: true }, '42');
    const due = api.intl.store.one(`SELECT competition_due_at, lead_id FROM i_time_hold`);
    assert.equal(Date.parse(due.competition_due_at) - NOW.getTime(), 45000);
    assert.equal(due.lead_id, high.lead_id);
    assert.equal(api.intl.lead(high.lead_id).status, 'pending_approval');
    const third = await ask(api.intl, 'sim:third', '2026-10-28T06:30:00.000Z');
    assert.equal(api.intl.store.one(`SELECT competition_due_at FROM i_time_hold`).competition_due_at, due.competition_due_at);
    assert.equal(api.intl.store.all(`SELECT competition_due_at FROM i_time_hold`).length, 1);
    api.setClock(() => new Date(NOW.getTime() + 44000));
    await api.intl.settleHot(third.lead_id);
    assert.equal(api.intl.lead(high.lead_id).status, 'pending_approval');
    api.setClock(() => new Date(NOW.getTime() + 45000));
    await api.intl.compete();
    assert.equal(api.intl.lead(high.lead_id).status, 'sent');
    assert.match(outs(api.intl, high.lead_id), /16:00/);
    assert.equal(outs(api.intl, low.lead_id).includes('16:00'), false);
    assert.equal(outs(api.intl, third.lead_id).includes('16:00'), false);
    assert.equal(api.intl.store.one(`SELECT lead_id FROM i_time_hold WHERE start_utc = ?`, [api.intl.lead(high.lead_id).proposed_utc]).lead_id, high.lead_id);
    const sends = api.intl.store.all(`SELECT status FROM i_send`);
    assert.ok(sends.length >= 2);
    assert.ok(sends.every((row) => row.status === 'simulated'));
  } finally {
    api.close();
  }
});

test('D1 a sent holder keeps the slot and a loser without another time is asked, not booked', async () => {
  const sent = openIntl();
  try {
    await flat(sent.intl, 'P1', 'Marina Gate 2BR');
    await sent.intl.settings({ auto_send_hot: true }, '42');
    const first = await ask(sent.intl, 'sim:sent', '2026-10-28T05:00:00.000Z');
    const owned = sent.intl.lead(first.lead_id).proposed_utc;
    const before = outs(sent.intl, first.lead_id);
    const later = await ask(sent.intl, 'sim:later', '2026-10-28T07:00:00.000Z', RICHER);
    assert.ok(sent.intl.lead(later.lead_id).score > sent.intl.lead(first.lead_id).score);
    assert.equal(sent.intl.store.one(`SELECT lead_id FROM i_time_hold WHERE start_utc = ?`, [owned]).lead_id, first.lead_id);
    assert.equal(outs(sent.intl, first.lead_id), before);
    assert.equal(outs(sent.intl, later.lead_id).includes('16:00'), false);
  } finally {
    sent.close();
  }

  const empty = {
    mode: 'mock',
    source: 'mock-schedule',
    zone: 'Asia/Dubai',
    async: false,
    isFree() { return true; },
    freeSlots() { return []; },
  };
  const api = openIntl({ calendar: empty });
  try {
    await flat(api.intl, 'P1', 'Marina Gate 2BR');
    const low = await ask(api.intl, 'sim:a', '2026-10-28T05:00:00.000Z');
    const high = await ask(api.intl, 'sim:b', '2026-10-28T06:00:00.000Z', RICHER);
    await api.intl.settings({ auto_send_hot: true }, '42');
    api.setClock(() => new Date(NOW.getTime() + 45000));
    await api.intl.settleHot(high.lead_id);
    assert.match(outs(api.intl, high.lead_id), /16:00/);
    const loser = outs(api.intl, low.lead_id);
    assert.match(loser, /Which day and time suit you/);
    assert.equal(loser.includes('16:00'), false);
    assert.equal(api.intl.store.one(`SELECT COUNT(*) AS n FROM i_viewing`).n, 0);
    assert.equal(api.intl.store.one(`SELECT option_id FROM i_draft WHERE lead_id = ?`, [low.lead_id]).option_id, 'ask');
  } finally {
    api.close();
  }
});

test('D2 turning auto send on settles, and turning it off cancels a competition that has not fired', async () => {
  const api = openIntl();
  try {
    await flat(api.intl, 'P1', 'Marina Gate 2BR');
    await ask(api.intl, 'sim:early', '2026-10-28T05:00:00.000Z');
    await ask(api.intl, 'sim:late', '2026-10-28T06:00:00.000Z', RICHER);
    await api.intl.settings({ auto_send_hot: true }, '42');
    assert.ok(api.intl.store.one(`SELECT competition_due_at FROM i_time_hold`).competition_due_at);
    assert.equal(api.intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE direction = 'out'`).n, 0);
    await api.intl.settings({ auto_send_hot: false }, '42');
    api.setClock(() => new Date(NOW.getTime() + 45000));
    await api.intl.sweep();
    assert.equal(api.intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE direction = 'out'`).n, 0);
    assert.equal(api.intl.store.one(`SELECT COUNT(*) AS n FROM i_time_hold WHERE competition_due_at IS NOT NULL`).n, 0);
  } finally {
    api.close();
  }
});

test('D3 materials stay when the property is chosen explicitly and a later ok does not drop them', async () => {
  const api = openIntl();
  try {
    await flat(api.intl, 'P1', 'Marina Gate 2BR');
    await flat(api.intl, 'P2', 'Other Tower');
    const named = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:named', sender_name: 'Nina', fixture: true,
      text: 'interested in Marina Gate 2BR', dedup_key: 'd3-named',
    });
    assert.ok(api.intl.lead(named.lead_id).options.some((row) => row.id === 'materials'));
    const picked = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:picked', sender_name: 'Omar', property_id: 'P2', fixture: true,
      text: 'Business Bay', dedup_key: 'd3-picked',
    });
    const pickedLead = api.intl.lead(picked.lead_id);
    assert.equal(pickedLead.property_id, 'P2');
    assert.ok(pickedLead.options.some((row) => row.id === 'materials'));
    const again = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:picked', sender_name: 'Omar', property_id: 'P2', fixture: true,
      text: 'ok', dedup_key: 'd3-ok',
    });
    assert.equal(again.lead_id, picked.lead_id);
    const after = api.intl.lead(picked.lead_id);
    assert.equal(after.property_id, 'P2');
    assert.ok(after.options.some((row) => row.id === 'materials'));
    const loose = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:loose', sender_name: 'Ada', fixture: true,
      text: 'Any 2 bedroom in Marina?', dedup_key: 'd3-loose',
    });
    assert.equal(api.intl.lead(loose.lead_id).property_id, 'general');
    assert.equal(api.intl.lead(loose.lead_id).options.some((row) => row.id === 'materials'), false);
  } finally {
    api.close();
  }
});

test('D4 the free image copies the font assets and a brochure still builds', async () => {
  const root = path.join(__dirname, '..', '..');
  const docker = fs.readFileSync(path.join(root, 'Dockerfile.free'), 'utf8');
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  assert.match(docker, /^COPY assets \.\/assets$/m);
  assert.equal(ignore.split('\n').some((line) => line.trim() === 'assets' || line.trim() === 'assets/'), false);
  const pdf = await brochurePdf({ title: 'Marina Gate 2BR', price_en: 'AED 1' }, { brokerName: 'Desk' });
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
});

test('D5 seeded viewing slots stay after the demo clock', async () => {
  const api = openIntl();
  try {
    const future = new Date('2030-06-01T18:00:00.000Z');
    api.setClock(() => future);
    const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
    await api.intl.seed(pack, 'all');
    const slots = api.intl.store.all(`SELECT start_utc FROM i_slot`);
    assert.ok(slots.length >= 4);
    for (const slot of slots) assert.ok(Date.parse(slot.start_utc) > future.getTime(), slot.start_utc);
  } finally {
    api.close();
  }
});

test('D6 and D7 the demo plaque is translated and health plus seed stay available', async () => {
  const root = path.join(__dirname, '..', '..');
  const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'en.json'), 'utf8'));
  const ru = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'ru.json'), 'utf8'));
  assert.match(app, /id="demoBanner"/);
  assert.match(en.demoBar, /Demo/);
  assert.match(ru.demoBar, /Демо/);
  assert.match(app, /id="seed-all"/);
  const api = openIntl();
  const server = buildIntlServer(api.config, api.intl);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.text()).trim(), 'ok');
    const pack = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'intl', 'testset.json'), 'utf8'));
    const counts = await api.intl.seed(pack, 'all');
    assert.equal(counts.HOT + counts.WARM + counts.COLD, 25);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    api.close();
  }
});
