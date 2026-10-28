'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreLead } = require('../core/score');

test('E01 signals sum to 75 HOT', () => {
  const result = scoreLead({
    inquiry_type: 'kauf',
    financing_status: 'finanzierungszusage',
    budget_max_eur: null,
    price_eur: 450000,
    equity_eur: 100000,
    timeline_horizon: '3_bis_6_monate',
    viewing_requested: true,
    phone: '+49 30 0000001',
    questions: ['stellplatz'],
    missing_fields: [],
    injection_suspected: false,
    schufa_available: 'nein',
  });
  assert.deepEqual(
    result.signals.filter((row) => row.points !== 0).map((row) => [row.code, row.points]),
    [
      ['financing', 30],
      ['equity', 15],
      ['timeline', 10],
      ['viewing', 10],
      ['phone', 5],
      ['question', 5],
    ],
  );
  assert.equal(result.score, 75);
  assert.equal(result.grade, 'HOT');
  assert.deepEqual(result.reasons, [
    'Finanzierung bestätigt',
    'Eigenkapital ≥ 20 %',
    'Besichtigungswunsch',
  ]);
  assert.equal(result.equity_ratio_band, '≥20 %');
  assert.deepEqual(result.questions_to_ask, []);
});

test('E02 is 15 COLD and asks for budget and timeline', () => {
  const result = scoreLead({
    inquiry_type: 'miete',
    financing_status: 'unbekannt',
    budget_max_eur: null,
    warmmiete_eur: 1180,
    kaltmiete_eur: 980,
    timeline_horizon: 'unbekannt',
    viewing_requested: true,
    phone: '',
    questions: ['verfuegbarkeit'],
    missing_fields: ['budget', 'timeline', 'financing'],
    schufa_available: 'unbekannt',
  });
  assert.equal(result.score, 15);
  assert.equal(result.grade, 'COLD');
  assert.deepEqual(result.reasons, ['Besichtigungswunsch']);
  assert.deepEqual(result.questions_to_ask, ['budget', 'financing', 'timeline']);
});

test('injection caps HOT at WARM and keeps the warning', () => {
  const result = scoreLead({
    inquiry_type: 'kauf',
    financing_status: 'barzahler',
    price_eur: 450000,
    equity_eur: 200000,
    budget_max_eur: 450000,
    timeline_horizon: 'bis_3_monate',
    viewing_requested: true,
    phone: '+49 30 0000001',
    questions: ['stellplatz'],
    injection_suspected: true,
  });
  assert.ok(result.score >= 60);
  assert.equal(result.grade, 'WARM');
  assert.equal(result.reasons[0], '⚠ Prompt-Injection-Verdacht');
  assert.ok(result.reasons.length <= 3);
});

test('schufa and name-like fields do not affect a purchase score', () => {
  const base = {
    inquiry_type: 'kauf',
    financing_status: 'nicht_geklaert',
    timeline_horizon: 'unbekannt',
    viewing_requested: false,
    phone: '',
    questions: [],
  };
  const a = scoreLead({ ...base, schufa_available: 'ja' });
  const b = scoreLead({ ...base, schufa_available: 'nein' });
  assert.equal(a.score, b.score);
  assert.equal(a.score, -10);
  assert.equal(a.grade, 'COLD');
});

test('rental income flag is not a stored income amount', () => {
  const result = scoreLead({
    inquiry_type: 'miete',
    income_min_eur: 3000,
    kaltmiete_eur: 900,
    warmmiete_eur: 1100,
    budget_max_eur: 1100,
    schufa_available: 'ja',
    timeline_horizon: 'bis_3_monate',
    viewing_requested: false,
    phone: '',
    questions: [],
  });
  assert.equal(result.income_ok_flag, true);
  assert.ok(result.score >= 25);
  assert.equal(result.signals.find((row) => row.code === 'income').reason, 'Einkommen ≥ 3× Kaltmiete');
});
