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
const { brochurePdf } = require('../../core/intl/brochure');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function openIntl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-polish-'));
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
  const intl = createIntl(config, {
    file: path.join(dir, 'intl.sqlite'),
    clock: () => new Date('2026-11-01T04:30:00.000Z'),
  });
  return {
    intl,
    config,
    close() {
      intl.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function property(intl, extra = {}) {
  return intl.addProperty({
    id: 'P1',
    title: 'Marina Gate',
    address: 'Marina Gate',
    district: 'Dubai Marina',
    kind: 'rent',
    price: 120000,
    currency: 'AED',
    price_period: 'year',
    tz: 'Asia/Dubai',
    ...extra,
  }, '42');
}

function ask(intl, sender) {
  return intl.ingest({
    channel: 'wa_sim',
    sender_id: sender,
    sender_name: sender,
    text: 'What is the price?',
    property_id: 'P1',
    dedup_key: `polish-${sender}`,
    fixture: true,
  });
}

async function reply(intl, leadId) {
  const lead = intl.lead(leadId);
  const option = lead.options[0];
  const draft = await intl.saveDraft(leadId, {
    text: option.text,
    option_id: option.id,
    slot_ids: option.slot_ids || [],
    attachments: [],
  });
  return intl.send(leadId, { draft_version: draft.version, idempotency_key: `polish-send-${leadId}` }, '42');
}

test('a sent lead leaves the active list and a broker confirm moves it to confirmed', async () => {
  const api = openIntl();
  try {
    await property(api.intl);
    const first = await ask(api.intl, 'sim:nina');
    const second = await ask(api.intl, 'sim:omar');
    assert.equal(api.intl.lead(first.lead_id).bucket, 'active');
    const early = await api.intl.confirm(first.lead_id, '42');
    assert.equal(early.ok, false);
    assert.equal(early.error_code, 'not_replied');
    const sent = await reply(api.intl, first.lead_id);
    assert.equal(sent.simulated, true);
    assert.equal(sent.lead_status, 'sent');
    assert.equal(api.intl.lead(first.lead_id).bucket, 'awaiting');
    assert.equal(api.intl.lead(second.lead_id).bucket, 'active');
    const confirmed = await api.intl.confirm(first.lead_id, '42');
    assert.equal(confirmed.client_confirmed, true);
    assert.equal(confirmed.simulated, true);
    assert.equal(confirmed.sent, false);
    const again = await api.intl.confirm(first.lead_id, '42');
    assert.equal(again.ok, true);
    assert.equal(api.intl.lead(first.lead_id).bucket, 'confirmed');
    assert.equal(api.intl.leads().some((row) => row.id === first.lead_id && row.bucket === 'active'), false);
    const missing = await api.intl.confirm('missing', '42');
    assert.equal(missing.status, 404);
  } finally {
    api.close();
  }
});

test('a confirmed viewing confirms an answered lead, and an earlier viewing confirms the lead once the reply is sent', async () => {
  const api = openIntl();
  try {
    await property(api.intl);
    const answered = await ask(api.intl, 'sim:answered');
    await reply(api.intl, answered.lead_id);
    const slot = await api.intl.addSlot('P1', { start_utc: '2026-12-02T08:00:00.000Z' }, '42');
    const booked = await api.intl.book(answered.lead_id, slot.id, '42');
    const viewing = await api.intl.setViewing(booked.id, 'confirmed', '42');
    assert.equal(viewing.status, 'confirmed');
    assert.equal(api.intl.lead(answered.lead_id).bucket, 'confirmed');

    const early = await ask(api.intl, 'sim:early');
    const later = await api.intl.addSlot('P1', { start_utc: '2026-12-03T08:00:00.000Z' }, '42');
    const held = await api.intl.book(early.lead_id, later.id, '42');
    await api.intl.setViewing(held.id, 'confirmed', '42');
    assert.equal(api.intl.lead(early.lead_id).client_confirmed, true);
    assert.equal(api.intl.lead(early.lead_id).bucket, 'active');
    await reply(api.intl, early.lead_id);
    assert.equal(api.intl.lead(early.lead_id).bucket, 'confirmed');
  } finally {
    api.close();
  }
});

test('property photos stay in the current file store and the PDF template draws them', async () => {
  const api = openIntl();
  try {
    const bad = await api.intl.addProperty({
      id: 'P9', title: 'Nope', kind: 'rent', price: 10, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
      photos: ['https://example.test/x.png'],
    }, '42');
    assert.equal(bad.ok, false);
    assert.equal(bad.error_code, 'invalid_property');
    assert.equal(api.intl.store.one('SELECT id FROM i_property WHERE id = ?', ['P9']), null);
    const saved = await property(api.intl, { photos: [PNG, PNG] });
    assert.equal(saved.ok, true);
    let photos = api.intl.photos('P1');
    assert.equal(photos.length, 2);
    assert.match(photos[0].data_url, /^data:image\/png/);
    const renamed = await property(api.intl, { title: 'Marina Gate 2' });
    assert.equal(renamed.updated, true);
    photos = api.intl.photos('P1');
    assert.equal(photos.length, 2);
    const trimmed = await property(api.intl, { title: 'Marina Gate 2', photos: [`file:${photos[0].id}`] });
    assert.equal(trimmed.ok, true);
    assert.deepEqual(api.intl.photos('P1').map((photo) => photo.id), [photos[0].id]);
    assert.equal(api.intl.store.one('SELECT id FROM i_file WHERE id = ?', [photos[1].id]), null);
    const pdf = await api.intl.brochure('P1');
    assert.equal(pdf.body_bytes.slice(0, 5).toString(), '%PDF-');
    const row = api.intl.store.one('SELECT * FROM i_property WHERE id = ?', ['P1']);
    const bytes = Buffer.from(PNG.split(',')[1], 'base64');
    const withPhoto = await brochurePdf(row, { brokerName: 'Desk', photos: [{ mime: 'image/png', bytes }] });
    const without = await brochurePdf(row, { brokerName: 'Desk' });
    assert.ok(withPhoto.length > without.length);
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: pdf.body_bytes });
    const parsed = await parser.getText();
    await parser.destroy();
    assert.match(parsed.text || '', /Marina Gate 2/);
    const root = path.join(__dirname, '..', '..', 'core', 'intl');
    assert.match(fs.readFileSync(path.join(root, 'pdfTemplate.js'), 'utf8'), /function renderTemplate/);
    assert.match(fs.readFileSync(path.join(root, 'brochure.js'), 'utf8'), /pdfTemplate/);
  } finally {
    api.close();
  }
});

test('the title, the waiting header and the tab badge count the same main-list leads', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'app.js'), 'utf8');
  const helpers = app.slice(app.indexOf('function isMainListLead'), app.indexOf('async function refreshBadge'));
  const countMainList = new Function(`${helpers}\nreturn countMainList;`)();
  const leads = [
    { id: 'wait', bucket: 'active', status: 'pending_approval', grade: 'HOT', property_id: 'P1' },
    { id: 'review', bucket: 'active', status: 'review', grade: 'WARM', property_id: 'P1' },
    { id: 'stopped', bucket: 'active', status: 'stopped', grade: 'COLD', property_id: 'P2' },
    { id: 'replied', bucket: 'awaiting', status: 'sent', grade: 'HOT', property_id: 'P1' },
    { id: 'confirmed', bucket: 'confirmed', status: 'sent', grade: 'HOT', property_id: 'P1' },
  ];
  assert.equal(countMainList(leads, 'ALL', ''), 3);
  assert.equal(countMainList(leads, 'HOT', ''), 1);
  assert.equal(countMainList(leads, 'ALL', 'P1'), 2);
  const inbox = app.slice(app.indexOf('async function showInbox'), app.indexOf('function hydrateLead'));
  assert.match(inbox, /hd-count">\$\{mainCount\}/);
  assert.match(inbox, /t\('waiting'\)\)\} · \$\{mainCount\}/);
  assert.match(inbox, /, mainCount\)/);
  assert.doesNotMatch(inbox, /shownWait\.length\}<\/span>/);
  const badge = app.slice(app.indexOf('async function refreshBadge'), app.indexOf('function leadLink'));
  assert.match(badge, /countMainList\(state\.leadRows, state\.filter, state\.propertyId\)/);
});

test('confirm is a route and the phone screens keep the new controls', async () => {
  const root = path.join(__dirname, '..', '..');
  const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'ui-intl', 'style.css'), 'utf8');
  assert.match(app, /hd-count/);
  assert.match(app, /id="openAwaiting"/);
  assert.match(app, /id="openConfirmed"/);
  assert.doesNotMatch(app, /id="openDigest"/);
  assert.doesNotMatch(app, /id="pplan"/);
  assert.doesNotMatch(app, /fill\('reviewN'/);
  const prop = app.slice(app.indexOf("querySelectorAll('[data-prop]')"), app.indexOf("querySelectorAll('[data-edit]')"));
  assert.doesNotMatch(prop, /#\/inbox/);
  assert.match(prop, /showPropertyLeads/);
  assert.match(app, /state\.openProperty === id \? '' : id/);
  const back = app.slice(app.indexOf("getElementById('backProp')"), app.indexOf("getElementById('backProp')") + 420);
  assert.match(back, /rememberPropertyDraft/);
  assert.doesNotMatch(back, /DELETE|\/erase|addProperty\(/);
  assert.match(app, /function bindCalendarSwipe/);
  assert.match(app, /touchstart/);
  assert.match(app, /touchend/);
  assert.match(css, /\.cal-swipe\s*\{[^}]*touch-action:\s*pan-y/s);
  const api = openIntl();
  const server = buildIntlServer(api.config, api.intl);
  try {
    await property(api.intl);
    const saved = await ask(api.intl, 'sim:http');
    await reply(api.intl, saved.lead_id);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const headers = {
      Authorization: `tma ${signInitData({
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id: 42 }),
      }, api.config.TELEGRAM_BOT_TOKEN)}`,
      'Content-Type': 'application/json',
    };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/intl/leads/${saved.lead_id}/confirm`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.client_confirmed, true);
    assert.equal(json.simulated, true);
    const listed = await fetch(`http://127.0.0.1:${server.address().port}/v1/intl/leads`, { headers });
    const body = await listed.json();
    assert.equal(body.leads.find((row) => row.id === saved.lead_id).bucket, 'confirmed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    api.close();
  }
});
