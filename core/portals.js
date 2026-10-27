'use strict';

function decode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function sliceTag(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = String(xml || '').match(re);
  return match ? match[1] : '';
}

function textTag(xml, tag) {
  const raw = sliceTag(xml, tag);
  if (!raw) return null;
  return decode(raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function parseGermanAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/€|eur/gi, '').replace(/\s/g, '');
  if (!s) return null;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function mapSalutation(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'herr' || v === 'mr' || v === 'mr.') return 'Herr';
  if (v === 'frau' || v === 'mrs' || v === 'ms' || v === 'ms.') return 'Frau';
  if (v === 'divers') return 'divers';
  if (v === 'firma' || v === 'company') return 'Firma';
  if (!v) return null;
  return 'unbekannt';
}

function parseOpenImmo(xml) {
  const sender = sliceTag(xml, 'sender');
  const objekt = sliceTag(xml, 'objekt');
  const interessent = sliceTag(objekt || xml, 'interessent');
  const regi = textTag(sender, 'regi_id') || textTag(xml, 'regi_id');
  const senderName = textTag(sender, 'name');
  const portalObjId = textTag(objekt, 'portal_obj_id') || textTag(objekt, 'oobj_id');
  const fields = {
    version: textTag(xml, 'version'),
    sender_name: senderName,
    regi_id: regi,
    portal_listing_id: portalObjId,
    title: textTag(objekt, 'bezeichnung'),
    city: textTag(objekt, 'ort'),
    price_eur: parseGermanAmount(textTag(objekt, 'preis')),
    salutation: mapSalutation(textTag(interessent, 'anrede')),
    first_name: textTag(interessent, 'vorname'),
    last_name: textTag(interessent, 'nachname'),
    phone: textTag(interessent, 'tel'),
    email: (textTag(interessent, 'email') || '').toLowerCase() || null,
    anfrage: textTag(interessent, 'anfrage'),
  };
  return {
    ok: true,
    portal: 'immoscout24',
    code: 'PARSED',
    fields,
  };
}

function parseImmowelt() {
  return {
    ok: false,
    portal: 'immowelt',
    code: 'NOT_IMPLEMENTED',
    fields: null,
    message: 'Immowelt is out of scope for this slice. The parser interface is reserved.',
  };
}

function detectPortal(xml) {
  const raw = String(xml || '');
  if (!raw.trim()) return null;
  const sender = sliceTag(raw, 'sender');
  const regi = (textTag(sender, 'regi_id') || '').toLowerCase();
  const senderName = (textTag(sender, 'name') || '').toLowerCase();
  if (regi.includes('immowelt') || senderName.includes('immowelt')) return 'immowelt';
  if (/<openimmo_feedback\b/i.test(raw) || regi === 'is24' || senderName.includes('immoscout') || senderName.includes('is24')) {
    return 'immoscout24';
  }
  return null;
}

const PARSERS = {
  immoscout24: parseOpenImmo,
  immowelt: parseImmowelt,
};

function parsePortalPayload({ portal, xml } = {}) {
  const detected = detectPortal(xml);
  const id = portal || detected;
  if (!id) return { ok: false, portal: null, code: 'NO_PORTAL_XML', fields: null };
  if (id === 'immowelt' || detected === 'immowelt') return parseImmowelt();
  const parser = PARSERS[id];
  if (!parser) return { ok: false, portal: id, code: 'UNKNOWN_PORTAL', fields: null };
  return parser(xml);
}

module.exports = {
  parsePortalPayload,
  detectPortal,
  parseOpenImmo,
  parseImmowelt,
  parseGermanAmount,
  PARSERS,
};
