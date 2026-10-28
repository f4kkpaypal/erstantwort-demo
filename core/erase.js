'use strict';

const { emailHash } = require('./hash');

function wantedEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return '';
  return text;
}

async function collect(target, ids, email) {
  if (!target?.listLeads && !target?.listCards) return;
  const rows = target.listLeads ? await target.listLeads() : await target.listCards();
  for (const row of rows || []) {
    if (!row?.lead_id) continue;
    if (String(row.email || '').trim().toLowerCase() === email) ids.add(row.lead_id);
  }
}

async function eraseSubject(deps, email) {
  const wanted = wantedEmail(email);
  if (!wanted) return { ok: false, error: 'email_required', leads: 0, optout_kept: false };
  const ids = new Set();
  await collect(deps.crm, ids, wanted);
  if (deps.board && deps.board !== deps.crm) await collect(deps.board, ids, wanted);
  if (deps.db && deps.db !== deps.board && deps.db !== deps.crm) await collect(deps.db, ids, wanted);
  const ui = deps.ui?.state;
  if (ui?.leads) {
    for (const lead of ui.leads) {
      if (lead?.lead_id && String(lead.email || '').trim().toLowerCase() === wanted) ids.add(lead.lead_id);
    }
  }
  let leads = 0;
  for (const leadId of ids) {
    if (deps.crm?.deleteLead) await deps.crm.deleteLead(leadId);
    if (deps.db?.deleteLeadOps) await deps.db.deleteLeadOps(leadId);
    if (deps.fragebogen?.revokeLead) deps.fragebogen.revokeLead(leadId);
    if (deps.board?.deleteCard) await deps.board.deleteCard(leadId);
    if (deps.calendar?.deleteForLead) await deps.calendar.deleteForLead(leadId);
    if (ui) {
      ui.leads = ui.leads.filter((lead) => lead.lead_id !== leadId);
      ui.bookings = (ui.bookings || []).filter((row) => row.lead_id !== leadId);
    }
    leads += 1;
  }
  if (deps.db?.addOptout) await deps.db.addOptout(emailHash(wanted, deps.config.HASH_SALT));
  return { ok: true, leads, optout_kept: true };
}

module.exports = { eraseSubject, wantedEmail };
