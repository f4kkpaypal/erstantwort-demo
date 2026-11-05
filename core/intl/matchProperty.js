'use strict';

// Auto-attach a catalog property only when the client wrote its title as a whole
// phrase. "Bay" does not match "Business Bay". A fragment of the title does not
// match. Address, district, rooms, price, id and link are not used.

const LEAD_IN = new Set('the a an in on at of for to and or my our this that hi hello please interested about want see show from with по в на у и или это хочу про для'.split(' '));

function norm(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').trim().replace(/\s+/g, ' ');
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findPhrase(text, title) {
  if (!title) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(title)}(?![\\p{L}\\p{N}])`, 'u');
  const match = re.exec(text);
  return match ? match.index : null;
}

function blockedByLongerName(text, index, title) {
  if (title.includes(' ')) return false;
  const before = text.slice(0, index);
  const word = before.match(/([\p{L}\p{N}]+)\s*$/u);
  if (!word) return false;
  return !LEAD_IN.has(word[1]);
}

function matchProperty(text, properties) {
  const folded = norm(text);
  if (!folded) return null;
  const hits = [];
  for (const property of properties || []) {
    if (!property || !property.id || property.id === 'general') continue;
    const title = norm(property.title);
    const index = findPhrase(folded, title);
    if (index == null || blockedByLongerName(folded, index, title)) continue;
    hits.push({ id: property.id, title, index, length: title.length });
  }
  const byTitle = new Map();
  for (const hit of hits) {
    if (!byTitle.has(hit.title)) byTitle.set(hit.title, []);
    byTitle.get(hit.title).push(hit);
  }
  const unique = [];
  for (const group of byTitle.values()) {
    if (group.length === 1) unique.push(group[0]);
  }
  if (!unique.length) return null;
  unique.sort((a, b) => b.length - a.length || a.index - b.index);
  if (unique.length > 1 && unique[0].length === unique[1].length) return null;
  return { id: unique[0].id, score: unique[0].length, reasons: ['title'] };
}

module.exports = { matchProperty, norm };
