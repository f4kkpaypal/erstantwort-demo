'use strict';

async function publishState(deps, state) {
  if (!deps.board?.upsertCard || !state?.lead_id) return;
  if (state.outcome === 'DUPLICATE' || state.outcome === 'SKIPPED_NOT_IS24' || state.outcome === 'SKIP_AUTO') return;
  const existing = await deps.board.getCard(state.lead_id);
  if (state.route === 'reply' || state.crm_lead) {
    await publishReply(deps, state, existing);
    return;
  }
  if (!state.lead && !state.lead_row) return;
  const card = cardFromInquiry(state, existing);
  await deps.board.upsertCard(card);
  remember(deps, card);
}

function cardFromInquiry(state, existing) {
  const row = state.lead_row || {};
  const lead = state.lead || {};
  const owner = lead.owner || {};
  const missing = Array.isArray(lead.missing_fields) ? lead.missing_fields : [];
  return {
    ...(existing || {}),
    lead_id: state.lead_id,
    demo: false,
    created_at: row.created_at || existing?.created_at || new Date().toISOString(),
    retention_until: row.retention_until || existing?.retention_until || '',
    first_name: row.first_name || lead.contact?.first_name || '',
    last_name: row.last_name || lead.contact?.last_name || '',
    salutation: row.salutation || lead.contact?.salutation || '',
    email: row.email || lead.contact?.email || '',
    phone: row.phone || lead.contact?.phone || '',
    grade: state.grade || row.grade || '',
    score: state.score ?? row.score ?? '',
    reasons: state.reasons || [],
    signals: state.signals || [],
    listing_title: row.listing_title || lead.listing?.title || '',
    portal_listing_id: row.portal_listing_id || lead.listing?.portal_listing_id || '',
    inquiry_type: row.inquiry_type || lead.inquiry_type || 'unbekannt',
    lead_kind: row.lead_kind || lead.lead_kind || 'interessent',
    reply_status: row.reply_status || '',
    reply_mode: row.reply_mode || '',
    reply_latency_s: row.reply_latency_s ?? '',
    pipeline_status: row.pipeline_status || 'neu',
    missing_fields: missing,
    draft_text: state.mail?.text || existing?.draft_text || '',
    draft_subject: state.mail?.subject || existing?.draft_subject || '',
    offered_slots: Array.isArray(state.slots) && state.slots.length ? state.slots : (existing?.offered_slots || []),
    excerpt: String(state.normalized?.text_clean || existing?.excerpt || '').slice(0, 600),
    needs_human_reason: row.needs_human_reason || '',
    optout: row.optout === true,
    injection_suspected: row.injection_suspected === true || lead.injection_suspected === true,
    send_simulated: false,
    object_type: owner.object_type || existing?.object_type || '',
    object_city: owner.city || existing?.object_city || '',
    object_district: owner.district || existing?.object_district || '',
    area_sqm: owner.area_sqm || existing?.area_sqm || '',
    timeline_horizon: lead.timeline?.horizon || row.timeline_horizon || existing?.timeline_horizon || '',
    valuation_requested: owner.valuation_requested === true,
    source: state.owner_source || existing?.source || '',
  };
}

async function publishReply(deps, state, existing) {
  if (!existing) return;
  const card = { ...existing };
  if (state.outcome === 'OPTOUT') {
    card.optout = true;
    card.needs_human_reason = 'lead_stop';
  }
  let booking = null;
  if (state.outcome === 'TERMIN') {
    const slots = state.matched_outbound?.offered_slots || card.offered_slots || [];
    const slot = slots[(state.slot_index || 1) - 1] || null;
    card.booking_status = 'booked';
    card.booked_slot = slot?.label || card.booked_slot || '';
    card.pipeline_status = 'termin';
    card.reply_status = 'sent';
    card.send_simulated = false;
    card.lead_reply = String(state.normalized?.text_clean || '').slice(0, 280);
    if (slot && state.event_id) {
      booking = {
        id: state.event_id,
        lead_id: state.lead_id,
        slot_start: slot.start,
        slot_end: slot.end,
        portal_listing_id: card.portal_listing_id || '',
        status: 'booked',
        kind: card.lead_kind === 'eigentuemer' ? 'bewertung' : 'besichtigung',
      };
      await deps.board.upsertUiBooking(booking);
    }
  }
  if (state.outcome === 'PENDING_APPROVAL') {
    card.booking_status = 'awaiting_freigabe';
    card.needs_human_reason = 'confirmation_freigabe';
    card.lead_reply = String(state.normalized?.text_clean || '').slice(0, 280);
  }
  if (state.outcome === 'NEEDS_HUMAN' && state.reply_reason) {
    card.needs_human_reason = state.reply_reason;
  }
  await deps.board.upsertCard(card);
  remember(deps, card, booking);
}

function remember(deps, card, booking) {
  const ui = deps.ui?.state;
  if (!ui || !card?.lead_id) return;
  const index = ui.leads.findIndex((lead) => lead.lead_id === card.lead_id);
  if (index === -1) ui.leads.push(card);
  else ui.leads[index] = { ...ui.leads[index], ...card };
  if (!booking) return;
  const found = ui.bookings.findIndex((row) => row.id === booking.id);
  if (found === -1) ui.bookings.push(booking);
  else ui.bookings[found] = booking;
}

module.exports = { publishState, cardFromInquiry };
