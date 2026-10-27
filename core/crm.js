'use strict';

const LEAD_COLUMNS = [
  'lead_id', 'created_at', 'source', 'portal_listing_id', 'listing_title', 'inquiry_type', 'lead_kind',
  'salutation', 'first_name', 'last_name', 'email', 'email_hash', 'phone',
  'budget_max_eur', 'equity_ratio_band', 'financing_status', 'income_ok_flag', 'timeline_horizon',
  'viewing_requested', 'score', 'grade', 'reasons', 'missing_fields', 'injection_suspected',
  'reply_mode', 'reply_status', 'first_reply_at', 'reply_latency_s', 'offered_slots', 'repeat_count',
  'last_lead_msg_at', 'followup_sent_at', 'optout', 'needs_human_reason',
  'booking_status', 'booked_slot', 'reminder_sent_at', 'attendance', 'reoffer_sent_at',
  'pipeline_status', 'crm_sync_status', 'retention_until',
];

const OBJEKT_COLUMNS = [
  'portal_listing_id', 'title', 'price_eur', 'kaltmiete_eur', 'warmmiete_eur',
  'stellplatz_text', 'provision_text', 'nebenkosten_hausgeld_text', 'energieausweis_text',
  'verfuegbar_ab_text', 'haustiere_text', 'zustand_text', 'booking_mode', 'group_slots', 'viewing_location',
];

const FUNNEL_COLUMNS = ['day', 'portal_listing_id', 'metric', 'value'];

function emptyLead() {
  const row = {};
  for (const key of LEAD_COLUMNS) row[key] = '';
  return row;
}

function jsonCell(value) {
  if (value == null || value === '') return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function buildLeadRow(fields) {
  const row = emptyLead();
  for (const key of LEAD_COLUMNS) {
    if (fields[key] !== undefined && fields[key] !== null) row[key] = fields[key];
  }
  for (const key of ['reasons', 'missing_fields', 'offered_slots']) {
    if (Array.isArray(fields[key]) || (fields[key] && typeof fields[key] === 'object')) {
      row[key] = jsonCell(fields[key]);
    }
  }
  delete row.income_band_eur;
  delete row.income_min_eur;
  delete row.schufa_available;
  delete row.body;
  return row;
}

function contractOk(action, externalIds) {
  return { ok: true, action, external_ids: externalIds || {}, error: null };
}

function sheetProjection(row, includeContact) {
  const copy = { ...row };
  if (!includeContact) {
    copy.email = '';
    copy.phone = '';
  }
  return copy;
}

function contractError(code, retryable, message) {
  return { ok: false, action: null, external_ids: {}, error: { code, retryable, message } };
}

function propstackDriver() {
  const error = () => contractError(
    'NOT_IMPLEMENTED',
    false,
    'Propstack is not implemented. This build has no Propstack API client.',
  );
  return {
    target: 'propstack',
    async upsertLead() { return error(); },
    async updateStatus() { return error(); },
    async findByEmail() { return error(); },
    async findByLeadId() { return error(); },
  };
}

class MemoryCrm {
  constructor() {
    this.rows = new Map();
  }

  async upsertLead(row) {
    const existing = this.rows.has(row.lead_id);
    this.rows.set(row.lead_id, { ...row });
    return contractOk(existing ? 'updated' : 'created', { row_number: this.rows.size, contact_id: row.lead_id });
  }

  async updateStatus(leadId, patch) {
    const row = this.rows.get(leadId);
    if (!row) return contractError('NOT_FOUND', false, 'lead_not_found');
    this.rows.set(leadId, buildLeadRow({ ...row, ...patch, lead_id: leadId }));
    return contractOk('updated', { contact_id: leadId });
  }

  async findByEmail(email) {
    const wanted = String(email || '').toLowerCase();
    for (const row of this.rows.values()) {
      if (String(row.email).toLowerCase() === wanted) return { ok: true, lead: row };
    }
    return { ok: true, lead: null };
  }

  async findByLeadId(leadId) {
    return { ok: true, lead: this.rows.get(leadId) || null };
  }

  async deleteLead(leadId) {
    return this.rows.delete(leadId);
  }

  async listLeads() {
    return [...this.rows.values()];
  }

  async reset() {
    this.rows.clear();
  }
}

module.exports = {
  LEAD_COLUMNS,
  OBJEKT_COLUMNS,
  FUNNEL_COLUMNS,
  buildLeadRow,
  contractOk,
  contractError,
  propstackDriver,
  MemoryCrm,
  sheetProjection,
};
