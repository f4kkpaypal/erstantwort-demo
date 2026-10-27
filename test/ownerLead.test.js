'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runInbound } = require('../core/pipeline');
const { scoreLead } = require('../core/score');
const { parseOwnerMail } = require('../core/ownerLead');
const { parsePortalPayload } = require('../core/portals');
const { AI_FIRST_LINE, STOP_LINE, paragraphsOk } = require('../core/template');
const { loadConfig } = require('../core/config');
const { formSchema, applyFragebogen } = require('../core/fragebogen');
const { makeDeps, testConfig } = require('../support/helpers');
const { buildServer } = require('../engine/server');

const DOMAINS = 'immowelt:owner-immowelt.example,heimziel:owner-heimziel.example,generic:owner-lead.example';

function readOwner(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'owner', name), 'utf8');
}

function ownerConfig() {
  return testConfig({
    OWNER_LEAD_SENDER_DOMAINS: DOMAINS,
    OWNER_LEADS_ENABLED: 'true',
    FRAGEBOGEN_ENABLED: 'false',
  });
}

test('owner-lead domains come from config and the assumed format is explicit', () => {
  assert.equal(loadConfig({}).OWNER_LEADS_ENABLED, false);
  assert.equal(loadConfig({ OWNER_LEAD_SENDER_DOMAINS: DOMAINS }).OWNER_LEADS_ENABLED, false);
  assert.deepEqual(loadConfig({}).OWNER_LEAD_SOURCES, []);
  const sources = loadConfig({ OWNER_LEAD_SENDER_DOMAINS: DOMAINS }).OWNER_LEAD_SOURCES;
  assert.deepEqual(sources.map((row) => row.domain), [
    'owner-immowelt.example',
    'owner-heimziel.example',
    'owner-lead.example',
  ]);
  const parsed = parseOwnerMail({ source: 'immowelt', text: readOwner('immowelt-assumed.txt') });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.assumption, true);
  assert.equal(parsed.fields.object_type, 'wohnung');
  assert.equal(parsed.fields.area_sqm, 85);
  const heimziel = parseOwnerMail({ source: 'heimziel', text: readOwner('heimziel-assumed.txt') });
  assert.equal(heimziel.ok, true);
  assert.equal(heimziel.fields.object_type, 'haus');
  const generic = parseOwnerMail({ source: 'generic', text: readOwner('generic-assumed.txt') });
  assert.equal(generic.fields.timeline_horizon, 'ueber_6_monate');
  assert.equal(generic.fields.area_sqm, null);
  const missed = parseOwnerMail({ source: 'immowelt', text: readOwner('unrecognized.txt') });
  assert.equal(missed.ok, false);
  assert.equal(missed.code, 'OWNER_LEAD_UNRECOGNIZED');
  assert.match(missed.message, /keine echte Portal-Vorlage/);
  assert.equal(parsePortalPayload({
    xml: '<openimmo_feedback><sender><name>Immowelt</name><regi_id>immowelt</regi_id></sender></openimmo_feedback>',
  }).code, 'NOT_IMPLEMENTED');
});

test('an owner lead is scored on sale urgency and books Bewertungstermin Nr. 2', async () => {
  const deps = makeDeps({ config: ownerConfig() });
  const text = readOwner('immowelt-assumed.txt');
  const first = await runInbound({
    messageId: '<owner-1@owner-immowelt.example>',
    from: 'notify@owner-immowelt.example',
    replyTo: 'klara.hoffmann@lead.testdomain.de',
    subject: 'Verkaufsanfrage',
    textPlain: text,
    headers: {},
  }, deps);
  assert.equal(first.outcome, 'SENT');
  assert.equal(first.grade, 'HOT');
  assert.equal(first.score, 85);
  assert.equal(first.lead.lead_kind, 'eigentuemer');
  assert.equal(deps.mail.sent.length, 1);
  const mail = deps.mail.sent[0].text;
  assert.equal(mail.split('\n')[0], AI_FIRST_LINE);
  assert.match(mail, /Vor-Ort-Bewertung/);
  assert.ok(mail.includes(STOP_LINE));
  assert.equal((mail.match(/^\s+[123]\)/gm) || []).length, 3);
  assert.equal(paragraphsOk(['vielen Dank für Ihre Nachricht. Gern schauen wir uns Ihre Immobilie vor Ort an und besprechen einen möglichen Verkauf.']), true);
  assert.equal(deps.telegram.messages.some((row) => row.includes('@') || row.includes('Klara') || row.includes('1000001')), false);
  assert.match(deps.telegram.messages.join('\n'), /Eigentümer-Lead/);
  const reply = await runInbound({
    messageId: '<owner-reply@lead.testdomain.de>',
    from: 'klara.hoffmann@lead.testdomain.de',
    subject: `Re: Verkauf [${first.lead_id}]`,
    textPlain: 'Nr. 2',
    headers: {},
  }, deps);
  assert.equal(reply.outcome, 'TERMIN');
  assert.match(deps.mail.sent[1].text, /Bewertungstermin vor Ort/);
  assert.ok(deps.mail.sent[1].text.includes(STOP_LINE));
  assert.equal(deps.calendar.events[0].title, `Bewertung ${first.lead_id}`);
  assert.equal(deps.calendar.events[0].title.includes('Klara'), false);
  assert.equal(deps.telegram.messages.at(-1).includes('@'), false);
  const quiet = scoreLead({
    lead_kind: 'eigentuemer',
    object_type: 'grundstueck',
    city: 'Nürnberg',
    district: 'Erlenstegen',
    timeline_horizon: 'ueber_6_monate',
    valuation_requested: false,
    phone: '',
  });
  assert.equal(quiet.score, 25);
  assert.equal(quiet.grade, 'COLD');
  assert.equal(quiet.reasons.includes('Einkommen ≥ 3× Kaltmiete'), false);
});

test('an unrecognized owner mail is logged and does not invent a lead', async () => {
  const deps = makeDeps({ config: ownerConfig() });
  const result = await runInbound({
    messageId: '<owner-unknown@owner-immowelt.example>',
    from: 'notify@owner-immowelt.example',
    replyTo: 'klara.hoffmann@lead.testdomain.de',
    subject: 'Lead',
    textPlain: readOwner('unrecognized.txt'),
    headers: {},
  }, deps);
  assert.equal(result.outcome, 'NEEDS_HUMAN');
  assert.equal(deps.mail.sent.length, 0);
  assert.equal(result.lead, undefined);
  const logged = deps.logs.find((row) => row.event_code === 'OWNER_LEAD_UNRECOGNIZED');
  assert.ok(logged);
  assert.match(logged.meta.message, /immowelt/);
  assert.match(logged.meta.message, /keine echte Portal-Vorlage/);
  assert.equal(JSON.stringify(logged).includes('klara.hoffmann'), false);
  assert.match(result.telegram_text, /nicht erkannt/);
  assert.equal(result.telegram_text.includes('@'), false);
  const foreign = await runInbound({
    messageId: '<not-configured@owner-immowelt.example>',
    from: 'notify@owner-immowelt.example',
    replyTo: 'klara.hoffmann@lead.testdomain.de',
    subject: 'Lead',
    textPlain: readOwner('immowelt-assumed.txt'),
    headers: {},
  }, makeDeps({ config: testConfig() }));
  assert.equal(foreign.outcome, 'SKIPPED_NOT_IS24');
});

test('the owner questionnaire skips sensitive questions and the demo list can filter it', async () => {
  const config = testConfig({
    DEMO_UI_NO_AUTH: 'true',
    UI_PUBLIC_BASE: 'http://127.0.0.1:18791',
  });
  const deps = makeDeps({ config });
  deps.clock = () => new Date('2026-10-21T10:00:00.000Z');
  const server = buildServer(deps);
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const owners = await fetch(`http://127.0.0.1:${port}/v1/ui/leads?chip=eigentuemer`).then((res) => res.json());
    assert.equal(owners.leads.length, 4);
    assert.equal(owners.leads.every((lead) => lead.lead_kind === 'eigentuemer'), true);
    const week = await fetch(`http://127.0.0.1:${port}/v1/ui/bookings?week=2026-W43`).then((res) => res.json());
    const items = week.days.flatMap((day) => day.items);
    const valuation = items.find((item) => item.kind_label === 'Bewertungstermin');
    assert.ok(valuation);
    assert.equal(valuation.title, 'Haus in St. Johannis');
    assert.equal(valuation.status, 'gebucht');
    assert.doesNotMatch(JSON.stringify(week), /Besichtigung 9000|SLOT_RULES/);
    const klara = await fetch(`http://127.0.0.1:${port}/v1/ui/leads/L-20261021-0201`).then((res) => res.json());
    assert.match(klara.lead.draft_text, /Vor-Ort-Bewertung/);
    assert.match(klara.lead.draft_text, /STOP/);
    assert.equal(klara.lead.urgency_label, 'Verkauf in den nächsten 3 Monaten');
    assert.equal(klara.objekt_missing, false);
    assert.match(klara.lead.source_label, /Immowelt/);
    assert.match(klara.lead.source_label, /angenommenes Format/);
    const otto = await fetch(`http://127.0.0.1:${port}/v1/ui/leads/L-20261021-0204`).then((res) => res.json());
    assert.deepEqual(otto.lead.missing_labels, ['Verkaufszeitraum', 'Fläche']);
    assert.equal(otto.lead.missing_labels.includes('budget'), false);
    const form = await fetch(`http://127.0.0.1:${port}/f/demo-klara-token-0001`, {
      headers: { Accept: 'application/json' },
    }).then((res) => res.json());
    const names = form.steps.flatMap((step) => step.fields.map((field) => field.name));
    assert.equal(names.includes('income_band'), false);
    assert.equal(names.includes('schufa'), false);
    assert.equal(names.includes('persons'), false);
    assert.equal(names.includes('budget_eur'), false);
    assert.ok(names.includes('object_place'));
    assert.doesNotMatch(form.datenschutz, /Einkommen/);
    const sent = await fetch(`http://127.0.0.1:${port}/f/demo-klara-token-0001`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        ansprache: 'Klara',
        object_place: 'Gostenhof',
        object_type: 'wohnung',
        area_sqm: 85,
        timeline: 'bis_3_monate',
        preferred_days: 'Donnerstag',
        phone: '+49 911 1000001',
        income_band: 'hoch',
        persons: '4',
        schufa: 'ja',
        datenschutz_gelesen: true,
      }),
    }).then((res) => res.json());
    assert.equal(sent.ok, true);
    assert.equal(sent.grade, 'HOT');
    const again = await fetch(`http://127.0.0.1:${port}/v1/ui/leads/L-20261021-0201`).then((res) => res.json());
    assert.equal(again.lead.persons_count, undefined);
    assert.equal(again.lead.income_min_eur, undefined);
    assert.equal(again.lead.schufa_available, undefined);
    const schema = formSchema({
      lead: { lead_kind: 'eigentuemer', listing_title: 'Wohnung in Gostenhof' },
      makler: { name: 'Maria K.', buero: 'Erstantwort Demo', adresse: 'Nürnberg' },
      config: { FRAGEBOGEN_INCOME_ENABLED: true },
    });
    assert.equal(schema.steps[0].fields.some((field) => field.name === 'income_band'), false);
    const rescored = applyFragebogen({
      lead: {
        lead_kind: 'eigentuemer',
        object_type: 'wohnung',
        object_city: 'Nürnberg',
        timeline_horizon: 'unbekannt',
        valuation_requested: false,
        phone: '',
        missing_fields: ['timeline', 'budget'],
      },
      answers: { timeline: 'bis_3_monate', preferred_days: 'Freitag', object_type: 'wohnung' },
      config: {},
    });
    assert.equal(rescored.lead.missing_fields.includes('budget'), false);
    assert.equal(rescored.lead.valuation_requested, true);
    assert.equal(rescored.answers.income_band, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('owner mail is ignored while the flag is off, even if domains are configured', async () => {
  const deps = makeDeps({ config: testConfig({ OWNER_LEAD_SENDER_DOMAINS: DOMAINS }) });
  const result = await runInbound({
    messageId: '<owner-off@owner-immowelt.example>',
    from: 'notify@owner-immowelt.example',
    replyTo: 'klara.hoffmann@lead.testdomain.de',
    subject: 'Verkaufsanfrage',
    textPlain: readOwner('immowelt-assumed.txt'),
    headers: {},
  }, deps);
  assert.equal(result.outcome, 'SKIPPED_NOT_IS24');
  assert.equal(deps.mail.sent.length, 0);
});
