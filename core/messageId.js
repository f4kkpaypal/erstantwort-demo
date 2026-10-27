'use strict';

const crypto = require('crypto');
const { messageIdHash, normalizeMessageId } = require('./hash');

function makeMessageId({ leadId, domain, clock = () => new Date() }) {
  const host = String(domain || 'localhost').replace(/^@/, '').trim() || 'localhost';
  const rand = crypto.randomBytes(8).toString('hex');
  const stamp = clock().getTime().toString(36);
  const local = `${leadId}.${stamp}.${rand}`.replace(/[^A-Za-z0-9._-]/g, '');
  const messageId = `<${local}@${host}>`;
  return {
    messageId,
    normalized: normalizeMessageId(messageId),
    hash: messageIdHash(messageId),
  };
}

module.exports = { makeMessageId };
