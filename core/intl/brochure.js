'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { formatPrice } = require('./options');
const { renderTemplate } = require('./pdfTemplate');

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

async function embedPhotos(doc, photos) {
  const images = [];
  for (const photo of photos || []) {
    try {
      const bytes = Buffer.from(photo.bytes);
      const mime = String(photo.mime || '');
      const image = mime.includes('png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      images.push(image);
    } catch { /* a photo this pipeline cannot draw is left out of the page */ }
  }
  return images;
}

async function brochurePdf(property, meta = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const sans = await doc.embedFont(fs.readFileSync(SANS), { subset: true });
  const naskh = await doc.embedFont(fs.readFileSync(NASKH), { subset: true, features: ARABIC_FEATURES });
  const page = doc.addPage([595, 842]);
  const photos = await embedPhotos(doc, meta.photos);
  renderTemplate({
    page,
    fonts: { sans, naskh },
    lines: brochureLines(property || {}, meta),
    photos,
    visualLine,
  });
  return Buffer.from(await doc.save());
}

module.exports = { brochurePdf, brochureLines, logicalText, visualLine };
