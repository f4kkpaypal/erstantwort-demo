'use strict';

const fs = require('fs');
const path = require('path');

function decodeQuotedPrintable(input) {
  const text = String(input).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && /^[0-9A-F]{2}/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeHeader(value) {
  return String(value || '').replace(/=\?UTF-8\?Q\?([\s\S]*?)\?=/gi, (_, qp) => {
    return decodeQuotedPrintable(qp.replace(/_/g, ' '));
  });
}

function parseHeaders(head) {
  const headers = {};
  let current = '';
  for (const line of String(head || '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    current = line.slice(0, idx).trim().toLowerCase();
    headers[current] = line.slice(idx + 1).trim();
  }
  return headers;
}

function decodeBody(raw, encoding) {
  const kind = String(encoding || '').toLowerCase();
  if (kind === 'quoted-printable') return decodeQuotedPrintable(raw);
  if (kind === 'base64') return Buffer.from(String(raw).replace(/\s/g, ''), 'base64').toString('utf8');
  return raw;
}

function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  const parts = [];
  for (const chunk of String(body || '').split(marker).slice(1)) {
    if (chunk.startsWith('--')) break;
    const cleaned = chunk.replace(/^\r?\n/, '');
    const split = cleaned.split(/\r?\n\r?\n/);
    const headers = parseHeaders(split.shift() || '');
    const raw = split.join('\n\n');
    const decoded = decodeBody(raw, headers['content-transfer-encoding']);
    const type = headers['content-type'] || '';
    const nested = /boundary="?([^";]+)"?/i.exec(type);
    if (/multipart\//i.test(type) && nested) {
      parts.push(...splitMultipart(decoded, nested[1]));
      continue;
    }
    parts.push({ type, body: decoded });
  }
  return parts;
}

function messageFrom(headers, textPlain, textHtml) {
  return {
    messageId: headers['message-id'] || '',
    from: headers.from || '',
    to: headers.to || '',
    subject: decodeHeader(headers.subject || ''),
    date: headers.date || '',
    inReplyTo: headers['in-reply-to'] || '',
    references: headers.references || '',
    textPlain: String(textPlain || '').trim(),
    textHtml: String(textHtml || '').trim(),
    headers,
    fixture: headers['x-fixture'] || '',
  };
}

function parseEml(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  const split = text.split(/\r?\n\r?\n/);
  const headers = parseHeaders(split.shift() || '');
  const bodyRaw = split.join('\n\n');
  const contentType = headers['content-type'] || '';
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType);
  if (/multipart\//i.test(contentType) && boundary) {
    const parts = splitMultipart(bodyRaw, boundary[1]);
    const plain = parts.find((part) => /text\/plain/i.test(part.type));
    const html = parts.find((part) => /text\/html/i.test(part.type));
    return messageFrom(headers, plain?.body || '', html?.body || '');
  }
  const body = decodeBody(bodyRaw, headers['content-transfer-encoding']);
  if (/text\/html/i.test(contentType)) return messageFrom(headers, '', body);
  return messageFrom(headers, body, '');
}

function loadFixtureEml(id, root = path.join(__dirname, '..', 'fixtures', 'eml')) {
  const raw = fs.readFileSync(path.join(root, `${id}.eml`));
  return parseEml(raw.toString('utf8'));
}

module.exports = { parseEml, loadFixtureEml, decodeHeader };
