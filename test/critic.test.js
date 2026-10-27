'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { dkimPassed } = require('../core/normalize');
const { decideSend } = require('../core/template');
const { classifyReply } = require('../core/reply');
const { eraseSubject } = require('../core/erase');
const { emailHash } = require('../core/hash');
const { clientIp, rateAllow, resetFormHits, FORM_LIMIT } = require('../core/clientIp');
const { renderDatenschutz, renderImpressum, PLACEHOLDER_NOTE } = require('../core/legal');
const { loadConfig } = require('../core/config');
const { propstackDriver, MemoryCrm } = require('../core/crm');
const { MemoryStore } = require('../core/store');
const { buildServer } = require('../engine/server');
const { makeDeps, testConfig, loadMail } = require('../support/helpers');
const { runInbound } = require('../core/pipeline');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('a message header cannot set dkimPassed, and Freigabe holds the viewing confirmation', async () => {
  assert.equal(dkimPassed({ 'authentication-results': 'mx; dkim=pass', 'x-dkim-status': 'pass' }), false);
  assert.equal(dkimPassed({ dkimVerified: true }), true);
  const held = decideSend({ kind: 'confirmation', config: { SEND_MODE: 'approve' }, optout: false });
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'awaiting_freigabe');
  assert.equal(decideSend({ kind: 'confirmation', config: { SEND_MODE: 'auto' }, optout: false }).ok, true);
  assert.equal(classifyReply('Danke, passt. STOP').action, 'stop');
  assert.equal(classifyReply('Bitte melden Sie mich ab').action, 'stop');
  assert.equal(classifyReply('Unsubscribe').action, 'stop');
  assert.equal(classifyReply('Ich nehme gern Nr. 2').slot_index, 2);

  const deps = makeDeps({ llmFixture: 'E01' });
  const intake = await runInbound(loadMail('E01'), deps);
  assert.equal(intake.sent, true);
  deps.config = testConfig({ SEND_MODE: 'approve' });
  const reply = loadMail('E11');
  reply.messageId = '<critic.nr2@lead.testdomain.de>';
  reply.inReplyTo = intake.message_id;
  reply.subject = `Re: Besichtigung [${intake.lead_id}]`;
  reply.textPlain = 'Ich nehme gern Nr. 2';
  const booked = await runInbound(reply, deps);
  assert.equal(booked.outcome, 'PENDING_APPROVAL');
  assert.equal(booked.sent, false);
  assert.equal(deps.mail.sent.length, 1);
  assert.equal(deps.calendar.events.length, 0);
  const row = await deps.crm.findByLeadId(intake.lead_id);
  assert.equal(row.lead.booking_status, 'awaiting_freigabe');
});

test('Art. 17 erasure removes the lead, keeps the STOP hash, and the script does not print the address', async () => {
  const salt = 'erase-salt';
  const email = 'person@example.invalid';
  const deps = {
    config: { HASH_SALT: salt },
    crm: new MemoryCrm(),
    db: new MemoryStore(),
    calendar: {
      events: [{ title: 'Besichtigung x · L-1' }],
      async deleteForLead(leadId) {
        this.events = this.events.filter((event) => !event.title.includes(leadId));
      },
    },
    fragebogen: { revoked: [], revokeLead(id) { this.revoked.push(id); } },
  };
  await deps.crm.upsertLead({ lead_id: 'L-1', email, first_name: 'Ada', phone: '+49 000' });
  const result = await eraseSubject(deps, email);
  assert.equal(result.ok, true);
  assert.equal(result.leads, 1);
  assert.equal(result.optout_kept, true);
  assert.equal((await deps.crm.findByEmail(email)).lead, null);
  assert.equal(await deps.db.isOptout(emailHash(email, salt)), true);
  assert.equal(deps.calendar.events.length, 0);
  assert.deepEqual(deps.fragebogen.revoked, ['L-1']);
  assert.equal((await eraseSubject(deps, 'not-an-email')).ok, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erase-'));
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'erase.js'), email], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATA_DIR: dir,
      UI_STORE: 'sqlite',
      CRM_MODE: 'file',
      CALENDAR_MODE: 'mock',
      MAIL_MODE: 'file',
      LLM_MODE: 'mock',
      TELEGRAM_MODE: 'log',
      HASH_SALT: salt,
      OFFICE_MODE: 'demo',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /erase_ok leads=0 optout=kept/);
  assert.equal(`${run.stdout}\n${run.stderr}`.includes(email), false);
});

test('the questionnaire limit uses the client address and drops stale keys', async () => {
  const socket = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.8' } };
  assert.equal(clientIp(socket, false), '127.0.0.1');
  assert.equal(clientIp(socket, true), '203.0.113.8');
  assert.equal(clientIp({ socket: { remoteAddress: '::ffff:10.0.0.4' }, headers: {} }, false), '10.0.0.4');
  const hits = new Map([['old', [Date.now() - 11 * 60 * 1000]]]);
  assert.equal(rateAllow(hits, 'fresh', Date.now()), true);
  assert.equal(hits.has('old'), false);

  resetFormHits();
  const deps = makeDeps({ config: testConfig({ TRUST_PROXY: 'true' }) });
  deps.fragebogen = { find() { return null; } };
  const server = buildServer(deps);
  const port = await listen(server);
  try {
    const hit = (ip) => fetch(`http://127.0.0.1:${port}/f/missing-token`, {
      headers: { 'x-forwarded-for': `198.51.100.1, ${ip}` },
    });
    for (let i = 0; i < FORM_LIMIT; i += 1) {
      const res = await hit('203.0.113.50');
      assert.equal(res.status, 404);
    }
    assert.equal((await hit('203.0.113.50')).status, 429);
    assert.equal((await hit('203.0.113.51')).status, 404);
  } finally {
    resetFormHits();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('legal pages stay placeholders, metrics on demo data are marked, and Propstack has no client', async () => {
  const demo = loadConfig({});
  assert.match(renderImpressum(demo), new RegExp(PLACEHOLDER_NOTE));
  assert.match(renderDatenschutz(demo), /kein fertiger Rechtstext/);
  const live = loadConfig({
    OFFICE_MODE: 'live',
    PRODUCT_NAME: 'Erstantwort',
    OPERATOR_NAME: 'Büro Beispiel',
    OPERATOR_ADDRESS: 'Straße 1',
    OPERATOR_EMAIL: 'buero@example.invalid',
  });
  assert.match(renderImpressum(live), new RegExp(PLACEHOLDER_NOTE));
  assert.match(renderDatenschutz(live), /kein fertiger Rechtstext/);
  const avv = fs.readFileSync(path.join(__dirname, '..', 'docs', 'AVV_CHECKLIST.md'), 'utf8');
  assert.match(avv, /Platzhalter — vor Nutzung durch Anwalt prüfen/);
  const owner = fs.readFileSync(path.join(__dirname, '..', 'core', 'ownerLead.js'), 'utf8');
  assert.match(owner, /Формат предположительный, не проверен на реальных письмах/);
  assert.equal(loadConfig({}).OWNER_LEADS_ENABLED, false);
  const app = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  assert.match(app, /demo_data \? 'Demo · '/);
  assert.match(app, /document\.title/);
  assert.doesNotMatch(app, /easyrent/i);
  const driver = propstackDriver();
  const result = await driver.upsertLead({ lead_id: 'L-1' });
  assert.equal(result.error.code, 'NOT_IMPLEMENTED');
  assert.match(result.error.message, /no Propstack API client/);
  const blockers = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CRITIC_BLOCKERS.md'), 'utf8');
  assert.match(blockers, /Gewerbe/);
  assert.match(blockers, /юрист/i);
});
