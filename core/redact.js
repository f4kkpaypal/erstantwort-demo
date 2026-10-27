'use strict';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+|00)?\d[\d\s()./-]{6,}\d/g;

function isBareScoutId(token) {
  const digits = String(token || '').replace(/\D/g, '');
  return digits === String(token || '') && /^[1-9]\d{4,11}$/.test(digits);
}

function knownIds(keepIds) {
  const ids = [];
  for (const raw of keepIds || []) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length >= 5 && digits.length <= 12) ids.push(digits);
  }
  return [...new Set(ids)].sort((a, b) => b.length - a.length);
}

const META_KEYS = new Set([
  'outcome',
  'grade',
  'score',
  'listing_id',
  'slot_index',
  'route',
  'send_reason',
  'action',
  'event_code',
  'kind',
  'duplicate',
  'slot_count',
  'http_status',
  'model',
  'tokens_in',
  'tokens_out',
  'message',
  'source',
]);

function redactString(value, names = [], keepIds = []) {
  let s = String(value);
  const saved = [];
  for (const id of knownIds(keepIds)) {
    s = s.replace(new RegExp(`(?<!\\d)${id}(?!\\d)`, 'g'), () => {
      const token = `\u0000K${saved.length}\u0000`;
      saved.push(id);
      return token;
    });
  }
  s = s.replace(EMAIL_RE, '[redacted-email]');
  s = s.replace(PHONE_RE, (match) => (isBareScoutId(match) ? match : '[redacted-phone]'));
  const tokens = (names || [])
    .map((n) => String(n || '').trim())
    .filter((n) => n.length >= 3);
  for (const name of tokens) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, '[redacted-name]');
  }
  saved.forEach((id, index) => {
    s = s.replaceAll(`\u0000K${index}\u0000`, id);
  });
  return s;
}

function redactMeta(meta, names = [], keepIds = []) {
  const src = meta && typeof meta === 'object' ? meta : {};
  const out = {};
  for (const key of Object.keys(src)) {
    if (!META_KEYS.has(key)) continue;
    const value = src[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    const ids = keepIds.slice();
    if ((key === 'listing_id' || key === 'portal_listing_id') && value != null) ids.push(value);
    out[key] = redactString(value, names, ids).slice(0, 200);
  }
  return out;
}

function collectSecrets(lead) {
  const contact = lead?.contact || lead || {};
  return [contact.email, contact.phone, contact.first_name, contact.last_name, lead?.email, lead?.phone, lead?.first_name, lead?.last_name]
    .filter(Boolean)
    .map((v) => String(v));
}

function findPii(text, secrets) {
  const hay = String(text || '');
  const hits = [];
  const emails = hay.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (emails) hits.push(...emails.map((e) => `email:${e}`));
  for (const secret of secrets || []) {
    const s = String(secret || '').trim();
    if (s.length < 3) continue;
    if (s.includes('@')) {
      if (hay.toLowerCase().includes(s.toLowerCase())) hits.push(`secret:${s}`);
      continue;
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8 && hay.replace(/\D/g, '').includes(digits)) hits.push(`phone:${s}`);
    if (!s.includes('+') && hay.toLowerCase().includes(s.toLowerCase())) hits.push(`name:${s}`);
  }
  return hits;
}

module.exports = {
  redactString,
  redactMeta,
  collectSecrets,
  findPii,
  META_KEYS,
};
