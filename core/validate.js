'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ENUMS = {
  language: ['de', 'en', 'other'],
  inquiry_type: ['kauf', 'miete', 'unbekannt'],
  salutation: ['Herr', 'Frau', 'divers', 'Firma', 'unbekannt'],
  financing_status: ['barzahler', 'finanzierungszusage', 'in_pruefung', 'nicht_geklaert', 'unbekannt'],
  horizon: ['bis_3_monate', '3_bis_6_monate', 'ueber_6_monate', 'unbekannt'],
  schufa_available: ['ja', 'nein', 'unbekannt'],
  question: [
    'verfuegbarkeit', 'preis_verhandelbar', 'nebenkosten_hausgeld', 'provision', 'energieausweis',
    'unterlagen_expose', 'haustiere', 'stellplatz', 'zustand_renovierung', 'sonstiges',
  ],
  missing: ['budget', 'financing', 'timeline', 'phone'],
};

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateExtraction(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['not_object'], lead: null };
  }
  const lead = {
    is_real_estate_inquiry: raw.is_real_estate_inquiry === true,
    language: raw.language,
    inquiry_type: raw.inquiry_type,
    listing: {
      portal_listing_id: raw.listing?.portal_listing_id ?? null,
      title: raw.listing?.title ?? null,
      price_eur: raw.listing?.price_eur ?? null,
    },
    contact: {
      salutation: raw.contact?.salutation,
      first_name: raw.contact?.first_name ?? null,
      last_name: raw.contact?.last_name ?? null,
      email: raw.contact?.email ?? null,
      phone: raw.contact?.phone ?? null,
    },
    budget: {
      amount_max_eur: raw.budget?.amount_max_eur ?? null,
      raw_text: raw.budget?.raw_text ?? null,
    },
    equity_eur: raw.equity_eur ?? null,
    financing_status: raw.financing_status,
    timeline: {
      target_date: raw.timeline?.target_date ?? null,
      horizon: raw.timeline?.horizon,
    },
    income_band_eur: {
      min: raw.income_band_eur?.min ?? null,
      max: raw.income_band_eur?.max ?? null,
    },
    schufa_available: raw.schufa_available,
    viewing_requested: raw.viewing_requested === true,
    questions: Array.isArray(raw.questions) ? raw.questions.slice(0, 5) : [],
    missing_fields: Array.isArray(raw.missing_fields) ? raw.missing_fields : [],
    injection_suspected: raw.injection_suspected === true,
    injection_evidence: raw.injection_evidence ?? null,
    extraction_confidence: raw.extraction_confidence,
  };

  if (!ENUMS.language.includes(lead.language)) errors.push('language');
  if (!ENUMS.inquiry_type.includes(lead.inquiry_type)) errors.push('inquiry_type');
  if (!ENUMS.salutation.includes(lead.contact.salutation)) errors.push('salutation');
  if (!ENUMS.financing_status.includes(lead.financing_status)) errors.push('financing_status');
  if (!ENUMS.horizon.includes(lead.timeline.horizon)) errors.push('horizon');
  if (!ENUMS.schufa_available.includes(lead.schufa_available)) errors.push('schufa');
  if (lead.contact.email != null && !EMAIL_RE.test(String(lead.contact.email))) errors.push('email');
  if (lead.listing.price_eur != null && !isNum(lead.listing.price_eur)) errors.push('price');
  if (lead.budget.amount_max_eur != null && !isNum(lead.budget.amount_max_eur)) errors.push('budget');
  if (lead.equity_eur != null && !isNum(lead.equity_eur)) errors.push('equity');
  if (!isNum(lead.extraction_confidence) || lead.extraction_confidence < 0 || lead.extraction_confidence > 1) {
    errors.push('confidence');
  }
  lead.questions = lead.questions.filter((q) => ENUMS.question.includes(q));
  lead.missing_fields = lead.missing_fields.filter((q) => ENUMS.missing.includes(q));
  if (lead.injection_evidence != null) {
    lead.injection_evidence = String(lead.injection_evidence).slice(0, 200);
  }
  if (lead.contact.email) lead.contact.email = String(lead.contact.email).trim().toLowerCase();
  return { ok: errors.length === 0, errors, lead: errors.length === 0 ? lead : lead };
}

function parseModelJson(content) {
  if (content == null) return { ok: false, error: 'empty' };
  const text = String(content).trim();
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
      } catch {
        return { ok: false, error: 'invalid_json' };
      }
    }
    return { ok: false, error: 'invalid_json' };
  }
}

module.exports = {
  validateExtraction,
  parseModelJson,
  EMAIL_RE,
};
