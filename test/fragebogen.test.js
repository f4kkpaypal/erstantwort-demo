'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { applyFragebogen, formSchema, summarizeAnswers, formatSummaryLine } = require('../core/fragebogen');
const { presentLead } = require('../core/uiModel');

const objekt = {
  title: 'Zwei Zimmer in St. Johannis',
  kaltmiete_eur: 1090,
  warmmiete_eur: 1290,
  price_eur: null,
};
const makler = { name: 'Maria K.', buero: 'Berger Immobilien', adresse: 'Nürnberg', datenschutz_url: 'https://berger.test/datenschutz' };

function coldLead() {
  return {
    lead_id: 'L-20261021-0102',
    inquiry_type: 'miete',
    listing_title: objekt.title,
    budget_max_eur: null,
    financing_status: 'unbekannt',
    timeline_horizon: 'unbekannt',
    viewing_requested: true,
    phone: '+49 911 0000002',
    questions: [],
    missing_fields: ['budget', 'timeline'],
    injection_suspected: false,
    first_name: 'Lena',
    last_name: 'Krüger',
  };
}

test('step 1 asks for the name and the move-in date, not income or household size', () => {
  const schema = formSchema({
    lead: coldLead(),
    objekt,
    makler,
    config: { FRAGEBOGEN_INCOME_ENABLED: false, FRAGEBOGEN_PERSONS_ENABLED: false, RETENTION_DAYS_LEAD: 180 },
  });
  const labels = schema.steps[0].fields.map((field) => field.label);
  assert.ok(labels.includes('Wie dürfen wir Sie ansprechen?'));
  assert.ok(labels.includes('Ab wann möchten Sie einziehen?'));
  assert.equal(labels.includes('Ihr Budget pro Monat (warm), €'), false);
  const names = schema.steps.flatMap((step) => step.fields.map((field) => field.name));
  assert.equal(names.includes('budget_eur'), false);
  assert.equal(names.includes('income_band'), false);
  assert.equal(names.includes('persons'), false);
  assert.equal(names.includes('pets'), false);
  assert.equal(names.includes('schufa'), false);
  assert.equal(names.includes('employment'), false);
  assert.match(schema.datenschutz, /freiwillig/);
  assert.doesNotMatch(schema.datenschutz, /Einwilligung/);
  assert.doesNotMatch(schema.datenschutz, /Einkommen/);
});

test('a voluntary questionnaire rescores a cold lead to HOT 70 without storing income or household', () => {
  const result = applyFragebogen({
    lead: coldLead(),
    objekt,
    config: { FRAGEBOGEN_BUDGET_ENABLED: true, FRAGEBOGEN_INCOME_ENABLED: true, FRAGEBOGEN_PERSONS_ENABLED: true, FRAGEBOGEN_SCHUFA_ENABLED: false },
    answers: {
      ansprache: 'Lena',
      timeline: 'bis_3_monate',
      budget_eur: 1300,
      intent: 'anmieten',
      income_band: 'hoch',
      persons: '3',
      pets: 'ja',
      schufa: 'ja',
      employment: 'rente',
    },
  });
  assert.equal(result.before.score, 15);
  assert.equal(result.before.grade, 'COLD');
  assert.equal(result.after.score, 70);
  assert.equal(result.after.grade, 'HOT');
  assert.deepEqual(result.after.reasons, ['Einkommen ≥ 3× Kaltmiete', 'Zeitrahmen ≤ 3 Monate', 'Budget passt']);
  assert.equal(result.lead.persons_count, undefined);
  assert.equal(result.lead.pets, undefined);
  assert.equal(result.lead.income_min_eur, undefined);
  assert.equal(result.lead.schufa_available, undefined);
  assert.equal(result.lead.employment_type, undefined);
  assert.equal(result.answers.persons, undefined);
  assert.equal(result.answers.pets, undefined);
  assert.equal(result.answers.income_band, 'hoch');
  assert.equal(result.answers.schufa, undefined);
});

test('portal budget is kept when the questionnaire disagrees', () => {
  const lead = coldLead();
  lead.budget_max_eur = 1100;
  const result = applyFragebogen({
    lead,
    objekt,
    config: { FRAGEBOGEN_BUDGET_ENABLED: true },
    answers: { budget_eur: 1300, timeline: 'bis_3_monate', intent: 'besichtigen' },
  });
  assert.equal(result.lead.budget_max_eur, 1100);
  assert.match(result.abweichungen[0], /1\.?100|1100/);
  assert.equal(result.after.reasons.includes('Budget passt'), false);
});

test('a rental budget answer is ignored while the question is off', () => {
  const result = applyFragebogen({
    lead: coldLead(),
    objekt,
    config: {},
    answers: { budget_eur: 1300, timeline: 'bis_3_monate', intent: 'besichtigen' },
  });
  assert.equal(result.lead.budget_max_eur, null);
  assert.equal(result.answers.budget_eur, undefined);
  assert.equal(result.after.reasons.includes('Budget passt'), false);
  assert.equal(result.lead.missing_fields.includes('budget'), false);
});

test('disabled budget is not a missing field and the summary does not add a second question mark', () => {
  const kept = applyFragebogen({
    lead: coldLead(),
    objekt,
    config: { FRAGEBOGEN_BUDGET_ENABLED: true },
    answers: { timeline: 'bis_3_monate' },
  });
  assert.equal(kept.lead.missing_fields.includes('budget'), true);
  const shown = presentLead({
    lead_id: 'L-1',
    first_name: 'Lena',
    last_name: 'Krüger',
    inquiry_type: 'miete',
    listing_title: 'Wohnung',
    missing_fields: ['budget', 'timeline', 'phone'],
    phone: '',
    reasons: [],
    reply_status: 'pending_approval',
  }, { detail: true, config: {} });
  assert.deepEqual(shown.missing_fields, ['timeline', 'phone']);
  assert.deepEqual(shown.missing_labels, ['Einzugstermin', 'Telefon']);
  assert.equal(shown.missing_labels.includes('budget'), false);
  const line = formatSummaryLine('Ab wann möchten Sie einziehen?', 'In den nächsten 3 Monaten');
  assert.equal(line, 'Ab wann möchten Sie einziehen? — In den nächsten 3 Monaten');
  assert.doesNotMatch(line, /\?:/);
  const client = fs.readFileSync(path.join(__dirname, '..', 'ui', 'fragebogen.js'), 'utf8');
  assert.match(client, /function formatSummaryLine/);
  assert.doesNotMatch(client, /\$\{field\.label\}:/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  assert.match(app, /missing_labels/);
  assert.doesNotMatch(app, /missing_fields\.join/);
});

test('the privacy text uses the broker profile and skips the income sentence', () => {
  const schema = formSchema({
    lead: coldLead(),
    objekt,
    makler: {
      name: 'Maria K.',
      buero: 'Erstantwort Demo',
      adresse: 'Johannisstraße 1, 90419 Nürnberg',
      datenschutz_url: 'https://REPLACE_ME/datenschutz',
    },
    config: { UI_PUBLIC_BASE: 'http://127.0.0.1:18791', RETENTION_DAYS_LEAD: 180 },
  });
  assert.match(schema.datenschutz, /90419 Nürnberg/);
  assert.match(schema.datenschutz, /http:\/\/127\.0\.0\.1:18791\/datenschutz/);
  assert.doesNotMatch(schema.datenschutz, /REPLACE_ME/);
  assert.doesNotMatch(schema.datenschutz, /Berlin/);
  assert.doesNotMatch(schema.datenschutz, /Einkommen/);
  const lines = summarizeAnswers(schema, { timeline: 'bis_3_monate', intent: 'besichtigen', ansprache: 'Lena' });
  assert.deepEqual(lines.map((line) => formatSummaryLine(line.label, line.value)), [
    'Wie dürfen wir Sie ansprechen? — Lena',
    'Ab wann möchten Sie einziehen? — In den nächsten 3 Monaten',
    'Wie möchten Sie weitermachen? — Ich möchte die Wohnung zuerst besichtigen.',
  ]);
});
