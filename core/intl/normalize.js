'use strict';

const LOOKALIKE = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', к: 'k', м: 'm', т: 't', в: 'b', н: 'h',
};

function nfkc(value) {
  return String(value || '').normalize('NFKC');
}

function stripInvisible(value) {
  return nfkc(value)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function mapDigits(value) {
  return stripInvisible(value)
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06F0))
    .replace(/\u066B/g, '.')
    .replace(/\u066C/g, ',');
}

function foldHomoglyphs(word) {
  const hasCyr = /\p{Script=Cyrillic}/u.test(word);
  const hasLat = /\p{Script=Latin}/u.test(word);
  if (!hasCyr || !hasLat) return word;
  return [...word].map((ch) => LOOKALIKE[ch.toLowerCase()] || ch).join('');
}

function normalize(text) {
  const visible = mapDigits(text).replace(/[ \t]+/g, ' ').trim();
  const clean = visible.toLowerCase();
  const tokens = clean.split(/\s+/).filter(Boolean).map(foldHomoglyphs);
  return { clean: tokens.join(' '), tokens, visible, length: stripInvisible(text).length };
}

function parseAmount(raw) {
  let s = String(raw || '').replace(/\s/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
    s = s.replace(/[.,]/g, '');
  } else {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function applySuffix(amount, suffix) {
  const mark = String(suffix || '').toLowerCase();
  if (/^(k|к|тыс)$/.test(mark)) return amount * 1000;
  if (/^(m|mn|млн)$/.test(mark)) return amount * 1000000;
  return amount;
}

module.exports = {
  normalize,
  stripInvisible,
  parseAmount,
  applySuffix,
  foldHomoglyphs,
};
