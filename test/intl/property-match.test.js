'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { matchProperty } = require('../../core/intl/matchProperty');
const { brochurePdf } = require('../../core/intl/brochure');
const { buildOptions, sentenceCount, BROKER_EN } = require('../../core/intl/options');
const { createIntl } = require('../../core/intl/service');
const { signInitData } = require('../../core/uiAuth');
const { buildIntlServer } = require('../../engine/intlServer');

const marina = {
  id: 'P1',
  title: '2BR, Dubai Marina',
  address: 'Marina Gate, Dubai Marina',
  district: 'Dubai Marina',
  bedrooms: 2,
  price: 120000,
  currency: 'AED',
  price_period: 'year',
  price_en: 'AED 120,000 / year',
  price_ru: '120 000 AED в год',
  listing_url: 'https://example.test/marina-2br',
  brochure_url: '/v1/intl/properties/P1/brochure.pdf',
  plan_url: 'https://example.test/marina-plan.png',
  ref_en: 'the 2BR in Dubai Marina',
  ref_ru: 'объекту «2BR, Dubai Marina»',
  tz: 'Asia/Dubai',
  tz_label_en: 'Dubai time',
};

const besiktas = {
  id: 'P2',
  title: '2+1, Beşiktaş',
  address: 'Beşiktaş',
  district: 'Besiktas',
  bedrooms: 2,
  price: 310000,
  currency: 'USD',
  price_period: 'total',
  price_en: 'USD 310,000',
  price_ru: '310 000 USD',
  ref_en: 'the 2+1 apartment in Beşiktaş',
  ref_ru: 'объекту «2+1, Beşiktaş»',
  tz: 'Europe/Istanbul',
};

test('a property is attached only when the client writes its exact title', () => {
  const catalog = [marina, besiktas];
  assert.equal(matchProperty('interested in 2BR, Dubai Marina', catalog).id, 'P1');
  assert.equal(matchProperty('Any 2 bedroom in Marina?', catalog), null);
  assert.equal(matchProperty('My budget is 120000 a year for a flat', catalog), null);
  assert.equal(matchProperty('I like P2, what is the price?', catalog), null);
  assert.equal(matchProperty('Send me https://example.test/marina-2br', catalog), null);
  const bay = { id: 'B1', title: 'Bay', price: 1, currency: 'USD' };
  const business = { id: 'B2', title: 'Business Bay', price: 2, currency: 'USD' };
  assert.equal(matchProperty('Business Bay', [bay]), null);
  assert.equal(matchProperty('Business Bay', [business]).id, 'B2');
  const towerA = { id: 'T1', title: 'Tower A', price: 1, currency: 'USD' };
  const towerB = { id: 'T2', title: 'Tower A', price: 2, currency: 'USD' };
  assert.equal(matchProperty('Tower A please', [towerA, towerB]), null);
});

test('reply options follow the question and keep property files in third or fourth place', () => {
  const slots = [
    { id: 'a', start_utc: '2026-11-05T06:00:00.000Z' },
    { id: 'b', start_utc: '2026-11-05T07:00:00.000Z' },
  ];
  const viewing = buildOptions({
    analysis: { intent: 'viewing', language: 'en', flags: [], asks_discount: false },
    clean_name: 'Nina',
    title_match: true,
  }, marina, slots);
  assert.ok(['two', 'one', 'confirm'].includes(viewing[0].id));
  const filesAt = viewing.findIndex((row) => row.id === 'materials');
  assert.ok(filesAt === 2 || filesAt === 3, String(filesAt));
  const files = viewing[filesAt];
  assert.equal(files.attachments.map((item) => item.kind).join(','), 'brochure,plan,link');
  assert.match(files.text, /marina-2br/);
  assert.match(files.text, /Marina Gate/);
  assert.ok(viewing.some((row) => row.text.includes(marina.price_en)));
  for (const row of viewing) assert.ok(sentenceCount(row.text) <= 3, row.text);

  const price = buildOptions({
    analysis: { intent: 'price', language: 'ru', flags: [], asks_discount: false },
    clean_name: 'Нина',
    title_match: true,
  }, marina, slots);
  assert.equal(price[0].id, 'price');
  assert.match(price[0].text, /120 000 AED/);
  const priceFiles = price.findIndex((row) => row.id === 'materials');
  assert.ok(priceFiles === 2 || priceFiles === 3);

  const area = buildOptions({
    analysis: { intent: 'area', language: 'en', flags: [], asks_discount: false },
    clean_name: 'Nina',
    title_match: true,
  }, marina, slots);
  assert.equal(area[0].id, 'details');
  assert.match(area[0].text, /Dubai Marina/);
  for (const row of area) {
    assert.ok(row.text.includes(BROKER_EN), row.id);
    assert.ok(sentenceCount(row.text) <= 3, row.text);
  }
});

test('the generated PDF is a real file built from the property fields', async () => {
  const pdf = await brochurePdf(marina, { brokerName: 'Marina Desk' });
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: pdf });
  const parsed = await parser.getText();
  await parser.destroy();
  const text = parsed.text || '';
  assert.match(text, /Marina Desk/);
  assert.match(text, /Dubai Marina/);
  assert.match(text, /AED 120,000/);
  assert.match(text, /marina-2br/);
  assert.equal(text.includes('Erstantwort'), false);
});

function openIntl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-prop-'));
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
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-11-04T04:30:00.000Z') });
  return {
    intl,
    config,
    dir,
    close() {
      intl.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a lead without an object id is filed under the matched property and can attach its files', async () => {
  const api = openIntl();
  try {
    await api.intl.addProperty({
      id: 'P1', title: '2BR, Dubai Marina', address: 'Marina Gate', district: 'Dubai Marina', bedrooms: 2,
      kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
      listing_url: 'https://example.test/marina-2br', make_brochure: true, plan_url: 'https://example.test/plan.png',
    }, '42');
    await api.intl.addProperty({
      id: 'P2', title: 'Studio, JBR', district: 'JBR', bedrooms: 0, kind: 'rent', price: 90000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
    }, '42');
    const saved = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:match', sender_name: 'Nina',
      text: 'What is the price of 2BR, Dubai Marina?',
      dedup_key: 'match-1', fixture: true,
    });
    const lead = api.intl.lead(saved.lead_id);
    assert.equal(lead.property_id, 'P1');
    assert.equal(lead.match.id, 'P1');
    assert.ok(lead.match.reasons.includes('district') || lead.match.reasons.includes('title'));
    assert.equal(lead.options[0].id, 'price');
    const materials = lead.options.find((row) => row.id === 'materials');
    assert.ok(materials);
    assert.ok(materials.attachments.some((item) => item.kind === 'brochure'));
    const draft = await api.intl.saveDraft(saved.lead_id, {
      text: materials.text, option_id: 'materials', slot_ids: [], attachments: materials.attachments,
    });
    const sent = await api.intl.send(saved.lead_id, { draft_version: draft.version, idempotency_key: 'match-send' }, '42');
    assert.equal(sent.simulated, true);
    assert.ok(sent.attachments.some((item) => item.kind === 'link' && item.url.includes('marina-2br')));
    const pdf = await api.intl.brochure('P1');
    assert.equal(pdf.body_bytes.slice(0, 5).toString(), '%PDF-');
    const explicit = await api.intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:other', sender_name: 'Omar',
      text: 'Dubai Marina 2 bedroom', property_id: 'P2', dedup_key: 'match-2', fixture: true,
    });
    assert.equal(api.intl.lead(explicit.lead_id).property_id, 'P2');
  } finally {
    api.close();
  }
});

test('the brochure route returns the PDF and nothing is delivered outside the app', async () => {
  const api = openIntl();
  const server = buildIntlServer(api.config, api.intl);
  try {
    await api.intl.addProperty({
      id: 'P1', title: 'Marina', kind: 'sale', price: 500000, currency: 'USD', price_period: 'total', tz: 'Asia/Dubai', make_brochure: true,
    }, '42');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const init = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42 }),
    }, api.config.TELEGRAM_BOT_TOKEN);
    const res = await fetch(`http://127.0.0.1:${port}/v1/intl/properties/P1/brochure.pdf`, {
      headers: { Authorization: `tma ${init}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/pdf/);
    assert.equal(buf.slice(0, 5).toString(), '%PDF-');
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buf });
    const parsed = await parser.getText();
    await parser.destroy();
    assert.match(parsed.text || '', /Marina/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    api.close();
  }
});
