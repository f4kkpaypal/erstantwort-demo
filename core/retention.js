'use strict';

async function runRetention(deps, now = new Date()) {
  const iso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const ids = new Set();
  if (deps.board?.expiredCards) {
    for (const card of await deps.board.expiredCards(iso)) {
      if (card?.lead_id) ids.add(card.lead_id);
    }
  }
  if (deps.crm?.listLeads) {
    for (const row of await deps.crm.listLeads()) {
      if (row?.lead_id && row.retention_until && String(row.retention_until) < iso) ids.add(row.lead_id);
    }
  }
  let deleted = 0;
  for (const leadId of ids) {
    if (deps.crm?.deleteLead) await deps.crm.deleteLead(leadId);
    if (deps.db?.deleteLeadOps) await deps.db.deleteLeadOps(leadId);
    if (deps.fragebogen?.revokeLead) deps.fragebogen.revokeLead(leadId);
    if (deps.board?.deleteCard) await deps.board.deleteCard(leadId);
    if (deps.calendar?.deleteForLead) await deps.calendar.deleteForLead(leadId);
    const ui = deps.ui?.state;
    if (ui) {
      ui.leads = ui.leads.filter((lead) => lead.lead_id !== leadId);
      ui.bookings = ui.bookings.filter((row) => row.lead_id !== leadId);
    }
    deleted += 1;
  }
  return { deleted, optout_kept: true };
}

module.exports = { runRetention };
