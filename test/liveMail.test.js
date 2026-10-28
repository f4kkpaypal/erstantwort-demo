'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../engine/server');
const { createRuntime } = require('../engine/adapters');
const { pollOnce } = require('../engine/imap');
const { testConfig } = require('../support/helpers');
const { startMiniSmtp, startMiniImap } = require('../support/miniMail');
const { signInitData } = require('../core/uiAuth');
const { STOP_LINE } = require('../core/template');

const BOT = '123456:bot-token';
const E01 = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'eml', 'E01.eml'), 'utf8');

function tma() {
  const initData = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 4242, first_name: 'Maria' }),
  }, BOT);
  return { Authorization: `tma ${initData}` };
}

test('local IMAP and SMTP run intake and Freigabe, and a slot reply waits for Freigabe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erstantwort-mail-'));
  const smtp = await startMiniSmtp();
  const imap = await startMiniImap({ user: 'makler', pass: 'local-pass' });
  imap.push(E01);
  const config = testConfig({
    DATA_DIR: dir,
    UI_STORE: 'sqlite',
    SEND_MODE: 'approve',
    MAIL_MODE: 'smtp',
    IMAP_MODE: 'imap',
    IMAP_HOST: '127.0.0.1',
    IMAP_PORT: String(imap.port),
    IMAP_USER: 'makler',
    IMAP_PASSWORD: 'local-pass',
    IMAP_SECURE: 'false',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: 'plain',
    SMTP_USER: 'makler@lead.testdomain.de',
    SMTP_PASSWORD: 'local-pass',
    LLM_MODE: 'mock',
    CALENDAR_MODE: 'mock',
    CRM_MODE: 'file',
    TELEGRAM_MODE: 'log',
    TELEGRAM_BOT_TOKEN: BOT,
    TELEGRAM_ALLOWED_USER_IDS: '4242',
    DEMO_UI_NO_AUTH: 'false',
    OFFICE_MODE: 'live',
    REQUIRE_DKIM_PASS: 'false',
    OWNER_LEADS_ENABLED: 'false',
    OPERATOR_NAME: 'Roman Beispiel',
    OPERATOR_BUERO: 'Beispiel Immobilien',
    OPERATOR_ADDRESS: 'Beispielweg 2, 90402 Nürnberg',
    OPERATOR_EMAIL: 'makler@lead.testdomain.de',
  });
  let runtime;
  let server;
  try {
    runtime = await createRuntime(config);
    const first = await pollOnce(runtime);
    assert.equal(first.count, 1);
    assert.equal(smtp.messages.length, 0);
    const cards = await runtime.board.listCards();
    assert.equal(cards.length, 1);
    const lead = cards[0];
    assert.equal(lead.reply_status, 'pending_approval');
    assert.match(lead.draft_text, /künstlicher Intelligenz/);
    assert.match(lead.draft_text, /STOP/);
    assert.equal(lead.email, 'anna.schmidt@lead.testdomain.de');
    runtime.db.close();

    const again = await createRuntime(config);
    runtime = again;
    const kept = await runtime.board.getCard(lead.lead_id);
    assert.equal(kept.email, lead.email);
    assert.equal(kept.reply_status, 'pending_approval');
    assert.equal(kept.draft_text, lead.draft_text);

    server = buildServer(runtime);
    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    const approved = await fetch(`http://127.0.0.1:${port}/v1/ui/leads/${lead.lead_id}/approve`, {
      method: 'POST',
      headers: { ...tma(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    }).then((res) => res.json());
    assert.equal(approved.simulated, false);
    assert.equal(approved.message, 'Gesendet.');
    assert.ok(approved.message_id);
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0], /Intelligenz/);
    assert.match(smtp.messages[0], /STOP/);
    const shown = await fetch(`http://127.0.0.1:${port}/v1/ui/leads/${lead.lead_id}`, {
      headers: { ...tma(), Accept: 'application/json' },
    }).then((res) => res.json());
    assert.equal(shown.lead.reply_status, 'sent');
    assert.equal(shown.lead.send_simulated, false);
    assert.equal(shown.lead.status_label, 'Beantwortet');

    const reply = [
      'From: Anna Schmidt <anna.schmidt@lead.testdomain.de>',
      'To: makler@lead.testdomain.de',
      `Subject: Re: Anfrage [${lead.lead_id}]`,
      'Message-ID: <reply-slot@lead.testdomain.de>',
      `In-Reply-To: ${approved.message_id}`,
      'Date: Thu, 22 Oct 2026 12:00:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '2',
      '',
    ].join('\r\n');
    imap.push(reply);
    const second = await pollOnce(runtime);
    assert.equal(second.count, 1);
    assert.equal(runtime.calendar.events.length, 0);
    assert.equal(smtp.messages.length, 1);
    const shownAfter = await fetch(`http://127.0.0.1:${port}/v1/ui/leads/${lead.lead_id}`, {
      headers: { ...tma(), Accept: 'application/json' },
    }).then((res) => res.json());
    assert.equal(shownAfter.lead.booking_status, 'awaiting_freigabe');
    assert.match(STOP_LINE, /STOP/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (runtime?.db?.close) runtime.db.close();
    await smtp.close();
    await imap.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
