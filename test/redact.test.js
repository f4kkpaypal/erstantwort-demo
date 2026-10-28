'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactString, redactMeta } = require('../core/redact');

test('ImmoScout object ids are not redacted as phone numbers', () => {
  assert.equal(redactString('63843270'), '63843270');
  assert.equal(redactString('Objekt 63843270'), 'Objekt 63843270');
  assert.equal(redactString('81220011 und 70011224'), '81220011 und 70011224');
  const mixed = redactString('Rückruf +49 30 0000001 zum Objekt 63843270', [], ['63843270']);
  assert.equal(mixed.includes('63843270'), true);
  assert.equal(mixed.includes('[redacted-phone]'), true);
  assert.equal(mixed.includes('0000001'), false);
  assert.equal(redactString('030 12345678').includes('[redacted-phone]'), true);
  const meta = redactMeta({ listing_id: '63843270', outcome: 'SENT' });
  assert.equal(meta.listing_id, '63843270');
});
