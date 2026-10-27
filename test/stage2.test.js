'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../core/config');
const { SqliteStore } = require('../core/sqliteStore');
const { parseOwnerMail } = require('../core/ownerLead');
const { parseEml } = require('../core/eml');
const { runRetention } = require('../core/retention');
const { opsAlert, silenceDue } = require('../engine/loops');
const { createTelegram } = require('../engine/adapters');
const { alertText, shouldNotifyTelegram } = require('../scripts/watch');
const { backup, restoreCheck, pgPlan } = require('../scripts/ops');
const { init, check, publicLine, composeCommand } = require('../scripts/office');
const { renderLanding, DISQ_URL } = require('../landing/render');
const { buildServer } = require('../engine/server');
const { makeDeps, testConfig } = require('../support/helpers');
const { AI_FIRST_LINE } = require('../core/template');

const NOW = new Date('2026-10-21T10:00:00.000Z');

function listen(deps) {
  const server = buildServer(deps);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function call(port, method, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('a second office is its own directory and the check prints no secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureaus-'));
  const previous = process.env.BUREAUS_DIR;
  process.env.BUREAUS_DIR = root;
  try {
    assert.equal(init('buero-2').ok, true);
    assert.equal(init('buero-3').ok, true);
    const first = check('buero-2');
    const second = check('buero-3');
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.enginePort, second.enginePort);
    assert.equal(first.ownerLeads, false);
    assert.equal(first.store, 'sqlite');
    const raw = fs.readFileSync(path.join(root, 'buero-2', '.env'), 'utf8');
    const token = raw.match(/^ENGINE_TOKEN=(.+)$/m)[1];
    assert.equal(publicLine(first).includes(token), false);
    const live = raw
      .replace('OFFICE_MODE=demo', 'OFFICE_MODE=live')
      .replace('IMAP_PASSWORD=', 'IMAP_PASSWORD=super-secret-mail');
    fs.writeFileSync(path.join(root, 'buero-2', '.env'), live);
    const failed = check('buero-2');
    assert.equal(failed.ok, false);
    const line = publicLine(failed);
    assert.match(line, /OPERATOR_NAME/);
    assert.equal(line.includes('super-secret-mail'), false);
    assert.match(composeCommand('buero-2'), /erstantwort-buero-2/);
    assert.equal(composeCommand('buero-2').includes(token), false);
  } finally {
    if (previous === undefined) delete process.env.BUREAUS_DIR;
    else process.env.BUREAUS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retention removes the calendar event and keeps the STOP hash', async () => {
  const calendar = {
    events: [
      { title: 'Besichtigung 1 · L-old', start: '2020-01-01', end: '2020-01-01' },
      { title: 'Besichtigung 1 · L-new', start: '2026-10-01', end: '2026-10-01' },
    ],
    async deleteForLead(leadId) {
      const before = this.events.length;
      this.events = this.events.filter((event) => !event.title.includes(leadId));
      return before - this.events.length;
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retain-'));
  const store = new SqliteStore(path.join(dir, 'autopilot.sqlite'));
  try {
    await store.addOptout('hash-stop');
    await store.upsertCard({
      lead_id: 'L-old',
      created_at: '2020-01-01T00:00:00.000Z',
      retention_until: '2020-06-01T00:00:00.000Z',
    });
    const result = await runRetention({ board: store, db: store, calendar }, new Date('2026-10-26T00:00:00.000Z'));
    assert.equal(result.deleted, 1);
    assert.equal(result.optout_kept, true);
    assert.equal(await store.isOptout('hash-stop'), true);
    assert.equal(calendar.events.length, 1);
    assert.match(calendar.events[0].title, /L-new/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owner mail tolerates case, spaces and HTML and stays an assumption', () => {
  const html = `
    <html><body>
      <p>Annahme-Format:  IMMOWELT-EIGENTÜMER</p>
      <p>Objektart :   Haus</p>
      <table><tr><td>Fläche qm</td><td>140</td></tr>
      <tr><td>Ort</td><td>Nürnberg</td></tr></table>
      <p>Verkauf: nächsten 3 Monaten</p>
    </body></html>`;
  const parsed = parseOwnerMail({ source: 'immowelt', html, text: 'kurz' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.assumption, true);
  assert.equal(parsed.fields.object_type, 'haus');
  assert.equal(parsed.fields.area_sqm, 140);
  assert.equal(parsed.fields.city, 'Nürnberg');
  assert.equal(parsed.fields.timeline_horizon, 'bis_3_monate');
  const spaced = parseOwnerMail({
    source: 'heimziel',
    text: 'Annahme-Format:   HEIMZIEL-EIGENTUEMER\nObjektart: wohnung\nFlaeche_qm:  60\n',
  });
  assert.equal(spaced.ok, true);
  assert.equal(spaced.fields.object_type, 'wohnung');
  assert.equal(spaced.fields.area_sqm, 60);
  const raw = [
    'From: notify@owner-immowelt.example',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\n');
  const mail = parseEml(raw);
  assert.equal(mail.textPlain, '');
  assert.match(mail.textHtml, /Annahme-Format/);
  const multi = parseEml([
    'From: notify@owner.example',
    'Content-Type: multipart/alternative; boundary=b',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'kurz',
    '--b',
    'Content-Type: text/html',
    '',
    '<p>Annahme-Format: immowelt-eigentuemer</p>',
    '--b--',
    '',
  ].join('\n'));
  assert.equal(multi.textPlain, 'kurz');
  assert.match(multi.textHtml, /immowelt-eigentuemer/);
});

test('the broker can edit a pending draft and move a viewing without sending mail', async () => {
  const built = makeDeps({ config: testConfig({ DEMO_UI_NO_AUTH: 'true' }) });
  built.clock = () => NOW;
  built.calendar.events.push({
    title: 'Besichtigung 90000002 · L-20261021-0103',
    start: '2026-10-22T09:00:00.000Z',
    end: '2026-10-22T09:45:00.000Z',
  });
  const { server, port } = await listen(built);
  try {
    const paul = await call(port, 'GET', '/v1/ui/leads/L-20261021-0105');
    assert.match(paul.json.lead.draft_text, /STOP/);
    const broken = await call(port, 'POST', '/v1/ui/leads/L-20261021-0105/draft', {
      text: 'Guten Tag, ohne Pflichtzeilen.',
    });
    assert.equal(broken.status, 409);
    assert.equal(broken.json.error_code, 'draft_incomplete');
    const text = `${paul.json.lead.draft_text}\nBitte antworten Sie auf diese E-Mail.`;
    const saved = await call(port, 'POST', '/v1/ui/leads/L-20261021-0105/draft', { text });
    assert.equal(saved.status, 200);
    assert.match(saved.json.message, /gespeichert/);
    assert.equal(saved.json.draft_text.includes(AI_FIRST_LINE), true);
    const again = await call(port, 'GET', '/v1/ui/leads/L-20261021-0105');
    assert.match(again.json.lead.draft_text, /Bitte antworten Sie auf diese E-Mail/);
    const options = await call(port, 'GET', '/v1/ui/bookings/bk-timur/options');
    assert.equal(options.json.mailed, false);
    assert.ok(options.json.slots.length >= 1);
    const moved = await call(port, 'POST', '/v1/ui/bookings/bk-timur/move', {
      start: options.json.slots[0].start,
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.mailed, false);
    assert.match(moved.json.message, /keine E-Mail/);
    assert.equal(built.mail.sent.length, 0);
    assert.equal(built.calendar.events[0].start, options.json.slots[0].start);
    const week = await call(port, 'GET', '/v1/ui/bookings?week=2026-W43');
    const flat = JSON.stringify(week.json);
    assert.match(flat, /keine E-Mail|nicht raus/);
    assert.equal(flat.includes('unbestätigt'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ops alerts stay free of personal data and do not call Telegram unless asked', async () => {
  const text = opsAlert({
    OFFICE_SLUG: 'buero-2',
    IMAP_USER: 'a@b.de',
    IMAP_PASSWORD: 'secret-pass-99',
  });
  assert.match(text, /Büro buero-2/);
  assert.equal(text.includes('secret-pass-99'), false);
  assert.equal(text.includes('@'), false);
  assert.equal(opsAlert({ OFFICE_SLUG: 'Maria K.' }).includes('Maria'), false);
  assert.equal(silenceDue({
    imapLastOk: '2026-10-26T10:00:00.000Z',
    silenceMs: 15 * 60 * 1000,
    now: Date.parse('2026-10-26T10:20:00.000Z'),
  }), true);
  const alert = alertText('anna@lead.testdomain.de', { OFFICE_SLUG: 'buero-2' });
  assert.equal(alert.includes('@'), false);
  assert.equal(alert.includes('anna'), false);
  assert.match(alert, /health/);
  assert.equal(shouldNotifyTelegram({
    TELEGRAM_MODE: 'log',
    TELEGRAM_BOT_TOKEN: '123:abc',
    OPS_TELEGRAM_CHAT_ID: '1',
  }), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  const telegram = createTelegram(loadConfig({ TELEGRAM_MODE: 'log', DATA_DIR: dir }));
  await assert.rejects(() => telegram.sendOps('schreiben Sie an a@b.de'), /ops_alert_rejected/);
  await telegram.sendOps(text);
  const log = fs.readFileSync(path.join(dir, 'telegram.log'), 'utf8');
  assert.match(log, /buero-2/);
  assert.equal(log.includes('secret-pass-99'), false);
});

test('sqlite backup and a postgres dump plan do not keep the database password', () => {
  assert.equal(pgPlan({ POSTGRES_PASSWORD: 'change-me-postgres' }).ready, false);
  assert.equal(pgPlan({ POSTGRES_PASSWORD: 'real-db-secret' }).ready, true);
  assert.deepEqual(pgPlan({}).databases, ['n8n', 'makler']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const store = new SqliteStore(path.join(dir, 'autopilot.sqlite'));
  store.close();
  const saved = backup({ DATA_DIR: dir, POSTGRES_PASSWORD: 'change-me-postgres' });
  assert.equal(saved.ok, true);
  assert.equal(saved.postgres, 'skipped');
  fs.writeFileSync(path.join(saved.dest, 'n8n.sql'), '-- PostgreSQL database dump\nCREATE TABLE t(id int);\n');
  fs.writeFileSync(path.join(saved.dest, 'makler.sql'), '-- PostgreSQL database dump\nCREATE TABLE t(id int);\n');
  const ok = restoreCheck({ DATA_DIR: dir, POSTGRES_PASSWORD: 'real-db-secret' });
  assert.equal(ok.ok, true);
  assert.match(ok.line, /postgres=ok/);
  fs.writeFileSync(path.join(saved.dest, 'n8n.sql'), '-- PostgreSQL database dump\nreal-db-secret\n');
  const leaked = restoreCheck({ DATA_DIR: dir, POSTGRES_PASSWORD: 'real-db-secret' });
  assert.equal(leaked.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the landing page is static, cites DISQ, and does not invent a live office', () => {
  const demo = renderLanding(loadConfig({}));
  assert.match(demo, /Erstantwort/);
  assert.match(demo, /47 Prozent/);
  assert.match(demo, /30 Tage Pilot kostenlos/);
  assert.match(demo, new RegExp(DISQ_URL.replace(/[.]/g, '\\.')));
  assert.match(demo, /speichert nichts/);
  assert.match(demo, /disabled/);
  assert.doesNotMatch(demo, /<script/i);
  assert.doesNotMatch(demo, /google-analytics|fonts\.googleapis|cdn\./i);
  assert.match(demo, /impressum/);
  const live = renderLanding(loadConfig({ OFFICE_MODE: 'live', PRODUCT_NAME: 'Erstantwort' }));
  assert.match(live, /Angaben fehlen/);
  assert.doesNotMatch(live, /Johannisstraße|Nürnberg|Maria K/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'landing', 'site.css'), 'utf8');
  assert.doesNotMatch(css, /@import|url\(http/i);
  const caddy = fs.readFileSync(path.join(__dirname, '..', 'Caddyfile.prod'), 'utf8');
  assert.match(caddy, /\{\$APP_ADDRESS\}/);
  assert.match(caddy, /\/engine\/v1\/health/);
  assert.match(caddy, /WEB_PUBLISH_PORT/);
  assert.doesNotMatch(caddy, /strip_prefix \/engine/);
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.prod.yml'), 'utf8');
  assert.match(compose, /watch\.js/);
  assert.match(compose, /APP_ADDRESS/);
  const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'battle.sh'), 'utf8');
  assert.match(sh, /docker compose/);
  assert.doesNotMatch(sh, /echo \$\{?POSTGRES_PASSWORD/);
});
