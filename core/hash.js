'use strict';

const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeMessageId(value) {
  if (!value) return '';
  let raw = String(value).trim();
  const bracket = raw.match(/<[^>]+>/);
  if (bracket) raw = bracket[0];
  raw = raw.replace(/^<|>$/g, '').trim().toLowerCase();
  return raw;
}

function messageIdHash(value) {
  const norm = normalizeMessageId(value);
  if (!norm) return '';
  return sha256(norm);
}

function emailHash(email, salt) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return '';
  return sha256(`${salt}\n${norm}`);
}

function contentHash(subject, text) {
  return sha256(`${String(subject || '').trim()}\n${String(text || '').trim()}`);
}

module.exports = {
  sha256,
  normalizeMessageId,
  messageIdHash,
  emailHash,
  contentHash,
};
