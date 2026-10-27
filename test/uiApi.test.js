'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../engine/server');
const { makeDeps, testConfig } = require('../support/helpers');
const { signInitData } = require('../core/uiAuth');

const NOW = new Date('2026-10-21T10:00:00.000Z');
const BOT = '123456:bot-token';

function listen(deps) {
  const server = buildServer(deps);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function call(port, method, pathname, { body, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

function deps(extra = {}) {
  const config = testConfig({
    TELEGRAM_BOT_TOKEN: BOT,
    TELEGRAM_ALLOWED_USER_IDS: '4242',
    UI_PUBLIC_BASE: 'http://127.0.0.1:18791',
    ...extra,
  });
  const built = makeDeps({ config });
  built.clock = () => NOW;
  return built;
}

function tma(userId, skewS = 0) {
  const initData = signInitData({
    auth_date: String(Math.floor(NOW.getTime() / 1000) + skewS),
    user: JSON.stringify({ id: userId, first_name: 'Maria' }),
  }, BOT);
  return { Authorization: `tma ${initData}` };
}

test('the mini app API rejects missing, forged, expired and foreign Telegram users', async () => {
  const built = deps({ DEMO_UI_NO_AUTH: 'false' });
  const { server, port } = await listen(built);
  try {
    const missing = await call(port, 'GET', '/v1/ui/leads');
    assert.equal(missing.status, 401);
    const forged = await call(port, 'GET', '/v1/ui/leads', { headers: { Authorization: 'tma auth_date=1&user=%7B%22id%22%3A4242%7D&hash=deadbeef' } });
    assert.equal(forged.status, 401);
    assert.equal(forged.json.error_code, 'unauthorized');
    const expired = await call(port, 'GET', '/v1/ui/leads', { headers: tma(4242, -7200) });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error_code, 'expired');
    const foreign = await call(port, 'GET', '/v1/ui/leads', { headers: tma(999) });
    assert.equal(foreign.status, 403);
    assert.match(foreign.json.message, /Maklerbüro/);
    const ok = await call(port, 'GET', '/v1/ui/leads', { headers: tma(4242) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.leads.some((lead) => lead.email), false);
    assert.equal(ok.json.leads.some((lead) => lead.grade === 'HOT'), true);
    const detail = await call(port, 'GET', '/v1/ui/leads/L-20261021-0102', { headers: tma(4242) });
    assert.equal(detail.json.lead.email, 'lena.krueger@lead.testdomain.de');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('demo mode opens the broker UI in a browser and refuses to do so for live mail', async () => {
  const built = deps({ DEMO_UI_NO_AUTH: 'true' });
  const { server, port } = await listen(built);
  try {
    const list = await call(port, 'GET', '/v1/ui/leads');
    assert.equal(list.status, 200);
    assert.ok(list.json.leads.length >= 5);
    assert.ok(list.json.leads.length <= 12);
    assert.equal(new Set(list.json.leads.map((lead) => lead.grade)).has('WARM'), true);
    assert.equal(list.json.leads.some((lead) => lead.grade === 'HOT' && lead.reply_status === 'pending_approval'), true);
    assert.equal(list.json.leads.some((lead) => lead.status_label === 'Prüfung nötig' && lead.reply_status === 'pending_approval'), true);
    assert.equal(list.json.leads.some((lead) => lead.reasons.some((reason) => reason.includes('Einkommen'))), false);
    const boot = await call(port, 'GET', '/v1/ui/bootstrap');
    assert.equal(boot.json.slot_rules, undefined);
    assert.doesNotMatch(boot.json.grade_hint, /Einkommen/);
    assert.equal(boot.json.product, 'Erstantwort');
    assert.match(boot.json.grade_hint_owner, /Verkaufszeitraum/);
    assert.doesNotMatch(boot.json.grade_hint_owner, /Budget/);
    const lenaCard = await call(port, 'GET', '/v1/ui/leads/L-20261021-0102');
    assert.deepEqual(lenaCard.json.lead.missing_labels, ['Einzugstermin']);
    assert.equal(lenaCard.json.lead.missing_fields.includes('budget'), false);
    const week = await call(port, 'GET', '/v1/ui/bookings?week=2026-W43');
    assert.doesNotMatch(JSON.stringify(week.json), /SLOT_RULES|Besichtigung 9000/);
    assert.match(week.json.days.find((day) => day.items.length).label, /^[A-Za-z]{2}\., \d{2}\.\d{2}\.$/);
    assert.equal(week.json.days.some((day) => day.items.some((item) => item.status === 'gebucht')), true);
    assert.equal(week.json.days.some((day) => day.items.some((item) => item.status === 'unbestätigt')), false);
    const blocked = deps({ DEMO_UI_NO_AUTH: 'true', MAIL_MODE: 'smtp' });
    const live = await listen(blocked);
    try {
      const denied = await call(live.port, 'GET', '/v1/ui/leads');
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error_code, 'demo_auth_blocked');
    } finally {
      await new Promise((resolve) => live.server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('freigeben is simulated, stop does not opt the lead out, and the hours tile is a Schätzung', async () => {
  const built = deps({ DEMO_UI_NO_AUTH: 'true', SEND_MODE: 'auto' });
  const { server, port } = await listen(built);
  try {
    const numbers = await call(port, 'GET', '/v1/ui/metrics?days=7');
    assert.equal(numbers.json.schaetzung, true);
    assert.match(numbers.json.formula, /Schätzung/);
    assert.equal(numbers.json.counts.auto_replies, 4);
    assert.equal(numbers.json.counts.bookings, 3);
    assert.equal(numbers.json.eingesparte_stunden, (4 * 5 + 3 * 10) / 60);
    const approve = await call(port, 'POST', '/v1/ui/leads/L-20261021-0102/approve', {
      headers: { 'Idempotency-Key': 'once' },
      body: {},
    });
    assert.equal(approve.json.simulated, true);
    assert.match(approve.json.message, /nicht gesendet/);
    assert.equal(built.mail.sent.length, 0);
    const lena = await call(port, 'GET', '/v1/ui/leads/L-20261021-0102');
    assert.equal(lena.json.lead.status_label, 'Gesendet (Demo)');
    const again = await call(port, 'POST', '/v1/ui/leads/L-20261021-0102/approve', {
      headers: { 'Idempotency-Key': 'once' },
      body: {},
    });
    assert.equal(again.json.simulated, true);
    const stop = await call(port, 'POST', '/v1/ui/leads/L-20261021-0101/stop', { body: {} });
    assert.equal(stop.json.telegram_text.includes('@'), false);
    assert.match(stop.json.telegram_text, /STOP L-20261021-0101/);
    assert.equal(built.telegram.messages[0].includes('Jonas'), false);
    const detail = await call(port, 'GET', '/v1/ui/leads/L-20261021-0101');
    assert.equal(detail.json.lead.optout, false);
    assert.equal(detail.json.lead.needs_human_reason, 'makler_stop');
    const approveMode = deps({ DEMO_UI_NO_AUTH: 'true', SEND_MODE: 'approve' });
    const other = await listen(approveMode);
    try {
      const quiet = await call(other.port, 'GET', '/v1/ui/metrics?days=7');
      assert.equal(quiet.json.eingesparte_stunden, null);
      assert.match(quiet.json.sla_label, /Freigabephase/);
    } finally {
      await new Promise((resolve) => other.server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the public questionnaire link rescores Lena and ignores household fields', async () => {
  const built = deps({
    DEMO_UI_NO_AUTH: 'true',
    FRAGEBOGEN_INCOME_ENABLED: 'true',
    FRAGEBOGEN_PERSONS_ENABLED: 'true',
  });
  const { server, port } = await listen(built);
  try {
    const form = await call(port, 'GET', '/f/demo-lena-token-0001');
    assert.equal(form.json.ok, true);
    assert.ok(form.json.steps[0].fields.some((field) => field.label.includes('Ab wann möchten Sie einziehen')));
    assert.equal(form.json.steps[0].fields.some((field) => field.name === 'budget_eur'), false);
    assert.doesNotMatch(form.json.datenschutz, /REPLACE_ME/);
    const stopped = await call(port, 'GET', '/f/demo-mia-token-0001');
    assert.equal(stopped.json.error_code, 'stopped');
    const sent = await call(port, 'POST', '/f/demo-lena-token-0001', {
      body: {
        ansprache: 'Lena',
        timeline: 'bis_3_monate',
        budget_eur: 1300,
        intent: 'anmieten',
        income_band: 'hoch',
        persons: '4',
        pets: 'ja',
        datenschutz_gelesen: true,
      },
    });
    assert.equal(sent.json.score, 60);
    assert.equal(sent.json.grade, 'HOT');
    assert.equal(sent.json.reasons.includes('Budget passt'), false);
    assert.match(sent.json.telegram_text, /Lead jetzt HOT/);
    assert.equal(sent.json.telegram_text.includes('@'), false);
    assert.equal(built.telegram.messages.some((text) => text.includes('@') || text.includes('Lena')), false);
    const detail = await call(port, 'GET', '/v1/ui/leads/L-20261021-0102');
    assert.equal(detail.json.lead.score, 60);
    assert.equal(detail.json.lead.missing_fields.includes('budget'), false);
    assert.equal((detail.json.lead.missing_labels || []).includes('Budget'), false);
    assert.doesNotMatch((detail.json.lead.missing_labels || []).join(' '), /\bbudget\b/);
    assert.equal(detail.json.lead.persons_count, undefined);
    assert.equal(detail.json.lead.pets, undefined);
    assert.equal(JSON.stringify(detail.json).includes('persons_count'), false);
    const duplicate = await call(port, 'POST', '/f/demo-lena-token-0001', { body: { datenschutz_gelesen: true } });
    assert.equal(duplicate.json.error_code, 'already');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
