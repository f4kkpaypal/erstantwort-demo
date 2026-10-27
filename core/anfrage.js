'use strict';

const { DateTime } = require('luxon');
const { parseGermanAmount } = require('./portals');

function parseGermanDate(value) {
  const match = String(value || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const dt = DateTime.fromISO(iso, { zone: 'Europe/Berlin' });
  return dt.isValid ? iso : null;
}

function horizonFromTarget(isoDate, now, zone = 'Europe/Berlin') {
  if (!isoDate) return null;
  const target = DateTime.fromISO(isoDate, { zone }).startOf('day');
  const base = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone }).startOf('day');
  if (!target.isValid || !base.isValid) return null;
  const months = target.diff(base, 'months').months;
  if (months <= 3) return 'bis_3_monate';
  if (months <= 6) return '3_bis_6_monate';
  return 'ueber_6_monate';
}

function parseAnfrage(text, now = new Date(), zone = 'Europe/Berlin') {
  const src = String(text || '');
  const out = {};
  if (/Finanzrahmen geprüft:\s*Ja/i.test(src)) out.financing_status = 'finanzierungszusage';
  else if (/Barzahler|ohne Finanzierung|kein Darlehen/i.test(src)) out.financing_status = 'barzahler';

  const equity = src.match(/Eigenkapital:\s*([0-9][0-9.\s]*)\s*(?:-|–|bis)\s*([0-9][0-9.\s]*)/i);
  if (equity) {
    const lower = parseGermanAmount(equity[1]);
    if (lower != null) out.equity_eur = lower;
  } else {
    const single = src.match(/Eigenkapital:\s*([0-9][0-9.\s]*)/i);
    if (single) {
      const n = parseGermanAmount(single[1]);
      if (n != null) out.equity_eur = n;
    }
  }

  const move = src.match(/(?:einzug(?:s(?:termin|datum))?|bezugs(?:termin|datum))(?:\s+[A-Za-zÄÖÜäöüß.-]+){0,3}\s*(?::|am|zum|ab)?\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (move) {
    const iso = parseGermanDate(move[1]);
    if (iso) {
      out.target_date = iso;
      const horizon = horizonFromTarget(iso, now, zone);
      if (horizon) out.timeline_horizon = horizon;
    }
  }

  if (/SCHUFA-Bonitätscheck:\s*Ja/i.test(src) || /SCHUFA[^.\n]{0,40}\bliegt vor\b/i.test(src)) {
    out.schufa_available = 'ja';
  } else if (/SCHUFA-Bonitätscheck:\s*Nein/i.test(src)) {
    out.schufa_available = 'nein';
  }
  return out;
}

function applyPortalFacts(lead, portalFields, anfrageFacts) {
  const next = structuredClone(lead);
  const fields = portalFields || {};
  const extra = anfrageFacts || {};
  next.listing = next.listing || {};
  next.contact = next.contact || {};
  next.timeline = next.timeline || {};
  if (fields.portal_listing_id) next.listing.portal_listing_id = fields.portal_listing_id;
  if (fields.title) next.listing.title = fields.title;
  if (fields.price_eur != null) next.listing.price_eur = fields.price_eur;
  if (fields.email) next.contact.email = fields.email;
  if (fields.phone) next.contact.phone = fields.phone;
  if (fields.first_name) next.contact.first_name = fields.first_name;
  if (fields.last_name) next.contact.last_name = fields.last_name;
  if (fields.salutation) next.contact.salutation = fields.salutation;
  if (extra.financing_status) next.financing_status = extra.financing_status;
  if (extra.equity_eur != null) next.equity_eur = extra.equity_eur;
  if (extra.target_date) next.timeline.target_date = extra.target_date;
  if (extra.timeline_horizon) next.timeline.horizon = extra.timeline_horizon;
  if (extra.schufa_available) next.schufa_available = extra.schufa_available;
  return reconcileMissingFields(next);
}

const KNOWN_HORIZON = new Set(['bis_3_monate', '3_bis_6_monate', 'ueber_6_monate']);

function fieldIsKnown(lead, field) {
  if (field === 'timeline') {
    return Boolean(lead.timeline?.target_date) || KNOWN_HORIZON.has(lead.timeline?.horizon);
  }
  if (field === 'financing') {
    return Boolean(lead.financing_status) && lead.financing_status !== 'unbekannt';
  }
  if (field === 'budget') {
    return lead.budget?.amount_max_eur != null && Number.isFinite(Number(lead.budget.amount_max_eur));
  }
  if (field === 'phone') {
    return Boolean(String(lead.contact?.phone || '').trim());
  }
  return false;
}

function reconcileMissingFields(lead) {
  const listed = Array.isArray(lead?.missing_fields) ? lead.missing_fields : [];
  lead.missing_fields = listed.filter((field) => !fieldIsKnown(lead, field));
  return lead;
}

module.exports = {
  parseAnfrage,
  applyPortalFacts,
  horizonFromTarget,
  parseGermanDate,
  reconcileMissingFields,
};
