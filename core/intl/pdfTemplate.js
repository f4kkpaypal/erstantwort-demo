'use strict';

const { rgb } = require('pdf-lib');

// Default one-page brochure.
// Swap this file for the owner's template later. brochure.js loads the Noto
// fonts, embeds the photos, and calls renderTemplate. Keep this signature:
//   renderTemplate({ page, fonts, lines, photos, visualLine })
// `lines` is the property text in order (broker, phone, title, address,
// district, rooms and area, price, listing). Draw every line.
// `photos` is an array of pdf-lib embedded images.

const INK = rgb(0.11, 0.13, 0.16);
const MUTED = rgb(0.33, 0.36, 0.4);
const NAVY = rgb(0.11, 0.18, 0.28);
const BRASS = rgb(0.72, 0.54, 0.24);
const PAPER = rgb(0.97, 0.96, 0.94);

function renderTemplate({ page, fonts, lines, photos, visualLine }) {
  const sans = fonts.sans;
  const naskh = fonts.naskh;
  const list = Array.isArray(lines) ? lines : [];
  const images = Array.isArray(photos) ? photos.slice(0, 6) : [];
  page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: PAPER });
  page.drawRectangle({ x: 0, y: 802, width: 595, height: 40, color: NAVY });
  page.drawRectangle({ x: 0, y: 0, width: 10, height: 842, color: BRASS });
  let y = 760;
  for (let index = 0; index < list.length; index += 1) {
    const line = String(list[index] || '');
    if (!line || y < 40) continue;
    const arabic = /[\u0600-\u06FF]/.test(line);
    const font = arabic ? naskh : sans;
    const size = index === 0 ? 20 : index === 2 ? 16 : 12;
    const shown = visualLine(line);
    const width = font.widthOfTextAtSize(shown, size);
    const x = arabic ? Math.max(36, 560 - width) : 36;
    page.drawText(shown, { x, y, size, font, color: index === 0 ? INK : MUTED });
    y -= size + 12;
  }
  if (!images.length) return;
  const cols = Math.min(3, images.length);
  const cell = 150;
  const gap = 12;
  images.forEach((image, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const scale = Math.min(cell / image.width, 120 / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const x = 36 + col * (cell + gap);
    const top = 156 - row * (120 + gap);
    page.drawImage(image, { x, y: top - height, width, height });
  });
}

module.exports = { renderTemplate };
