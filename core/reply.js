'use strict';

const { stripOwnFooter, stripQuotes } = require('./normalize');

const SLOT_RE = /^\s*(?:nr\.?\s*|termin\s*|option\s*)?([1-3])\b/i;
const STOP_CMD = /^\s*(?:bitte\s+)?(?:stop|stopp|stoppen|abmelden|abmeldung|kein\s+interesse)(?:\s+bitte)?\s*[.!]?\s*$/iu;
const STOP_PHRASE = /(?<![\p{L}-])(?:bitte\s+)?(?:keine\s+(?:weiteren\s+)?(?:nachrichten|e-?mails)|abmelden|abmeldung|stoppen|ich\s+habe\s+kein\s+interesse(?:\s+mehr)?)(?![\p{L}-])/iu;
const JA_RE = /^\s*ja\b/i;
const ABSAGE_RE = /\babsage\b/i;
const LEAD_ID_RE = /\[(L-\d{8}-\d{4})\]/;

function replyText(text) {
  return stripOwnFooter(stripQuotes(text)).trim();
}

function classifyReply(text, { inReplyToKind = '', maxJaChars = 60 } = {}) {
  const clean = replyText(text);
  if (!clean) return { action: 'needs_human', reason: 'empty' };
  const command = clean.split('\n').some((line) => STOP_CMD.test(line));
  const phrase = STOP_PHRASE.test(clean);
  const slot = clean.match(SLOT_RE);
  if ((command || phrase) && slot) return { action: 'needs_human', reason: 'stop_and_slot' };
  if (command || phrase) return { action: 'stop', reason: 'stop' };
  if (slot) return { action: 'book', slot_index: Number(slot[1]), reason: 'slot' };
  const short = clean.length <= maxJaChars;
  if (inReplyToKind === 'reminder' && short && JA_RE.test(clean) && !/\baber\b/i.test(clean)) {
    return { action: 'needs_human', reason: 'confirm_not_in_loom_slice' };
  }
  if (ABSAGE_RE.test(clean)) return { action: 'needs_human', reason: 'absage_not_in_loom_slice' };
  return { action: 'needs_human', reason: 'unclear' };
}

function leadIdFromSubject(subject) {
  const match = String(subject || '').match(LEAD_ID_RE);
  return match ? match[1] : null;
}

module.exports = {
  classifyReply,
  leadIdFromSubject,
  replyText,
  SLOT_RE,
  STOP_CMD,
  STOP_PHRASE,
  LEAD_ID_RE,
};
