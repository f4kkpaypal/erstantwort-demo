'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyze } = require('../../core/intl/analyze');
const { scoreChat } = require('../../core/intl/score');

const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));

for (const message of PACK.messages) {
  test(`${message.id} matches the published intent, language and grade`, () => {
    const raw = PACK.meta.properties[message.property_id];
    const property = { ...raw, currency: raw.cur, price_period: raw.period };
    const analysis = analyze({ text: message.text }, { propertyKind: property.kind, propertyCurrency: property.currency, senderName: message.sender_name });
    const scored = scoreChat(analysis, property, 3.6725);
    assert.equal(analysis.intent, message.expected.intent);
    assert.equal(analysis.language, message.expected.language);
    assert.equal(scored.grade, message.expected.grade);
    assert.equal(scored.score, message.expected.score);
  });
}
