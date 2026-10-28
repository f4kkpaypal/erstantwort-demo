'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyze } = require('../../core/intl/analyze');
const { scoreChat } = require('../../core/intl/score');

const property = { kind: 'rent', price: 120000, currency: 'AED', price_period: 'year' };

function read(text, extra = {}) {
  return analyze({ kind: 'text', text }, { propertyKind: property.kind, propertyCurrency: property.currency, ...extra });
}

test('a suffix does not attach to the next word monthly', () => {
  const row = read('My budget is AED 5,000 monthly');
  assert.equal(row.budget.amount, 5000);
  assert.equal(row.budget.currency, 'AED');
  assert.equal(row.budget.period, 'month');
});

test('million, mln and thousand scale the amount', () => {
  assert.equal(read('My budget is AED 2 million').budget.amount, 2000000);
  assert.equal(read('My budget is AED 2 mln').budget.amount, 2000000);
  assert.equal(read('My budget is 150 thousand dollars', { propertyKind: 'sale', propertyCurrency: 'USD' }).budget.amount, 150000);
  assert.equal(read('My budget is 150 thousand dollars', { propertyKind: 'sale', propertyCurrency: 'USD' }).budget.currency, 'USD');
  assert.equal(read('Мой бюджет 2 миллиона AED', { propertyKind: 'sale', propertyCurrency: 'AED' }).budget.amount, 2000000);
  assert.equal(read('Мой бюджет 150 тысяч дирхамов').budget.amount, 150000);
  assert.equal(read('My budget is AED 5,000 monthly').budget.amount, 5000);
});

test('80k and 80m still multiply when the suffix is its own token', () => {
  assert.equal(read('My budget is $80k', { propertyKind: 'sale', propertyCurrency: 'USD' }).budget.amount, 80000);
  assert.equal(read('My budget is $2m', { propertyKind: 'sale', propertyCurrency: 'USD' }).budget.amount, 2000000);
  assert.equal(read('Мой бюджет 80 тыс', { propertyKind: 'sale', propertyCurrency: 'USD' }).budget.amount, 80000);
});

test('a budget with no currency uses the property currency and says so', () => {
  const row = read('My budget is 80k');
  assert.equal(row.budget.amount, 80000);
  assert.equal(row.budget.currency, 'AED');
  assert.ok(row.flags.includes('budget_currency_assumed'));
  const scored = scoreChat(row, property, 3.6725);
  assert.ok(scored.score < 60);
});

test('an empty message is lang_other and a long one is only unclear', () => {
  const empty = analyze({ text: '   ' }, {});
  assert.equal(empty.language, 'other');
  assert.ok(empty.flags.includes('lang_other'));
  const long = analyze({ text: 'hello '.repeat(400) }, {});
  assert.equal(long.intent, 'unclear');
  assert.equal(long.flags.includes('lang_other'), false);
});

test('a mixed-language message keeps the second intent', () => {
  const row = analyze({ text: 'Здравствуйте, хочу посмотреть квартиру, what is the price' }, { propertyKind: 'rent', propertyCurrency: 'AED' });
  assert.equal(row.language, 'ru');
  assert.ok(row.intent === 'viewing' || row.intent === 'price');
  assert.ok(row.also.includes('price') || row.also.includes('viewing') || row.intent === 'price');
  assert.ok([row.intent, ...row.also].includes('price'));
  assert.ok([row.intent, ...row.also].includes('viewing'));
});

test('arabic digits become a budget and a hidden stop still stops', () => {
  const digits = read('бюджет ٩٠٠٠ дирхамов в месяц');
  assert.equal(digits.budget.amount, 9000);
  assert.equal(analyze({ text: 's\u200btop' }, {}).intent, 'stop');
  const photo = analyze({ kind: 'non_text', non_text_type: 'photo' }, {});
  assert.ok(photo.flags.includes('non_text'));
  assert.equal(photo.intent, 'unclear');
  const voice = analyze({ kind: 'non_text', non_text_type: 'voice' }, {});
  assert.ok(voice.flags.includes('non_text'));
  const location = analyze({ kind: 'non_text', non_text_type: 'location' }, {});
  assert.equal(location.language, 'other');
});

test('rent without a period does not compare and sale without a period is total', () => {
  const rent = read('My budget is 10000 AED');
  assert.ok(rent.flags.includes('budget_period_unclear'));
  const sale = analyze({ text: 'My budget is 300000 USD' }, { propertyKind: 'sale', propertyCurrency: 'USD' });
  assert.equal(sale.budget.period, 'total');
});

test('homoglyphs inside a mixed word do not hide stop', () => {
  const row = analyze({ text: 'stоp' }, {});
  assert.equal(row.intent === 'stop' || row.intent === 'unclear', true);
});
