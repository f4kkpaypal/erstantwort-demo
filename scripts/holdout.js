'use strict';

const fs = require('fs');
const path = require('path');
const { analyze } = require('../core/intl/analyze');
const { scoreChat } = require('../core/intl/score');
const { buildOptions } = require('../core/intl/options');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('holdout_missing');
  console.error('Pass a path: npm run holdout -- /path/to/Intl_MVP_holdout.json');
  console.error('Format: docs/HOLDOUT_FORMAT.md');
  process.exit(2);
}

const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
const messages = pack.messages || [];
const properties = { ...fixtures.meta.properties, ...(pack.meta?.properties || {}), ...(pack.properties || {}) };

function propertyOf(id) {
  const row = properties[id] || { kind: 'rent', price: 120000, cur: 'AED', period: 'year', currency: 'AED', price_period: 'year' };
  return {
    ...row,
    kind: row.kind,
    price: row.price,
    currency: row.currency || row.cur,
    price_period: row.price_period || row.period,
    ref_en: row.ref_en || row.title || 'the property',
    ref_ru: row.ref_ru || row.title || 'объекту',
    price_en: row.price_en || '',
    price_ru: row.price_ru || '',
    tz: row.tz || 'Asia/Dubai',
    tz_label_en: row.tz_label_en || 'Dubai time',
    tz_label_ru: row.tz_label_ru || 'время Дубая',
  };
}

let intent = 0;
let language = 0;
let grade = 0;
let intentDue = 0;
let languageDue = 0;
let gradeDue = 0;
let falseStop = 0;
let missedStop = 0;
let optionViolations = 0;
for (const message of messages) {
  const property = propertyOf(message.property_id);
  const analysis = analyze(
    { kind: message.kind || 'text', text: message.text, non_text_type: message.non_text_type },
    { propertyKind: property.kind, propertyCurrency: property.currency, senderName: message.sender_name },
  );
  const scored = scoreChat(analysis, property, 3.6725);
  const expected = message.expected || {};
  if (expected.intent != null) {
    intentDue += 1;
    if (analysis.intent === expected.intent) intent += 1;
  }
  if (expected.language != null) {
    languageDue += 1;
    if (analysis.language === expected.language) language += 1;
  }
  if (expected.grade != null) {
    gradeDue += 1;
    if (scored.grade === expected.grade) grade += 1;
  }
  if (analysis.intent === 'stop' && expected.intent !== 'stop') falseStop += 1;
  if (expected.intent === 'stop' && analysis.intent !== 'stop') missedStop += 1;
  const options = buildOptions({ analysis, clean_name: analysis.name?.name || '' }, property, []);
  if ((expected.intent === 'stop' || expected.intent === 'unclear') && options.length !== 0) optionViolations += 1;
}
const pass = falseStop === 0 && missedStop === 0 && optionViolations === 0
  && intent === intentDue && language === languageDue && grade === gradeDue;
console.log(JSON.stringify({
  intent, language, grade, intentDue, languageDue, gradeDue, falseStop, missedStop, optionViolations, total: messages.length, pass,
}));
process.exit(pass ? 0 : 1);
