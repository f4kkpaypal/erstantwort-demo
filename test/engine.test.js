'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildServer } = require('../engine/server');
const { createLlm } = require('../engine/adapters');
const { loadConfig } = require('../core/config');
const { findPii } = require('../core/redact');
const { makeDeps, loadMail, testConfig } = require('../support/helpers');

async function listen(deps) {
  const server = buildServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function call(port, method, pathname, body, headers = {}, token = 'test-engine-token-0123456789') {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-engine-token': token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

function tempDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'makler-'));
  const deps = makeDeps({
    config: testConfig({ DATA_DIR: dir, ADMIN_TOKEN: overrides.ADMIN_TOKEN || '', ...overrides }),
  });
  deps.storeKind = 'injected';
  deps.access = [];
  deps.dataDir = dir;
  deps.llm = createLlm(deps.config);
  return deps;
}

test('health exposes the loom defaults and no secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'makler-'));
  const deps = makeDeps({
    config: loadConfig({
      DATA_DIR: dir,
      ADMIN_TOKEN: 'secret-token',
      HASH_SALT: 'test-salt',
      GENERIC_TIMEZONE: 'Europe/Berlin',
    }),
  });
  deps.storeKind = 'injected';
  const { server, port } = await listen(deps);
  try {
    const { status, json } = await call(port, 'GET', '/v1/health', undefined, {}, '');
    const locked = await call(port, 'POST', '/v1/intake/run', {}, {}, '');
    assert.equal(locked.status, 401);
    assert.equal(locked.json.error_code, 'unauthorized');
    assert.equal(status, 200);
    assert.equal(json.timezone, 'Europe/Berlin');
    assert.equal(json.send_mode, 'approve');
    assert.equal(json.approval_timeout_action, 'remind');
    assert.equal(json.retention_days_lead, 180);
    assert.equal(json.first_response_sla_seconds, 300);
    assert.equal(json.sla_applies_to, 'auto');
    assert.equal(json.portal, 'immoscout24');
    assert.equal(json.crm_target, 'sheets');
    assert.equal(json.flags.followup_email_enabled, false);
    assert.equal(json.flags.noshow_reoffer_enabled, false);
    assert.equal(json.flags.interesse_followup_enabled, false);
    const blob = JSON.stringify(json);
    assert.equal(blob.includes('secret-token'), false);
    assert.equal(blob.includes('test-salt'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /v1/intake/run scores E01 HOT 75 and keeps personal data out of logs', async () => {
  const deps = tempDeps();
  const { server, port } = await listen(deps);
  try {
    const { status, json } = await call(port, 'POST', '/v1/intake/run', loadMail('E01'));
    assert.equal(status, 200);
    assert.equal(json.outcome, 'SENT');
    assert.equal(json.grade, 'HOT');
    assert.equal(json.score, 75);
    assert.match(json.mail.text, /^Hinweis: Diese Antwort wurde mithilfe künstlicher Intelligenz \(KI\) erstellt\./);
    assert.match(json.mail.text, /Ein Tiefgaragenstellplatz ist vorhanden und kann separat angemietet werden\./);
    const saved = JSON.parse(fs.readFileSync(path.join(deps.dataDir, 'demo_state.json'), 'utf8'));
    assert.equal(saved.lead_id, json.lead_id);
    assert.equal(saved.portal_listing_id, '63843270');
    assert.match(saved.outbound_message_id, /@lead\.testdomain\.de>$/);
    const savedBlob = JSON.stringify(saved);
    assert.equal(savedBlob.includes('anna.schmidt'), false);
    assert.equal(savedBlob.includes('Anna'), false);
    assert.equal(savedBlob.includes('Schmidt'), false);
    const sink = JSON.stringify({ logs: deps.logs, telegram: deps.telegram.messages, access: deps.access });
    assert.equal(findPii(sink, ['anna.schmidt@lead.testdomain.de', 'Anna', 'Schmidt', '+49 30 0000001']).length, 0);
    assert.equal(sink.includes('n8n'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('admin reset requires a token and E11 waits for demo state', async () => {
  const deps = tempDeps();
  const { server, port } = await listen(deps);
  try {
    const denied = await call(port, 'POST', '/v1/admin/reset', {});
    assert.equal(denied.status, 403);
    const missing = await call(port, 'GET', '/v1/demo/fixture/E11');
    assert.equal(missing.json.error_code, 'demo_state_missing');
    const prefixed = await call(port, 'POST', '/v1/intake/run', {
      ...loadMail('E01'),
      messageId: 'Message-ID: <prefixed.e01.header@immobilienscout24.de>',
      from: { value: [{ address: 'noreply@immobilienscout24.de', name: 'ImmoScout24' }] },
    });
    assert.equal(prefixed.json.outcome, 'SENT');
    assert.equal(prefixed.json.normalized.from, 'noreply@immobilienscout24.de');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('admin reset with the token clears the demo lead', async () => {
  const deps = tempDeps({ ADMIN_TOKEN: 'secret-token' });
  const { server, port } = await listen(deps);
  try {
    await call(port, 'POST', '/v1/intake/run', loadMail('E01'));
    const reset = await call(port, 'POST', '/v1/admin/reset', {}, { 'x-admin-token': 'secret-token' });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.ok, true);
    assert.equal(fs.existsSync(path.join(deps.dataDir, 'demo_state.json')), false);
    const again = await call(port, 'POST', '/v1/intake/run', loadMail('E01'));
    assert.equal(again.json.outcome, 'SENT');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a send error alerts without personal data and the same mail can run again', async () => {
  const deps = tempDeps();
  deps.mail.send = async () => {
    throw Object.assign(new Error('smtp refused the address'), { code: 'smtp_down' });
  };
  const { server, port } = await listen(deps);
  try {
    const failed = await call(port, 'POST', '/v1/intake/run', loadMail('E01'));
    assert.equal(failed.status, 500);
    assert.equal(failed.json.error_code, 'smtp_down');
    assert.equal(failed.json.halt, true);
    const row = [...deps.db.messages.values()][0];
    assert.equal(row.status, 'error');
    assert.match(deps.telegram.messages.at(-1), /Störung/);
    assert.equal(deps.telegram.messages.at(-1).includes('@'), false);
    assert.equal(deps.telegram.messages.at(-1).includes('Anna'), false);
    deps.mail.send = async (message) => { deps.mail.sent.push(message); };
    const again = await call(port, 'POST', '/v1/intake/run', loadMail('E01'));
    assert.equal(again.status, 200);
    assert.equal(again.json.outcome, 'SENT');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mock llm rejects labs models and unknown fixtures', async () => {
  const llm = createLlm(loadConfig({ LLM_MODE: 'mock' }));
  await assert.rejects(
    () => llm({ model: 'mistral-labs-preview', response_format: { json_schema: { name: 'lead_extraction' } }, messages: [] }),
    (err) => err.code === 'labs_model_forbidden',
  );
  await assert.rejects(
    () => llm({ model: 'mistral-small-latest', response_format: { json_schema: { name: 'lead_extraction' } }, messages: [{ role: 'user', content: 'hello' }] }),
    (err) => err.code === 'unknown_fixture',
  );
});
