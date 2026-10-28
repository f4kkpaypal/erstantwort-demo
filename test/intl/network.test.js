'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

test('D21 the ingest, send, digest and webhook paths do not call the network', async () => {
  const calls = [];
  function trap(name) {
    return () => {
      calls.push(name);
      throw new Error('outbound_blocked');
    };
  }
  const saved = {
    fetch: global.fetch,
    request: http.request,
    secure: https.request,
    connect: net.connect,
    lookup: dns.lookup,
  };
  global.fetch = trap('fetch');
  http.request = trap('http.request');
  https.request = trap('https.request');
  net.connect = trap('net.connect');
  dns.lookup = trap('dns.lookup');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { EventEmitter } = require('events');
  const { loadConfig } = require('../../core/config');
  const { createIntl } = require('../../core/intl/service');
  const { buildIntlServer } = require('../../engine/intlServer');
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-'));
    const config = loadConfig({
      PRODUCT_MODE: 'intl',
      CHANNEL_MODE: 'sim',
      HASH_SALT: 'intl-test-salt',
      ENGINE_TOKEN: 'intl-engine-token-0123456789',
      TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      TELEGRAM_ALLOWED_USER_IDS: '42',
      TG_TEST_LEAD_IDS: '42,9300000001',
      TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
      DATA_DIR: dir,
      UI_PUBLIC_BASE: 'http://127.0.0.1:8791',
      REAL_DATA_ALLOWED: 'false',
      LLM_MODE: 'mock',
    });
    const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z') });
    await intl.addProperty({
      id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
    }, '42');
    const lead = await intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:net', sender_name: 'Omar', text: 'Can I view it this week?',
      property_id: 'P1', dedup_key: 'net-1', fixture: true,
    });
    const draft = await intl.saveDraft(lead.lead_id, { text: 'Hello Omar. Which day and time suit you?', option_id: 'ask' });
    const sent = await intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'net-send' }, '42');
    const digest = intl.digestTick('schedule', '42');
    assert.equal(sent.ok, true);
    assert.equal(sent.simulated, true);
    assert.equal(digest.digest_sent, 1);
    const server = buildIntlServer(config, intl);
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('webhook hung')), 2000);
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/v1/intl/telegram';
      req.headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };
      const res = {
        writeHead(code) { this.status = code; },
        end(body) { clearTimeout(timer); resolve({ status: this.status, body }); },
      };
      server.emit('request', req, res);
      setTimeout(() => {
        req.emit('data', Buffer.from(JSON.stringify({
          update_id: 9,
          message: { message_id: 3, chat: { id: '9300000001' }, text: '/lead P1 What is the price?', from: { first_name: 'A' } },
        })));
        req.emit('end');
      }, 0);
    });
    assert.equal(status.status, 200);
    assert.equal(calls.length, 0);
    intl.close();
  } finally {
    global.fetch = saved.fetch;
    http.request = saved.request;
    https.request = saved.secure;
    net.connect = saved.connect;
    dns.lookup = saved.lookup;
  }
});

test('D14 and D16 fixtures and the send path do not embed a bot token or a second sender', () => {
  const root = path.join(__dirname, '..', '..');
  const fixture = fs.readFileSync(path.join(root, 'fixtures', 'intl', 'testset.json'), 'utf8');
  assert.equal(/\d{6,}:[A-Za-z0-9_-]{30,}/.test(fixture), false);
  const service = fs.readFileSync(path.join(root, 'core', 'intl', 'service.js'), 'utf8');
  const calls = service.split('\n').filter((line) => line.includes('channel.send(') && !line.includes('function'));
  assert.equal(calls.length, 1);
  const host = fs.readFileSync(path.join(root, 'scripts', 'free_host.js'), 'utf8');
  assert.equal(/TELEGRAM_ALLOWED_USER_IDS:\s*'?\d{5,}/.test(host), false);
});
