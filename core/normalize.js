'use strict';

const { contentHash, messageIdHash, normalizeMessageId } = require('./hash');

const TAG_LINE = /^\s*<\/?(?:email|portal_xml)\s*>\s*$/i;

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/div>/gi, '\n');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s;
}

const QUOTE_BREAK = [
  /^-{2,}\s*(?:original message|ursprüngliche nachricht|urspruengliche nachricht)\s*-{2,}/i,
  /^(?:gesendet|sent|von|from|an|to|betreff|subject):\s+\S/i,
  /^am .+(?:schrieb|wrote)/i,
  /^on .+ wrote/i,
  /^_{5,}\s*$/,
];

function stripQuotes(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (QUOTE_BREAK.some((pattern) => pattern.test(line.trim()))) break;
    out.push(line);
  }
  return out.join('\n');
}

function stripOwnFooter(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !/der weiteren automatischen Bearbeitung/i.test(line))
    .join('\n');
}

function dkimPassed(source) {
  // Authentication-Results and X-DKIM-Status travel inside the message.
  // The sender can write them. Only the receiving program may set dkimVerified.
  return Boolean(source) && source.dkimVerified === true;
}

function stripControlTags(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !TAG_LINE.test(line))
    .join('\n')
    .replace(/<\/?(?:email|portal_xml)\s*>/gi, '');
}

function collapse(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractXml(text) {
  if (!text) return '';
  const match = String(text).match(/<openimmo_feedback[\s\S]*?<\/openimmo_feedback>/i);
  return match ? match[0].trim() : '';
}

function unwrapNamedHeader(name, value) {
  const text = String(value || '').trim();
  if (!name || !text) return text;
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^${escaped}\\s*:\\s*`, 'i'), '').trim();
}

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    return v ? unwrapNamedHeader(name, v) : '';
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const value = headers[key];
      const raw = Array.isArray(value) ? value[0] : value;
      return raw == null ? '' : unwrapNamedHeader(wanted, raw);
    }
  }
  return '';
}

function addressOf(value) {
  if (!value) return '';
  if (Array.isArray(value)) return addressOf(value[0]);
  if (typeof value === 'object') {
    if (value.address) return String(value.address).trim();
    if (Array.isArray(value.value)) return addressOf(value.value[0]);
    if (value.value) return addressOf(value.value);
    if (value.text) return addressOf(value.text);
    return '';
  }
  const text = String(value).replace(/^from\s*:\s*/i, '').trim();
  const match = text.match(/<([^>]+)>/);
  if (match) return match[1].trim();
  return text.trim();
}

function fromImapItem(item) {
  const src = item || {};
  const headers = src.headers || src.header || {};
  const textPlain = src.textPlain || src.text || src.text_plain || '';
  const textHtml = src.textHtml || src.html || src.text_html || '';
  const messageId = unwrapNamedHeader('message-id', src.messageId || src.message_id || src['message-id'] || header(headers, 'message-id'));
  const inReplyTo = unwrapNamedHeader('in-reply-to', src.inReplyTo || src.in_reply_to || src['in-reply-to'] || header(headers, 'in-reply-to'));
  const references = src.references || header(headers, 'references');
  const replyTo = src.replyTo || src.reply_to || header(headers, 'reply-to');
  return {
    messageId: String(messageId || '').trim(),
    from: addressOf(src.from || header(headers, 'from')),
    fromRaw: String(src.from || header(headers, 'from') || ''),
    to: addressOf(src.to || header(headers, 'to')),
    replyTo: addressOf(replyTo),
    subject: String(src.subject || header(headers, 'subject') || ''),
    textPlain: String(textPlain || ''),
    textHtml: String(textHtml || ''),
    date: src.date || header(headers, 'date') || null,
    inReplyTo: String(inReplyTo || ''),
    references: String(references || ''),
    headers,
    xmlAttachment: src.xml_raw_attachment || src.xmlAttachment || '',
    hasOtherAttachment: Boolean(src.has_other_attachment || src.hasOtherAttachment),
    fixture: src.fixture || header(headers, 'x-fixture') || '',
    autoSubmitted: header(headers, 'auto-submitted'),
    xAutoreply: header(headers, 'x-autoreply') || header(headers, 'x-autorespond'),
    dkimPass: dkimPassed(src),
  };
}

function normalizeInbound(input, { ownAddresses = [] } = {}) {
  const mail = input && (input.textPlain || input.text || input.messageId || input.subject)
    ? fromImapItem(input)
    : fromImapItem(input?.imap || input);

  let text = mail.textPlain ? mail.textPlain : htmlToText(mail.textHtml);
  if (mail.textPlain && mail.textHtml && mail.textPlain.length < 40) {
    const htmlText = htmlToText(mail.textHtml);
    if (htmlText.length > text.length) text = htmlText;
  }
  text = stripOwnFooter(stripQuotes(text));
  text = stripControlTags(text);
  text = text.replace(/<openimmo_feedback[\s\S]*?<\/openimmo_feedback>/gi, '\n');
  text = collapse(text);
  if (text.length > 8000) text = text.slice(0, 8000);

  const xmlFromBody = extractXml(`${mail.textPlain}\n${mail.textHtml}`);
  const xmlFromAttachment = extractXml(mail.xmlAttachment) || (
    /<openimmo_feedback/i.test(mail.xmlAttachment || '') ? String(mail.xmlAttachment).trim() : ''
  );
  const xmlRaw = xmlFromBody || xmlFromAttachment || '';

  const auto = String(mail.autoSubmitted || '').trim().toLowerCase();
  const own = ownAddresses.map((a) => a.toLowerCase());
  const skipAuto = (auto && auto !== 'no') || Boolean(mail.xAutoreply) || own.includes(mail.from.toLowerCase());

  const subject = collapse(stripControlTags(mail.subject)).slice(0, 300);
  return {
    message_id: mail.messageId,
    message_id_hash: messageIdHash(mail.messageId),
    message_id_norm: normalizeMessageId(mail.messageId),
    from: mail.from,
    reply_to: mail.replyTo,
    to: mail.to,
    subject,
    text_clean: text,
    text_html: mail.textHtml ? String(mail.textHtml).slice(0, 20000) : '',
    xml_raw: xmlRaw,
    content_hash: contentHash(subject, text),
    in_reply_to: mail.inReplyTo,
    in_reply_to_hash: messageIdHash(mail.inReplyTo),
    references: mail.references,
    date: mail.date ? new Date(mail.date).toISOString() : null,
    fixture: String(mail.fixture || '').trim(),
    skip_auto: skipAuto,
    has_other_attachment: Boolean(mail.hasOtherAttachment),
    dkim_pass: Boolean(mail.dkimPass),
  };
}

module.exports = {
  decodeEntities,
  htmlToText,
  stripQuotes,
  stripOwnFooter,
  dkimPassed,
  normalizeInbound,
  fromImapItem,
  extractXml,
  addressOf,
};
