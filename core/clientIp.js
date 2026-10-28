'use strict';

const FORM_WINDOW_MS = 10 * 60 * 1000;
const FORM_LIMIT = 60;
const formHits = new Map();

function normalizeIp(value) {
  let text = String(value || '').trim();
  if (text.startsWith('::ffff:')) text = text.slice(7);
  return text;
}

function trustHops(trustProxy) {
  if (trustProxy === true) return 1;
  if (typeof trustProxy === 'number' && trustProxy > 0) return Math.min(Math.trunc(trustProxy), 8);
  return 0;
}

function clientIp(req, trustProxy = false) {
  const socketIp = normalizeIp(req?.socket?.remoteAddress) || 'local';
  const hops = trustHops(trustProxy);
  if (!hops) return socketIp;
  const raw = req?.headers?.['x-forwarded-for'] || '';
  const chain = String(raw).split(',').map(normalizeIp).filter(Boolean);
  if (!chain.length) return socketIp;
  const index = Math.max(0, chain.length - hops);
  return chain[index] || socketIp;
}

function rateAllow(hits, key, now, { windowMs = FORM_WINDOW_MS, limit = FORM_LIMIT } = {}) {
  for (const [other, stamps] of [...hits.entries()]) {
    const fresh = stamps.filter((ts) => now - ts < windowMs);
    if (fresh.length === 0) hits.delete(other);
    else if (fresh.length !== stamps.length) hits.set(other, fresh);
  }
  const bucket = hits.get(key) || [];
  if (bucket.length >= limit) return false;
  bucket.push(now);
  hits.set(key, bucket);
  return true;
}

function resetFormHits() {
  formHits.clear();
}

module.exports = {
  FORM_WINDOW_MS,
  FORM_LIMIT,
  formHits,
  normalizeIp,
  clientIp,
  rateAllow,
  resetFormHits,
};
