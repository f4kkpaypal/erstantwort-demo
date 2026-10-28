'use strict';

const { stripOwnFooter, stripQuotes } = require('./normalize');

const SLOT_MARK = /(?:^|[^\p{L}\d])(?:nr\.?\s*|termin\s*|option\s*)([1-3])(?!\d)/iu;
const SLOT_BARE = /^\s*([1-3])(?!\d)/;
const STOP_CMD = /^\s*(?:bitte\s+)?(?:stop|stopp|stoppen|abmelden|abmeldung|abbestellen|austragen|kein\s+interesse(?:\s+mehr)?|ich\s+habe\s+kein\s+interesse(?:\s+mehr)?|keine\s+(?:weiteren\s+)?(?:nachrichten|e-?mails|mitteilungen)(?:\s+mehr)?|melden\s+sie\s+mich\s+ab|ich\s+widerspreche|widerspruch|nicht\s+mehr\s+anschreiben|unsubscribe)(?:\s+bitte)?\s*[.!]?\s*$/iu;
const STOP_SENTENCE = /(?:^|[.!?]\s+)["„]?(?:stop|stopp)["“]?\s*[.!]?\s*$/imu;
const STOP_PHRASE = /(?<![\p{L}-])(?:bitte\s+)?(?:keine\s+(?:weiteren\s+)?(?:nachrichten|e-?mails)|abmelden|abmeldung|stoppen|ich\s+habe\s+kein\s+interesse(?:\s+mehr)?|melden\s+sie\s+mich\s+ab|unsubscribe)(?![\p{L}-])/iu;
const JA_RE = /^\s*ja\b/i;
const ABSAGE_RE = /\babsage\b/i;
const LEAD_ID_RE = /\[(L-\d{8}-\d{4})\]/;

function replyText(text) {
  return stripOwnFooter(stripQuotes(text)).trim();
}

function findSlot(clean) {
  const marked = String(clean || '').match(SLOT_MARK);
  if (marked) return Number(marked[1]);
  const bare = String(clean || '').match(SLOT_BARE);
  return bare ? Number(bare[1]) : null;
}

function classifyReply(text, { inReplyToKind = '', maxJaChars = 60 } = {}) {
  const clean = replyText(text);
  if (!clean) return { action: 'needs_human', reason: 'empty' };
  const command = clean.split('\n').some((line) => STOP_CMD.test(line) || STOP_SENTENCE.test(line));
  const phrase = STOP_PHRASE.test(clean);
  const slot = findSlot(clean);
  if ((command || phrase) && slot) return { action: 'needs_human', reason: 'stop_and_slot' };
  if (command || phrase) return { action: 'stop', reason: 'stop' };
  if (slot) return { action: 'book', slot_index: slot, reason: 'slot' };
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
  findSlot,
  SLOT_MARK,
  STOP_CMD,
  STOP_PHRASE,
  LEAD_ID_RE,
};
