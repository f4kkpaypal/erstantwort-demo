'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { formatPrice } = require('./options');

const SANS = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSans-Regular.ttf');
const NASKH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoNaskhArabic-Regular.ttf');

// Shaping (init/medi/fina) swaps in glyph ids whose ToUnicode map is not the
// typed letter, so extractors lose the phrase. Isolated glyphs keep the
// letters, and the line is drawn from the right.
const ARABIC_FEATURES = {
  rlig: false,
  calt: false,
  liga: false,
  clig: false,
  init: false,
  medi: false,
  fina: false,
  isol: false,
  mark: false,
  mkmk: false,
  ccmp: false,
};

// Arabic is drawn right-to-left so the page reads correctly. Extraction then
// sees that visual order; `logicalText` turns it back into the typed phrase.
function visualLine(text) {
  if (!/[\u0600-\u06FF]/.test(text)) return text;
  const parts = String(text).split(/(\s+)/);
  const visual = parts.map((part) => (/[\u0600-\u06FF]/.test(part) ? [...part].reverse().join('') : part));
  return visual.reverse().join('');
}

function logicalText(text) {
  return String(text || '').split('\n').map((line) => {
    if (!/[\u0600-\u06FF]/.test(line)) return line;
    const parts = line.split(/(\s+)/);
    const logical = parts.reverse().map((part) => (/[\u0600-\u06FF]/.test(part) ? [...part].reverse().join('') : part));
    return logical.join('');
  }).join('\n');
}

function brochureLines(property, meta = {}) {
  const price = property.price_en || (property.price ? formatPrice(property, 'en') : '');
  const rooms = property.bedrooms != null && property.bedrooms !== '' ? `${property.bedrooms}` : '';
  const area = property.area_value ? `${property.area_value} ${property.area_unit || ''}`.trim() : '';
  const broker = meta.brokerName || property.broker_name || property.agency || 'Broker';
  const phone = meta.brokerPhone || property.broker_phone || '';
  return [
    broker,
    phone,
    property.title || '',
    property.address || '',
    property.district || '',
    [rooms, area].filter(Boolean).join(', '),
    price,
    property.listing_url || '',
  ].map((line) => String(line || '').trim()).filter(Boolean);
}

async function brochurePdf(property, meta = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const sans = await doc.embedFont(fs.readFileSync(SANS), { subset: true });
  const naskh = await doc.embedFont(fs.readFileSync(NASKH), { subset: true, features: ARABIC_FEATURES });
  const page = doc.addPage([595, 842]);
  let y = 790;
  for (const line of brochureLines(property || {}, meta)) {
    const arabic = /[\u0600-\u06FF]/.test(line);
    const font = arabic ? naskh : sans;
    const shown = visualLine(line);
    const width = font.widthOfTextAtSize(shown, y > 760 ? 18 : 13);
    const x = arabic ? Math.max(48, 547 - width) : 48;
    page.drawText(shown, { x, y, size: y > 760 ? 18 : 13, font, color: rgb(0.1, 0.1, 0.12) });
    y -= 28;
    if (y < 72) break;
  }
  return Buffer.from(await doc.save());
}

module.exports = { brochurePdf, brochureLines, logicalText, visualLine };
