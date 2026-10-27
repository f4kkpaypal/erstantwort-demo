'use strict';

/**
 * Owner-lead mail adapters.
 *
 * Формат предположительный, не проверен на реальных письмах.
 * Immowelt and Heimziel do not publish a sample we can treat as fact.
 * Each adapter therefore expects a fictional labeled block, marked
 * `Annahme-Format`. There are no portal prices and no real portal fields here.
 * Labels may vary in case, spacing and HTML wrapping.
 * The allowed sender domains come only from config
 * (`OWNER_LEAD_SENDER_DOMAINS`), never from this file.
 * Replace an adapter when a real sample exists. OpenImmo XML for
 * Immowelt stays unimplemented in portals.js.
 * The channel stays off until OWNER_LEADS_ENABLED=true.
 */

const { htmlToText } = require('./normalize');

const OBJECT_TYPES = ['wohnung', 'haus', 'grundstueck', 'gewerbe'];
const HORIZONS = ['bis_3_monate', '3_bis_6_monate', 'ueber_6_monate', 'unbekannt'];

const MARKERS = Object.freeze({
  immowelt: 'immowelt-eigentuemer',
  heimziel: 'heimziel-eigentuemer',
  generic: 'eigentuemer-lead',
});

function unrecognized(source) {
  const name = source || 'unbekannt';
  return {
    ok: false,
    code: 'OWNER_LEAD_UNRECOGNIZED',
    source: name,
    message: `Eigentümer-Lead nicht erkannt (Quelle ${name}). Das angenommene Textformat steht im Adapter und ist keine echte Portal-Vorlage. Format ist eine Annahme und wurde nicht an echten Schreiben geprüft.`,
  };
}

function horizonOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (HORIZONS.includes(text)) return text;
  if (/nächsten\s+3|naechsten\s+3|sofort|diesen monat/.test(text)) return 'bis_3_monate';
  if (/3\s+bis\s+6/.test(text)) return '3_bis_6_monate';
  if (/später|spaeter|keine eile|über\s+6|ueber\s+6/.test(text)) return 'ueber_6_monate';
  return 'unbekannt';
}

function objectTypeOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (OBJECT_TYPES.includes(text)) return text;
  if (text.includes('wohn')) return 'wohnung';
  if (text.includes('grund')) return 'grundstueck';
  if (text.includes('gewerbe') || text.includes('büro') || text.includes('buero')) return 'gewerbe';
  if (text.includes('haus')) return 'haus';
  return 'unbekannt';
}

function areaOf(value) {
  const match = String(value || '').match(/(\d{1,5})/);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 && n < 100000 ? n : null;
}

function salutationOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'herr') return 'Herr';
  if (text === 'frau') return 'Frau';
  if (text === 'divers') return 'divers';
  if (text === 'firma') return 'Firma';
  return 'unbekannt';
}

function yes(value) {
  return /^(ja|yes|true|1)$/i.test(String(value || '').trim());
}

function clip(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : '';
}

const KEY_ALIAS = {
  annahmeformat: 'annahme_format',
  format: 'annahme_format',
  objektart: 'objektart',
  objekttyp: 'objektart',
  art: 'objektart',
  typ: 'objektart',
  ort: 'ort',
  stadt: 'ort',
  stadtteil: 'stadtteil',
  viertel: 'stadtteil',
  bezirk: 'stadtteil',
  flaecheqm: 'flaeche_qm',
  flaeche: 'flaeche_qm',
  wohnflaeche: 'flaeche_qm',
  grundstuecksflaeche: 'flaeche_qm',
  qm: 'flaeche_qm',
  verkauf: 'verkauf',
  verkaufszeitraum: 'verkauf',
  zeitraum: 'verkauf',
  bewertungstermin: 'bewertungstermin',
  bewertung: 'bewertungstermin',
  anrede: 'anrede',
  vorname: 'vorname',
  nachname: 'nachname',
  telefon: 'telefon',
  tel: 'telefon',
  handy: 'telefon',
  nachricht: 'nachricht',
  anmerkung: 'nachricht',
  mitteilung: 'nachricht',
  objekt: 'objekt',
  titel: 'objekt',
};

function foldKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

function looksLikeHtml(value) {
  return /<[a-z][\s\S]*>/i.test(String(value || ''));
}

function labelsFromHtml(html) {
  let source = String(html || '');
  source = source.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  source = source.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  source = source.replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ': ');
  source = source.replace(/<br\s*\/?>/gi, '\n');
  source = source.replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');
  return htmlToText(source);
}

function prepareOwnerText(text, html) {
  const fromHtml = html ? labelsFromHtml(html) : '';
  const plain = looksLikeHtml(text) ? labelsFromHtml(text) : String(text || '');
  const chosen = /annahme/i.test(fromHtml) ? fromHtml : plain;
  return chosen.replace(/\u00a0/g, ' ');
}

function parseAssumedLabeled(text, marker) {
  const fields = {};
  let marked = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, '');
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([^:]{1,80}):\s*(.*)$/);
    if (!match) continue;
    const key = KEY_ALIAS[foldKey(match[1])] || '';
    const value = match[2].trim().replace(/[ \t]{2,}/g, ' ');
    if (!key) continue;
    if (key === 'annahme_format') {
      if (foldKey(value) === foldKey(marker)) marked = true;
      continue;
    }
    fields[key] = value;
  }
  if (!marked) return { ok: false };
  const objectType = objectTypeOf(fields.objektart);
  const city = clip(fields.ort, 80);
  const district = clip(fields.stadtteil, 80);
  const typeLabel = {
    wohnung: 'Wohnung',
    haus: 'Haus',
    grundstueck: 'Grundstück',
    gewerbe: 'Gewerbe',
  }[objectType] || '';
  const place = [district, city].filter(Boolean).join(', ');
  const title = clip(fields.objekt, 120) || [typeLabel, place].filter(Boolean).join(' in ') || 'Ihr Objekt';
  return {
    ok: true,
    assumption: true,
    fields: {
      object_type: objectType,
      city,
      district,
      area_sqm: areaOf(fields.flaeche_qm),
      timeline_horizon: horizonOf(fields.verkauf),
      valuation_requested: yes(fields.bewertungstermin),
      salutation: salutationOf(fields.anrede),
      first_name: clip(fields.vorname, 60),
      last_name: clip(fields.nachname, 60),
      phone: clip(fields.telefon, 40),
      title,
      note: clip(fields.nachricht, 600),
    },
  };
}

const ADAPTERS = {
  immowelt(text) {
    return parseAssumedLabeled(text, MARKERS.immowelt);
  },
  heimziel(text) {
    return parseAssumedLabeled(text, MARKERS.heimziel);
  },
  generic(text) {
    return parseAssumedLabeled(text, MARKERS.generic);
  },
};

function parseOwnerMail({ source, text, html } = {}) {
  const id = String(source || '').trim().toLowerCase();
  const adapter = ADAPTERS[id];
  if (!adapter) return unrecognized(id);
  const parsed = adapter(prepareOwnerText(text, html));
  if (!parsed.ok) return unrecognized(id);
  return { ok: true, source: id, assumption: true, fields: parsed.fields };
}

function matchOwnerSource(from, sources) {
  const domain = String(from || '').trim().toLowerCase().split('@')[1] || '';
  if (!domain) return null;
  return (sources || []).find((row) => domain === row.domain || domain.endsWith(`.${row.domain}`)) || null;
}

function ownerLeadSources(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const out = [];
  for (const part of text.split(',')) {
    const piece = part.trim().toLowerCase();
    const sep = piece.indexOf(':');
    if (sep <= 0 || sep === piece.length - 1) continue;
    const id = piece.slice(0, sep).replace(/[^a-z0-9_-]/g, '');
    const domain = piece.slice(sep + 1).trim();
    if (!id || !domain || /\s/.test(domain)) continue;
    out.push({ id, domain });
  }
  return out;
}

module.exports = {
  MARKERS,
  ADAPTERS,
  parseOwnerMail,
  parseAssumedLabeled,
  prepareOwnerText,
  matchOwnerSource,
  ownerLeadSources,
  unrecognized,
};
