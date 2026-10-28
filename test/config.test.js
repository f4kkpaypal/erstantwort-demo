'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, listenHost, LLM_MODEL_FALLBACKS } = require('../core/config');
const { guardUnsolicited } = require('../core/pipeline');
const { propstackDriver, LEAD_COLUMNS } = require('../core/crm');

test('product defaults: approve, remind, 180 days, follow-ups off, 5 minute auto SLA', () => {
  const config = loadConfig({});
  assert.equal(config.SEND_MODE, 'approve');
  assert.equal(config.APPROVAL_TIMEOUT_ACTION, 'remind');
  assert.equal(config.RETENTION_DAYS_LEAD, 180);
  assert.equal(config.FOLLOWUP_EMAIL_ENABLED, false);
  assert.equal(config.NOSHOW_REOFFER_ENABLED, false);
  assert.equal(config.INTERESSE_FOLLOWUP_ENABLED, false);
  assert.equal(config.FIRST_RESPONSE_SLA_SECONDS, 300);
  assert.equal(config.SLA_APPLIES_TO, 'auto');
  assert.equal(config.GENERIC_TIMEZONE, 'Europe/Berlin');
  assert.equal(config.PORTAL, 'immoscout24');
  assert.equal(config.CRM_TARGET, 'sheets');
  assert.deepEqual(config.ALLOWED_SENDER_DOMAINS, ['immobilienscout24.de']);
  assert.equal(config.REQUIRE_DKIM_PASS, false);
  assert.equal(config.TRUST_PROXY, false);
  assert.equal(loadConfig({ OFFICE_MODE: 'live' }).REQUIRE_DKIM_PASS, true);
  assert.equal(loadConfig({ OFFICE_MODE: 'live', REQUIRE_DKIM_PASS: 'false' }).REQUIRE_DKIM_PASS, false);
  assert.equal(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY, true);
  assert.equal(loadConfig({ TRUST_PROXY: '2' }).TRUST_PROXY, 2);
  assert.equal(config.OFFER_ENGLISH_REPLY, false);
  assert.equal(config.LLM_MODEL_EXTRACT, 'mistral-small-latest');
  assert.equal(config.LLM_MODEL_WRITE, 'mistral-small-latest');
  assert.deepEqual(LLM_MODEL_FALLBACKS, ['mistral-small-latest', 'ministral-8b-latest']);
});

test('the demo UI defaults to auto send mode and the listen host stays local', () => {
  assert.equal(loadConfig({ DEMO_UI_NO_AUTH: 'true' }).SEND_MODE, 'auto');
  assert.equal(loadConfig({ DEMO_UI_NO_AUTH: 'true', SEND_MODE: 'approve' }).SEND_MODE, 'approve');
  assert.equal(listenHost({}), '127.0.0.1');
  assert.equal(listenHost({ HOST: '0.0.0.0' }), '0.0.0.0');
});

test('false-looking strings stay false and auto mode is explicit', () => {
  const config = loadConfig({
    SEND_MODE: 'auto',
    FOLLOWUP_EMAIL_ENABLED: 'false',
    INTERESSE_FOLLOWUP_ENABLED: '0',
    APPROVAL_TIMEOUT_ACTION: 'send_fallback',
    RETENTION_DAYS_LEAD: '30',
    LLM_MODEL: 'ministral-8b-latest',
    OFFER_ENGLISH_REPLY: 'true',
  });
  assert.equal(config.SEND_MODE, 'auto');
  assert.equal(config.FOLLOWUP_EMAIL_ENABLED, false);
  assert.equal(config.INTERESSE_FOLLOWUP_ENABLED, false);
  assert.equal(config.APPROVAL_TIMEOUT_ACTION, 'send_fallback');
  assert.equal(config.RETENTION_DAYS_LEAD, 30);
  assert.equal(config.LLM_MODEL_EXTRACT, 'ministral-8b-latest');
  assert.equal(config.LLM_MODEL_WRITE, 'ministral-8b-latest');
  assert.equal(config.OFFER_ENGLISH_REPLY, true);
});

test('unsolicited lead mail stays blocked while the flags are off', () => {
  const config = loadConfig({});
  assert.equal(guardUnsolicited('followup', config).reason, 'followup_disabled');
  assert.equal(guardUnsolicited('reoffer', config).reason, 'reoffer_disabled');
  assert.equal(guardUnsolicited('interesse_weiterhin', config).reason, 'interesse_disabled');
  const enabled = loadConfig({ FOLLOWUP_EMAIL_ENABLED: 'true', INTERESSE_FOLLOWUP_ENABLED: 'true' });
  assert.equal(guardUnsolicited('followup', enabled).ok, false);
  assert.equal(guardUnsolicited('interesse_weiterhin', enabled).reason, 'interesse_not_in_loom_slice');
});

test('Propstack is the later CRM and is not implemented in this slice', async () => {
  const driver = propstackDriver();
  const result = await driver.upsertLead({ lead_id: 'L-20261021-0001' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_IMPLEMENTED');
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /Propstack/);
});

test('the sheet row has no income, no message body and no injection quote', () => {
  for (const banned of ['income_band_eur', 'income_min_eur', 'body', 'text_clean', 'injection_evidence', 'schufa_available']) {
    assert.equal(LEAD_COLUMNS.includes(banned), false, banned);
  }
  assert.ok(LEAD_COLUMNS.includes('retention_until'));
  assert.ok(LEAD_COLUMNS.includes('email_hash'));
});
