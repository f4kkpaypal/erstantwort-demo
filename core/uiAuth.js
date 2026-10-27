'use strict';

const crypto = require('crypto');

function verifyInitData(initData, botToken, options = {}) {
  const maxAgeS = Number.isFinite(options.maxAgeS) ? options.maxAgeS : 3600;
  const now = options.now instanceof Date ? options.now : new Date();
  if (!initData || !botToken) return { ok: false, error: 'missing' };
  const params = new URLSearchParams(String(initData));
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]+$/i.test(hash)) return { ok: false, error: 'bad_hash' };
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheck = pairs.map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(String(hash).toLowerCase(), 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, error: 'bad_hash' };
  }
  const authDate = Number(params.get('auth_date'));
  const nowS = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(authDate) || nowS - authDate > maxAgeS || authDate > nowS + 30) {
    return { ok: false, error: 'expired' };
  }
  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    user = null;
  }
  if (!user || user.id == null) return { ok: false, error: 'no_user' };
  return { ok: true, user: { id: String(user.id), username: user.username || '' } };
}

function allowedTelegramIds(config) {
  const ids = new Set();
  const profileId = String(config?.MAKLER_PROFILE?.telegram_user_id || '').trim();
  if (profileId) ids.add(profileId);
  for (const id of config?.TELEGRAM_ALLOWED_USER_IDS || []) ids.add(String(id));
  return ids;
}

function signInitData(fields, botToken) {
  const pairs = Object.entries(fields).map(([key, value]) => [key, String(value)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheck = pairs.map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const params = new URLSearchParams();
  for (const [key, value] of pairs) params.append(key, value);
  params.append('hash', hash);
  return params.toString();
}

module.exports = {
  verifyInitData,
  allowedTelegramIds,
  signInitData,
};
