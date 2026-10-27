'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyInitData, signInitData, allowedTelegramIds } = require('../core/uiAuth');

const TOKEN = '123456:bot-token';
const NOW = new Date('2026-10-21T10:00:00.000Z');

function signed(userId, authDate) {
  return signInitData({
    auth_date: String(authDate),
    query_id: 'AAE',
    user: JSON.stringify({ id: userId, first_name: 'Maria', username: 'makler' }),
  }, TOKEN);
}

test('valid initData matches the bot token and a fresh auth_date', () => {
  const initData = signed(4242, Math.floor(NOW.getTime() / 1000));
  const result = verifyInitData(initData, TOKEN, { maxAgeS: 3600, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.user.id, '4242');
});

test('a forged hash, an expired session and a missing token are rejected', () => {
  const initData = signed(4242, Math.floor(NOW.getTime() / 1000));
  const forged = initData.replace(/hash=[a-f0-9]+/, 'hash=deadbeef');
  assert.equal(verifyInitData(forged, TOKEN, { now: NOW }).error, 'bad_hash');
  const old = signed(4242, Math.floor(NOW.getTime() / 1000) - 7200);
  assert.equal(verifyInitData(old, TOKEN, { maxAgeS: 3600, now: NOW }).error, 'expired');
  assert.equal(verifyInitData('', TOKEN).error, 'missing');
  assert.equal(verifyInitData(initData, '').error, 'missing');
});

test('the allowlist is the profile id plus TELEGRAM_ALLOWED_USER_IDS', () => {
  const ids = allowedTelegramIds({
    MAKLER_PROFILE: { telegram_user_id: '7' },
    TELEGRAM_ALLOWED_USER_IDS: ['8', '9'],
  });
  assert.equal(ids.has('7'), true);
  assert.equal(ids.has('8'), true);
  assert.equal(ids.has('1'), false);
});
