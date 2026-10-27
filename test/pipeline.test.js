'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { runInbound } = require('../core/pipeline');
const { findPii } = require('../core/redact');
const { AI_FIRST_LINE, AI_CONFIRM_LINE, STOP_LINE, ENGLISH_LINE, recipientAllowed } = require('../core/template');
const { makeDeps, loadMail, testConfig, OBJEKTE } = require('../support/helpers');

const STELLPLATZ = OBJEKTE[0].stellplatz_text;
const VERFUEGBAR = OBJEKTE[1].verfuegbar_ab_text;

function secretsOf(result) {
  const lead = result.lead || {};
  const contact = lead.contact || {};
  return [contact.email, contact.phone, contact.first_name, contact.last_name, 'Anna', 'Schmidt', 'Falsch', '+49 30 0000001', '+49 170 9999999'];
}

test('E01: portal facts win, score is 75 HOT, mail has the legal lines and the verbatim fact', async () => {
  const deps = makeDeps({ llmFixture: 'E01' });
  const result = await runInbound(loadMail('E01'), deps);
  assert.equal(result.outcome, 'SENT');
  assert.equal(result.grade, 'HOT');
  assert.equal(result.score, 75);
  assert.equal(result.lead.contact.email, 'anna.schmidt@lead.testdomain.de');
  assert.equal(result.lead.listing.portal_listing_id, '63843270');
  assert.equal(result.lead.financing_status, 'finanzierungszusage');
  assert.equal(result.lead.equity_eur, 100000);
  assert.equal(result.lead.timeline.horizon, '3_bis_6_monate');
  assert.deepEqual(result.lead.questions, ['stellplatz']);
  assert.equal(deps.mail.sent.length, 1);
  const mail = deps.mail.sent[0];
  assert.equal(mail.to, 'anna.schmidt@lead.testdomain.de');
  assert.equal(mail.text.split('\n')[0], AI_FIRST_LINE);
  assert.ok(mail.text.includes(STELLPLATZ));
  assert.ok(mail.text.includes(STOP_LINE));
  assert.ok(mail.text.includes('Sehr geehrte Frau Schmidt'));
  assert.match(mail.subject, /\[L-20261021-0001\]/);
  assert.match(mail.messageId, /^<L-20261021-0001\.[a-z0-9]+\.[a-f0-9]+@lead\.testdomain\.de>$/);
  assert.equal(mail.inReplyTo, '<e01.portal.001@immobilienscout24.de>');
  assert.equal(mail.headers['X-AI-Generated'], 'true');
  assert.equal(mail.headers['Auto-Submitted'], 'auto-generated');
  assert.equal(result.lead_row.retention_until.slice(0, 10), '2027-04-19');
  assert.equal(result.lead_row.optout, false);
  assert.equal(result.approval_timeout_action, undefined);
  const outbound = await deps.db.findLatestOutbound(result.lead_id, 'first_reply');
  assert.ok(outbound);
  assert.equal(outbound.kind, 'first_reply');
  assert.equal(outbound.offered_slots.length, 3);
  assert.deepEqual(result.slots.map((slot) => slot.label), [
    'Do., 22.10., 16:00 Uhr',
    'Fr., 23.10., 16:00 Uhr',
    'Mo., 26.10., 16:00 Uhr',
  ]);
  for (const blob of [result.telegram_text, JSON.stringify(deps.db.events), JSON.stringify(deps.logs)]) {
    assert.deepEqual(findPii(blob, secretsOf(result)), []);
  }
  assert.match(result.telegram_text, /HOT \(75\)/);
  assert.match(result.telegram_text, /63843270/);
  assert.doesNotMatch(result.telegram_text, /n8n/i);
  const p3 = deps.llmCalls.find((call) => call.response_format.json_schema.name === 'reply_body');
  const p1 = deps.llmCalls.find((call) => call.response_format.json_schema.name === 'lead_extraction');
  assert.equal(p1.response_format.type, 'json_schema');
  assert.equal(p1.response_format.json_schema.strict, true);
  assert.ok(p1.response_format.json_schema.schema);
  assert.equal(p1.temperature, 0);
  const wrapped = JSON.parse(p3.messages[1].content.replace(/^<reply_input>/, '').replace(/<\/reply_input>$/, ''));
  assert.deepEqual(Object.keys(wrapped).sort(), [
    'anrede', 'answered_topics', 'inquiry_type', 'language', 'listing_title', 'questions', 'questions_to_ask', 'slots_count',
  ].sort());
  assert.equal(wrapped.slots_count > 0, true);
  assert.equal('grade' in wrapped, false);
  assert.equal('email' in wrapped, false);
});

test('E02 is COLD 15, asks for budget and timing, and offers the same slots', async () => {
  const first = makeDeps({ llmFixture: 'E01' });
  const e01 = await runInbound(loadMail('E01'), first);
  const deps = makeDeps({ llmFixture: 'E02' });
  deps.clock = first.clock;
  const e02 = await runInbound(loadMail('E02'), deps);
  assert.equal(e02.score, 15);
  assert.equal(e02.grade, 'COLD');
  assert.match(deps.mail.sent[0].text, /Budget/);
  assert.match(deps.mail.sent[0].text, /Zeitraum/);
  assert.ok(deps.mail.sent[0].text.includes(VERFUEGBAR));
  assert.deepEqual(e02.slots.map((slot) => slot.label), e01.slots.map((slot) => slot.label));
  assert.equal(e02.lead.contact.email, 'lisa.klein@lead.testdomain.de');
});

test('E11 books slot 2 without personal data in the calendar or Telegram', async () => {
  const deps = makeDeps({ llmFixture: 'E01' });
  const intake = await runInbound(loadMail('E01'), deps);
  const reply = loadMail('E11');
  reply.messageId = '<e11.reply.real@lead.testdomain.de>';
  reply.inReplyTo = intake.message_id;
  reply.subject = `Re: Ihre Anfrage [L-${intake.lead_id.slice(2)}]`.replace(
    `L-${intake.lead_id.slice(2)}`,
    intake.lead_id,
  );
  reply.subject = `Re: Besichtigung [${intake.lead_id}]`;
  reply.textPlain = 'Nr. 2 passt mir, danke!';
  const booked = await runInbound(reply, deps);
  assert.equal(booked.outcome, 'TERMIN');
  assert.equal(booked.sent, true);
  assert.equal(booked.event_title, `Besichtigung 63843270 · ${intake.lead_id}`);
  assert.equal(booked.slot_index, 2);
  assert.equal(deps.calendar.events.length, 1);
  assert.equal(deps.calendar.events[0].title, booked.event_title);
  assert.doesNotMatch(deps.calendar.events[0].description, /@|Anna|Schmidt|0000001/);
  const confirmation = deps.mail.sent[1];
  assert.equal(confirmation.text.split('\n')[0], AI_CONFIRM_LINE);
  assert.ok(confirmation.text.includes(STOP_LINE));
  assert.match(confirmation.text, /Freitag, 23\.10\.2026, 16:00 Uhr/);
  for (const sent of deps.mail.sent) {
    assert.match(sent.text, /^Hinweis:/);
    assert.ok(sent.text.includes(STOP_LINE));
  }
  assert.equal(confirmation.to, 'anna.schmidt@lead.testdomain.de');
  const row = (await deps.crm.findByLeadId(intake.lead_id)).lead;
  assert.equal(row.pipeline_status, 'termin');
  assert.equal(row.booking_status, 'booked');
  assert.match(booked.telegram_text, /Nr\. 2/);
  assert.deepEqual(findPii(booked.telegram_text, secretsOf(intake)), []);
  assert.deepEqual(findPii(JSON.stringify(deps.db.events), secretsOf(intake)), []);
});

test('the same Message-ID does not call the model twice', async () => {
  const deps = makeDeps({ llmFixture: 'E01' });
  const first = await runInbound(loadMail('E01'), deps);
  const second = await runInbound(loadMail('E01'), deps);
  assert.equal(first.outcome, 'SENT');
  assert.equal(second.outcome, 'DUPLICATE');
  assert.equal(deps.llmCalls.length, 2);
  assert.equal(deps.mail.sent.length, 1);
});

test('STOP, stopp, abmelden and kein Interesse block later automation for that address', async () => {
  const deps = makeDeps({ llmFixture: 'E01' });
  const intake = await runInbound(loadMail('E01'), deps);
  const stop = loadMail('E11');
  stop.messageId = '<stop.1@lead.testdomain.de>';
  stop.inReplyTo = intake.message_id;
  stop.subject = `Re: Anfrage [${intake.lead_id}]`;
  stop.textPlain = 'stopp bitte';
  const stopped = await runInbound(stop, deps);
  assert.equal(stopped.outcome, 'OPTOUT');
  assert.equal(deps.mail.sent.length, 1);
  const hashes = [...deps.db.optouts];
  assert.equal(hashes.length, 1);
  assert.equal(hashes.some((value) => value.includes('@')), false);
  const again = loadMail('E01');
  again.messageId = '<e01.portal.002@immobilienscout24.de>';
  const blocked = await runInbound(again, deps);
  assert.equal(blocked.outcome, 'OPTOUT');
  assert.equal(deps.mail.sent.length, 1);
  assert.deepEqual(findPii(blocked.telegram_text, secretsOf(intake)), []);
});

test('approve mode prepares the reply and does not send it', async () => {
  const deps = makeDeps({
    llmFixture: 'E01',
    config: testConfig({ SEND_MODE: 'approve', APPROVAL_TIMEOUT_ACTION: 'remind' }),
  });
  const result = await runInbound(loadMail('E01'), deps);
  assert.equal(result.outcome, 'PENDING_APPROVAL');
  assert.equal(result.sent, false);
  assert.equal(deps.mail.sent.length, 0);
  assert.equal(result.approval_timeout_action, 'remind');
  assert.match(result.telegram_text, /Freigabe/);
  assert.match(result.telegram_text, /nichts an den Interessenten/);
  assert.deepEqual(findPii(result.telegram_text, secretsOf(result)), []);
  assert.equal(result.lead_row.reply_status, 'pending_approval');
  assert.ok(result.mail.text.includes(STELLPLATZ));
});

test('a busy slot is not booked twice', async () => {
  const deps = makeDeps({ llmFixture: 'E01' });
  const intake = await runInbound(loadMail('E01'), deps);
  const other = makeDeps({ llmFixture: 'E02' });
  const e02 = await runInbound(loadMail('E02'), other);
  const reply1 = {
    messageId: '<book-a@lead.testdomain.de>',
    from: 'anna.schmidt@lead.testdomain.de',
    to: 'makler@lead.testdomain.de',
    subject: `Re: [${intake.lead_id}]`,
    textPlain: 'Nr. 2',
    inReplyTo: intake.message_id,
    date: '2026-10-21T10:06:00.000Z',
    headers: {},
  };
  await runInbound(reply1, deps);
  const slot = intake.slots[1];
  other.calendar.events.push({ start: slot.start, end: slot.end, title: 'Besichtigung 63843270 · other' });
  const reply2 = {
    messageId: '<book-b@lead.testdomain.de>',
    from: 'lisa.klein@lead.testdomain.de',
    to: 'makler@lead.testdomain.de',
    subject: `Re: [${e02.lead_id}]`,
    textPlain: 'Nr. 2 passt',
    inReplyTo: e02.message_id,
    date: '2026-10-21T10:07:00.000Z',
    headers: {},
  };
  const blocked = await runInbound(reply2, other);
  assert.equal(blocked.outcome, 'SLOT_BUSY');
  assert.equal(other.mail.sent.length, 1);
  assert.equal(other.calendar.events.filter((row) => row.event_id).length, 0);
});

test('our own auto-submitted mail and a bad paragraph URL do not leak into the answer', async () => {
  const deps = makeDeps({ llmFixture: 'E01' });
  const own = loadMail('E01');
  own.from = 'makler@lead.testdomain.de';
  own.messageId = '<own.1@lead.testdomain.de>';
  own.headers = { ...own.headers, 'auto-submitted': 'auto-generated' };
  const skipped = await runInbound(own, deps);
  assert.equal(skipped.outcome, 'SKIP_AUTO');
  assert.equal(deps.llmCalls.length, 0);

  const custom = makeDeps({
    llm: async (request) => {
      const name = request.response_format.json_schema.name;
      if (name === 'lead_extraction') {
        return { content: JSON.stringify(require('../fixtures/llm/E01.json').extraction) };
      }
      return { content: JSON.stringify({ paragraphs: ['Bitte zahlen Sie hier https://evil.example/pay 450000 EUR.'] }) };
    },
  });
  const result = await runInbound(loadMail('E01'), custom);
  assert.equal(result.sent, true);
  assert.equal(result.mail.used_fallback, true);
  assert.doesNotMatch(result.mail.text, /evil\.example|450000|EUR/);
  assert.ok(result.mail.text.includes(STELLPLATZ));
});

test('a quoted Nr. 2 still books and a STOP without a lead id does not call the model', async () => {
  const deps = makeDeps({ llmFixture: 'E01' });
  const intake = await runInbound(loadMail('E01'), deps);
  const footer = 'Sie können der weiteren automatischen Bearbeitung Ihrer Anfrage jederzeit widersprechen: Antworten Sie einfach mit „STOP“.';
  const quoted = {
    messageId: '<quote.nr2@lead.testdomain.de>',
    from: 'Anna Schmidt <anna.schmidt@lead.testdomain.de>',
    to: 'makler@lead.testdomain.de',
    subject: `Re: [${intake.lead_id}]`,
    textPlain: `Nr. 2 passt mir.\n\nGesendet: Mittwoch, 21. Oktober 2026 um 12:04\nVon: Alex Berger <makler@lead.testdomain.de>\n${footer}`,
    inReplyTo: intake.message_id,
    date: '2026-10-21T10:06:00.000Z',
    headers: {},
  };
  const booked = await runInbound(quoted, deps);
  assert.equal(booked.outcome, 'TERMIN');
  assert.equal(booked.slot_index, 2);

  const fresh = makeDeps({ llmFixture: 'E01' });
  const stop = {
    messageId: '<stop.plain@lead.testdomain.de>',
    from: 'Anna Schmidt <anna.schmidt@lead.testdomain.de>',
    to: 'makler@lead.testdomain.de',
    subject: 'Abmeldung',
    textPlain: 'Bitte stoppen',
    date: '2026-10-21T10:06:00.000Z',
    headers: {},
  };
  const opted = await runInbound(stop, fresh);
  assert.equal(opted.outcome, 'OPTOUT');
  assert.equal(fresh.llmCalls.length, 0);
  assert.equal(fresh.mail.sent.length, 0);
  assert.equal([...fresh.db.optouts].some((value) => value.includes('@')), false);
  assert.deepEqual(findPii(opted.telegram_text, ['anna.schmidt@lead.testdomain.de', 'Anna', 'Schmidt']), []);
  const later = loadMail('E01');
  later.messageId = '<e01.after.stop@immobilienscout24.de>';
  const blocked = await runInbound(later, fresh);
  assert.equal(blocked.outcome, 'OPTOUT');
  assert.equal(fresh.llmCalls.length, 0);
});

test('only an ImmoScout24 sender can open an inquiry, and only the lead can act on the thread', async () => {
  assert.equal(recipientAllowed({
    leadEmail: 'anna.schmidt@lead.testdomain.de',
    proposedTo: 'victim@third-party.example',
    relayDomains: [],
  }), false);
  assert.equal(recipientAllowed({
    leadEmail: 'anna.schmidt@lead.testdomain.de',
    proposedTo: 'anna.schmidt@lead.testdomain.de',
    relayDomains: [],
  }), true);
  const spam = makeDeps({ llmFixture: 'E01' });
  const foreign = loadMail('E01');
  foreign.from = 'spammer@evil.example';
  foreign.messageId = '<spam.1@evil.example>';
  const skipped = await runInbound(foreign, spam);
  assert.equal(skipped.outcome, 'SKIPPED_NOT_IS24');
  assert.equal(spam.llmCalls.length, 0);
  assert.equal(spam.mail.sent.length, 0);

  const untrusted = makeDeps({ llmFixture: 'E02' });
  const loose = loadMail('E02');
  loose.headers = { ...loose.headers, 'reply-to': '' };
  loose.messageId = '<e02.no-reply-to@immobilienscout24.de>';
  const held = await runInbound(loose, untrusted);
  assert.equal(held.outcome, 'NEEDS_HUMAN');
  assert.equal(untrusted.llmCalls.length, 0);
  assert.equal(untrusted.mail.sent.length, 0);

  const deps = makeDeps({ llmFixture: 'E01' });
  const intake = await runInbound(loadMail('E01'), deps);
  const attacker = {
    messageId: '<attacker.stop@evil.example>',
    from: 'attacker@evil.example',
    to: 'makler@lead.testdomain.de',
    subject: `Re: [${intake.lead_id}]`,
    textPlain: 'STOP',
    inReplyTo: intake.message_id,
    date: '2026-10-21T10:06:00.000Z',
    headers: {},
  };
  const mismatch = await runInbound(attacker, deps);
  assert.equal(mismatch.outcome, 'NEEDS_HUMAN');
  assert.equal(mismatch.reply_reason, 'sender_mismatch');
  assert.equal(deps.db.optouts.size, 0);
  attacker.messageId = '<attacker.book@evil.example>';
  attacker.textPlain = 'Nr. 1';
  const booked = await runInbound(attacker, deps);
  assert.equal(booked.outcome, 'NEEDS_HUMAN');
  assert.equal(deps.calendar.events.length, 0);
  assert.equal(deps.mail.sent.length, 1);

  const dkim = makeDeps({
    llmFixture: 'E01',
    config: testConfig({ REQUIRE_DKIM_PASS: 'true' }),
  });
  const unsigned = await runInbound(loadMail('E01'), dkim);
  assert.equal(unsigned.outcome, 'SKIPPED_DKIM');
  assert.equal(dkim.llmCalls.length, 0);
  const signed = loadMail('E01');
  signed.messageId = '<e01.dkim@immobilienscout24.de>';
  signed.headers = { ...signed.headers, 'authentication-results': 'mx.example; dkim=pass header.d=immobilienscout24.de' };
  const passed = await runInbound(signed, dkim);
  assert.equal(passed.outcome, 'SENT');
});

test('a failed send is marked error and can be retried', async () => {
  const { MemoryStore } = require('../core/store');
  const store = new MemoryStore();
  const hash = 'a'.repeat(64);
  assert.equal(await store.claimMessage({ messageIdHash: hash, contentHash: hash }), true);
  assert.equal(await store.claimMessage({ messageIdHash: hash, contentHash: hash }), false);
  assert.equal(await store.failProcessing(hash), true);
  assert.equal(store.messages.get(hash).status, 'error');
  assert.equal(await store.claimMessage({ messageIdHash: hash, contentHash: hash }), true);
  store.messages.get(hash).first_seen_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  store.messages.get(hash).status = 'processing';
  assert.equal(await store.claimMessage({ messageIdHash: hash, contentHash: hash }), true);
  await store.finishMessage({ messageIdHash: hash, outcome: 'SENT', status: 'done' });
  assert.equal(await store.failProcessing(hash), false);
  assert.equal(await store.claimMessage({ messageIdHash: hash, contentHash: hash }), false);
});

function e01Llm(replyParagraphs, extractionPatch, calls) {
  const fixture = require('../fixtures/llm/E01.json');
  return async (request) => {
    if (calls) calls.push(request);
    const name = request.response_format.json_schema.name;
    if (name === 'lead_extraction') {
      return { content: JSON.stringify({ ...fixture.extraction, ...extractionPatch }), model: 'mock', tokens_in: 10, tokens_out: 10 };
    }
    return { content: JSON.stringify({ paragraphs: replyParagraphs }), model: 'mock', tokens_in: 8, tokens_out: 8 };
  };
}

test('a paragraph that contradicts the parking fact falls back to the template', async () => {
  const deps = makeDeps({
    llm: e01Llm([
      'Vielen Dank für Ihr Interesse an der Wohnung.',
      'Der Tiefgaragenstellplatz ist direkt mit der Wohnung verbunden.',
    ]),
  });
  const result = await runInbound(loadMail('E01'), deps);
  assert.equal(result.outcome, 'SENT');
  assert.equal(result.mail.used_fallback, true);
  assert.ok(result.mail.text.includes(STELLPLATZ));
  assert.doesNotMatch(result.mail.text, /verbunden/);
  assert.match(result.mail.text, /Vielen Dank für Ihr Interesse an der Immobilie/);
});

test('a move date in the inquiry is not reported as a missing timeline', async () => {
  const deps = makeDeps();
  deps.llm = e01Llm(
    ['Bitte öffnen Sie https://evil.example/pay'],
    {
      timeline: { target_date: null, horizon: 'unbekannt' },
      missing_fields: ['timeline'],
    },
    deps.llmCalls,
  );
  const result = await runInbound(loadMail('E01'), deps);
  assert.equal(result.lead.timeline.target_date, '2027-02-01');
  assert.equal(result.lead.timeline.horizon, '3_bis_6_monate');
  assert.equal(result.lead.missing_fields.includes('timeline'), false);
  assert.equal(result.questions_to_ask.includes('timeline'), false);
  assert.equal(result.mail.used_fallback, true);
  assert.doesNotMatch(result.mail.text, /Zeitraum/);
  const wrapped = JSON.parse(deps.llmCalls[1].messages[1].content.replace(/^<reply_input>/, '').replace(/<\/reply_input>$/, ''));
  assert.equal(wrapped.questions_to_ask.includes('timeline'), false);
});

test('German replies omit the English invitation unless the flag is on', async () => {
  const withLine = ['Vielen Dank für Ihr Interesse an der Wohnung. Gerne können Sie uns auch auf Englisch antworten.'];
  const german = makeDeps({ llm: e01Llm(withLine) });
  const de = await runInbound(loadMail('E01'), german);
  assert.equal(de.mail.used_fallback, false);
  assert.equal(de.mail.text.includes(ENGLISH_LINE), false);
  assert.match(de.mail.text, /Vielen Dank für Ihr Interesse an der Wohnung/);

  const flagged = makeDeps({
    llm: e01Llm(['Vielen Dank für Ihr Interesse an der Wohnung.']),
    config: testConfig({ OFFER_ENGLISH_REPLY: 'true' }),
  });
  const offered = await runInbound(loadMail('E01'), flagged);
  assert.equal(offered.mail.text.includes(ENGLISH_LINE), true);

  const english = makeDeps({
    llm: e01Llm(
      ['Vielen Dank für Ihr Interesse an der Wohnung.'],
      { language: 'en' },
    ),
  });
  const en = await runInbound(loadMail('E01'), english);
  assert.equal(en.lead.language, 'en');
  assert.equal(en.mail.text.includes(ENGLISH_LINE), true);
});

test('retention uses the configured day count', async () => {
  const deps = makeDeps({
    llmFixture: 'E01',
    config: testConfig({ SEND_MODE: 'auto', RETENTION_DAYS_LEAD: '14' }),
  });
  const result = await runInbound(loadMail('E01'), deps);
  const created = DateTime.fromISO(result.lead_row.created_at, { setZone: true });
  const until = DateTime.fromISO(result.lead_row.retention_until, { setZone: true });
  assert.equal(Math.round(until.diff(created, 'days').days), 14);
});

test('the questionnaire link is only in the first reply', async () => {
  const deps = makeDeps({ llmFixture: 'E01' });
  deps.fragebogen = { async issue() { return { url: 'http://127.0.0.1:18791/f/abc123demo' }; } };
  const intake = await runInbound(loadMail('E01'), deps);
  assert.match(deps.mail.sent[0].text, /Optional: Wenn Sie möchten/);
  assert.match(deps.mail.sent[0].text, /abc123demo/);
  const reply = loadMail('E11');
  reply.messageId = '<e11.link@lead.testdomain.de>';
  reply.from = 'anna.schmidt@lead.testdomain.de';
  reply.inReplyTo = intake.message_id;
  reply.subject = `Re: [${intake.lead_id}]`;
  reply.textPlain = 'Nr. 2';
  await runInbound(reply, deps);
  assert.equal(deps.mail.sent.length, 2);
  assert.doesNotMatch(deps.mail.sent[1].text, /Optional: Wenn Sie möchten/);
  assert.ok(deps.mail.sent[1].text.includes(STOP_LINE));
});
