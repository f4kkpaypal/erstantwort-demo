'use strict';

const { DateTime } = require('luxon');
const { normalizeInbound } = require('./normalize');
const { parsePortalPayload } = require('./portals');
const { matchOwnerSource, parseOwnerMail } = require('./ownerLead');
const { publishState } = require('./publish');
const { parseAnfrage, applyPortalFacts } = require('./anfrage');
const { buildExtractRequest, buildReplyRequest, whitelistReplyInput } = require('./prompts');
const { parseModelJson, validateExtraction } = require('./validate');
const { scoreLead } = require('./score');
const { pickSlots, slotConflicts } = require('./slots');
const {
  composeFirstReply,
  composeOwnerReply,
  composeOwnerConfirmation,
  composeConfirmation,
  decideSend,
  recipientAllowed,
  paragraphsOk,
  paragraphsConsistent,
  stripEnglishLine,
  anrede,
} = require('./template');
const { classifyReply, leadIdFromSubject } = require('./reply');
const { emailHash } = require('./hash');
const { makeMessageId } = require('./messageId');
const { buildLeadRow } = require('./crm');
const {
  notifyNewLead,
  notifyFreigabe,
  notifyBooked,
  notifyStop,
  notifyNeedsHuman,
  notifySlotBusy,
} = require('./telegram');
const { findPii, collectSecrets, redactMeta } = require('./redact');

const PORTAL_RECIPIENT_DOMAINS = ['immobilienscout24.de'];

function domainOf(address) {
  return String(address || '').trim().toLowerCase().split('@')[1] || '';
}

function domainIn(domain, domains) {
  return (domains || []).some((item) => domain === item || domain.endsWith(`.${item}`));
}

function senderDomainAllowed(from, domains) {
  const domain = domainOf(from);
  return Boolean(domain) && domainIn(domain, domains);
}

function trustedRecipient(normalized) {
  let xmlEmail = '';
  if (normalized?.xml_raw) {
    const parsed = parsePortalPayload({ xml: normalized.xml_raw });
    if (parsed.ok && parsed.fields?.email) xmlEmail = String(parsed.fields.email).trim().toLowerCase();
  }
  const reply = String(normalized?.reply_to || '').trim().toLowerCase();
  const candidate = xmlEmail || reply;
  const domain = domainOf(candidate);
  if (!candidate || !domain || domainIn(domain, PORTAL_RECIPIENT_DOMAINS)) return '';
  return candidate;
}

function ownAddresses(deps) {
  const from = deps.config.MAKLER_PROFILE.from_email || deps.config.SMTP_USER || '';
  return [from, deps.config.IMAP_USER].filter(Boolean);
}

function nowDate(deps) {
  return deps.clock ? deps.clock() : new Date();
}

function berlin(deps) {
  return DateTime.fromJSDate(nowDate(deps), { zone: deps.config.GENERIC_TIMEZONE || 'Europe/Berlin' });
}

function findObjekt(objekte, listingId) {
  if (!listingId) return null;
  return (objekte || []).find((row) => String(row.portal_listing_id) === String(listingId)) || null;
}

async function emit(deps, event) {
  if (deps.db?.logEvent) await deps.db.logEvent(event);
  if (deps.log) {
    const { names, ...rest } = event;
    await deps.log({
      ...rest,
      meta: redactMeta(rest.meta || {}, names || []),
    });
  }
}

async function stepNormalize(body, deps) {
  const source = body?.normalized ? body : (body?.imap || body);
  const normalized = body?.normalized || normalizeInbound(source, { ownAddresses: ownAddresses(deps) });
  return {
    normalized,
    halt: false,
    route: null,
    outcome: null,
    fixture: normalized.fixture || body?.fixture || '',
  };
}

async function detectReply(normalized, deps) {
  if (normalized.in_reply_to_hash) {
    const row = await deps.db.findOutboundByHash(normalized.in_reply_to_hash);
    if (row) return { via: 'in_reply_to', outbound: row, lead_id: row.lead_id };
  }
  const leadId = leadIdFromSubject(normalized.subject);
  if (leadId) {
    const row = await deps.db.findLatestOutbound(leadId, 'first_reply');
    if (row) return { via: 'subject', outbound: row, lead_id: leadId };
    return { via: 'subject', outbound: null, lead_id: leadId };
  }
  return null;
}

async function stepDedup(state, deps) {
  const normalized = state.normalized;
  if (!normalized?.message_id_hash) {
    return { ...state, halt: true, route: 'halt', outcome: 'MISSING_MESSAGE_ID' };
  }
  if (normalized.skip_auto) {
    await deps.db.claimMessage({
      messageIdHash: normalized.message_id_hash,
      contentHash: normalized.content_hash,
    });
    await deps.db.finishMessage({
      messageIdHash: normalized.message_id_hash,
      outcome: 'SKIP_AUTO',
      status: 'done',
    });
    await emit(deps, {
      workflow: 'WF-01',
      step: 'N03',
      event_code: 'SKIP_AUTO',
      message_id_hash: normalized.message_id_hash,
      status: 'done',
    });
    return { ...state, halt: true, route: 'halt', outcome: 'SKIP_AUTO' };
  }
  const inserted = await deps.db.claimMessage({
    messageIdHash: normalized.message_id_hash,
    contentHash: normalized.content_hash,
  });
  if (!inserted) {
    await emit(deps, {
      workflow: 'WF-01',
      step: 'N03',
      event_code: 'DUPLICATE',
      message_id_hash: normalized.message_id_hash,
      status: 'done',
    });
    return { ...state, halt: true, route: 'halt', outcome: 'DUPLICATE' };
  }
  const reply = await detectReply(normalized, deps);
  return {
    ...state,
    halt: false,
    route: reply ? 'reply' : 'inquiry',
    reply_match: reply,
    outcome: null,
  };
}

function portalContext(normalized, deps) {
  const parsed = normalized.xml_raw
    ? parsePortalPayload({ xml: normalized.xml_raw })
    : { ok: false, code: 'NO_PORTAL_XML', fields: null, portal: null };
  const facts = parseAnfrage(parsed.fields?.anfrage || normalized.text_clean, nowDate(deps), deps.config.GENERIC_TIMEZONE);
  return { parsed, facts };
}

async function stopUnthreaded(state, deps) {
  const from = String(state.normalized.from || '').trim().toLowerCase();
  const portalSender = senderDomainAllowed(from, deps.config.ALLOWED_SENDER_DOMAINS);
  const email = portalSender ? trustedRecipient(state.normalized) : from;
  const text = notifyStop({ leadId: 'unbekannt' });
  if (!email || senderDomainAllowed(email, deps.config.ALLOWED_SENDER_DOMAINS)) {
    await deps.telegram.send(text);
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text, sent: false, reply_reason: 'stop_without_address' };
  }
  await deps.db.addOptout(emailHash(email, deps.config.HASH_SALT));
  await deps.telegram.send(text);
  await finish(deps, state, 'OPTOUT', 'done');
  await emit(deps, {
    workflow: 'WF-01',
    step: 'N06',
    event_code: 'OPTOUT',
    message_id_hash: state.normalized.message_id_hash,
    status: 'done',
  });
  return { ...state, halt: true, outcome: 'OPTOUT', telegram_text: text, sent: false };
}

async function stepExtract(state, deps) {
  if (state.halt) return state;
  if (state.route !== 'inquiry') return state;
  if (classifyReply(state.normalized.text_clean).action === 'stop') {
    return stopUnthreaded(state, deps);
  }
  const ownerSources = deps.config.OWNER_LEADS_ENABLED ? deps.config.OWNER_LEAD_SOURCES : [];
  const ownerHit = matchOwnerSource(state.normalized.from, ownerSources);
  if (!ownerHit && !senderDomainAllowed(state.normalized.from, deps.config.ALLOWED_SENDER_DOMAINS)) {
    await finish(deps, state, 'SKIPPED_NOT_IS24', 'done');
    await emit(deps, {
      workflow: 'WF-01',
      step: 'N06',
      event_code: 'SKIPPED_NOT_IS24',
      message_id_hash: state.normalized.message_id_hash,
      status: 'done',
    });
    return { ...state, halt: true, outcome: 'SKIPPED_NOT_IS24' };
  }
  if (deps.config.REQUIRE_DKIM_PASS && !state.normalized.dkim_pass) {
    await finish(deps, state, 'SKIPPED_DKIM', 'done');
    await emit(deps, {
      workflow: 'WF-01',
      step: 'N06',
      event_code: 'SKIPPED_DKIM',
      message_id_hash: state.normalized.message_id_hash,
      status: 'done',
    });
    return { ...state, halt: true, outcome: 'SKIPPED_DKIM' };
  }
  const trusted = trustedRecipient(state.normalized);
  if (!trusted) {
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    const text = notifyNeedsHuman({ reason: 'Kontakt ungültig' });
    await deps.telegram.send(text);
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text, sent: false };
  }
  if (ownerHit) return acceptOwnerLead(state, deps, ownerHit, trusted);
  const { parsed, facts } = portalContext(state.normalized, deps);
  if (parsed.portal === 'immowelt' || parsed.code === 'NOT_IMPLEMENTED') {
    await finish(deps, state, 'PORTAL_OUT_OF_SCOPE', 'done');
    return {
      ...state,
      halt: true,
      outcome: 'PORTAL_OUT_OF_SCOPE',
      portal: parsed,
      telegram_text: 'Portal nicht unterstützt · nur ImmoScout24',
    };
  }
  const earlyEmail = parsed.fields?.email || '';
  if (earlyEmail && await deps.db.isOptout(emailHash(earlyEmail, deps.config.HASH_SALT))) {
    await finish(deps, state, 'OPTOUT', 'done');
    const text = notifyStop({ leadId: 'bekannt', listingId: parsed.fields?.portal_listing_id });
    await deps.telegram.send(text);
    return { ...state, halt: true, outcome: 'OPTOUT', telegram_text: text, portal: parsed };
  }
  const today = berlin(deps).toISODate();
  const request = buildExtractRequest({
    today,
    subject: state.normalized.subject,
    textClean: state.normalized.text_clean,
    xmlFieldsJson: parsed.ok ? parsed.fields : null,
    model: deps.config.LLM_MODEL_EXTRACT,
    schemaMode: deps.config.LLM_SCHEMA_MODE,
  });
  let llm;
  try {
    llm = await deps.llm(request);
  } catch {
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    const text = notifyNeedsHuman({ listingId: parsed.fields?.portal_listing_id, reason: 'Modell nicht erreichbar' });
    await deps.telegram.send(text);
    await emit(deps, {
      workflow: 'WF-01',
      step: 'N06',
      event_code: 'LLM_ERROR',
      message_id_hash: state.normalized.message_id_hash,
      status: 'error',
    });
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text };
  }
  const parsedJson = parseModelJson(llm?.content);
  let validation = parsedJson.ok ? validateExtraction(parsedJson.value) : { ok: false, errors: ['invalid_json'], lead: null };
  if (!validation.ok && deps.llmRetry !== false) {
    const second = await deps.llm(request);
    const again = parseModelJson(second?.content);
    if (again.ok) validation = validateExtraction(again.value);
  }
  if (!validation.lead) {
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    const text = notifyNeedsHuman({ reason: 'Extraktion ungültig' });
    await deps.telegram.send(text);
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text, portal: parsed };
  }
  const merged = applyPortalFacts(validation.lead, parsed.ok ? parsed.fields : null, facts);
  merged.contact = merged.contact || {};
  merged.contact.email = trusted;
  const recheck = validateExtraction(merged);
  const lead = recheck.lead || merged;
  if (lead.contact) lead.contact.email = trusted;
  if (!recheck.ok || !lead.contact?.email) {
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    const text = notifyNeedsHuman({ listingId: lead.listing?.portal_listing_id, reason: 'Kontakt ungültig' });
    await deps.telegram.send(text);
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', lead: publicLead(lead), telegram_text: text };
  }
  if (lead.is_real_estate_inquiry === false) {
    await finish(deps, state, 'SKIPPED_NOT_INQUIRY', 'done');
    return { ...state, halt: true, outcome: 'SKIPPED_NOT_INQUIRY', lead: publicLead(lead) };
  }
  if (lead.language === 'other') {
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    const text = notifyNeedsHuman({ listingId: lead.listing?.portal_listing_id, reason: 'Sprache' });
    await deps.telegram.send(text);
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', lead: publicLead(lead), telegram_text: text };
  }
  return {
    ...state,
    lead: publicLead(lead),
    portal: { code: parsed.code, portal: parsed.portal, listing_id: parsed.fields?.portal_listing_id || null },
    llm_model: llm?.model || null,
    tokens_in: llm?.tokens_in || null,
    tokens_out: llm?.tokens_out || null,
    extract_request_name: request.response_format.json_schema.name,
    trusted_email: trusted,
  };
}

async function acceptOwnerLead(state, deps, ownerHit, trusted) {
  const parsed = parseOwnerMail({
    source: ownerHit.id,
    text: state.normalized.text_clean,
    html: state.normalized.text_html,
  });
  if (!parsed.ok) {
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    const text = notifyNeedsHuman({ reason: 'Eigentümer-Lead nicht erkannt' });
    await deps.telegram.send(text);
    await emit(deps, {
      workflow: 'WF-01',
      step: 'N06',
      event_code: 'OWNER_LEAD_UNRECOGNIZED',
      message_id_hash: state.normalized.message_id_hash,
      status: 'done',
      meta: { source: ownerHit.id, message: parsed.message },
    });
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text, sent: false, owner_source: ownerHit.id };
  }
  if (await deps.db.isOptout(emailHash(trusted, deps.config.HASH_SALT))) {
    await finish(deps, state, 'OPTOUT', 'done');
    const text = notifyStop({ leadId: 'bekannt' });
    await deps.telegram.send(text);
    return { ...state, halt: true, outcome: 'OPTOUT', telegram_text: text, owner_source: ownerHit.id };
  }
  const fields = parsed.fields;
  const lead = {
    is_real_estate_inquiry: true,
    language: 'de',
    inquiry_type: 'unbekannt',
    lead_kind: 'eigentuemer',
    listing: { portal_listing_id: null, title: fields.title, price_eur: null },
    contact: {
      salutation: fields.salutation,
      first_name: fields.first_name || null,
      last_name: fields.last_name || null,
      email: trusted,
      phone: fields.phone || null,
    },
    budget: { amount_max_eur: null, raw_text: null },
    equity_eur: null,
    financing_status: 'unbekannt',
    timeline: { target_date: null, horizon: fields.timeline_horizon },
    schufa_available: 'unbekannt',
    viewing_requested: false,
    questions: [],
    missing_fields: [],
    injection_suspected: false,
    extraction_confidence: 1,
    owner: {
      object_type: fields.object_type,
      city: fields.city,
      district: fields.district,
      area_sqm: fields.area_sqm,
      valuation_requested: fields.valuation_requested,
    },
  };
  if (!fields.timeline_horizon || fields.timeline_horizon === 'unbekannt') lead.missing_fields.push('timeline');
  if (!fields.object_type || fields.object_type === 'unbekannt') lead.missing_fields.push('object_type');
  if (!fields.area_sqm) lead.missing_fields.push('area');
  if (!fields.city && !fields.district) lead.missing_fields.push('district');
  if (!fields.phone) lead.missing_fields.push('phone');
  return {
    ...state,
    lead: publicLead(lead),
    portal: { code: 'OWNER_LEAD', portal: ownerHit.id, listing_id: null },
    owner_source: ownerHit.id,
    trusted_email: trusted,
    assumption: true,
  };
}

function publicLead(lead) {
  const copy = structuredClone(lead);
  delete copy.injection_evidence;
  return copy;
}

async function stepScore(state, deps) {
  if (state.halt || state.route !== 'inquiry') return state;
  const lead = state.lead;
  const objekt = findObjekt(deps.objekte, lead.listing?.portal_listing_id);
  const scored = scoreLead({
    inquiry_type: lead.inquiry_type,
    financing_status: lead.financing_status,
    budget_max_eur: lead.budget?.amount_max_eur,
    price_eur: lead.listing?.price_eur ?? objekt?.price_eur,
    warmmiete_eur: objekt?.warmmiete_eur,
    kaltmiete_eur: objekt?.kaltmiete_eur,
    equity_eur: lead.equity_eur,
    income_min_eur: lead.income_band_eur?.min,
    schufa_available: lead.schufa_available,
    timeline_horizon: lead.timeline?.horizon,
    viewing_requested: lead.viewing_requested,
    phone: lead.contact?.phone,
    questions: lead.questions,
    missing_fields: lead.missing_fields,
    injection_suspected: lead.injection_suspected,
    lead_kind: lead.lead_kind,
    object_type: lead.owner?.object_type,
    city: lead.owner?.city,
    district: lead.owner?.district,
    area_sqm: lead.owner?.area_sqm,
    valuation_requested: lead.owner?.valuation_requested === true,
  });
  const leadId = await deps.db.nextLeadId(berlin(deps).toISODate());
  delete lead.income_band_eur;
  return {
    ...state,
    lead,
    lead_id: leadId,
    score: scored.score,
    grade: scored.grade,
    reasons: scored.reasons,
    questions_to_ask: scored.questions_to_ask,
    equity_ratio_band: scored.equity_ratio_band,
    income_ok_flag: scored.income_ok_flag,
    signals: scored.signals,
    objekt_id: objekt?.portal_listing_id || null,
  };
}

async function stepBusy(state, deps) {
  if (state.halt || state.route !== 'inquiry') return state;
  const zone = deps.config.SLOT_RULES.tz;
  const start = berlin(deps).startOf('day').plus({ days: deps.config.SLOT_RULES.days[0] });
  const end = berlin(deps).startOf('day').plus({ days: deps.config.SLOT_RULES.days[1] + 1 });
  const busy = await deps.calendar.getBusy({
    start: start.toUTC().toISO(),
    end: end.toUTC().toISO(),
    tz: zone,
  });
  return { ...state, busy: busy || [] };
}

async function stepSlots(state, deps) {
  if (state.halt || state.route !== 'inquiry') return state;
  const slots = pickSlots({
    now: nowDate(deps),
    busy: state.busy || [],
    rules: deps.config.SLOT_RULES,
    count: 3,
  });
  return { ...state, slots };
}

async function stepCompose(state, deps) {
  if (state.halt || state.route !== 'inquiry') return state;
  const lead = state.lead;
  if (lead.lead_kind === 'eigentuemer') return composeOwnerState(state, deps);
  const objekt = findObjekt(deps.objekte, lead.listing?.portal_listing_id);
  const makler = deps.config.MAKLER_PROFILE;
  const mode = objekt?.booking_mode || 'individual';
  const replyInput = whitelistReplyInput({
    anrede: anrede(lead.contact),
    listing_title: lead.listing?.title || objekt?.title || 'Ihr Objekt',
    inquiry_type: lead.inquiry_type,
    questions: lead.questions || [],
    answered_topics: [],
    questions_to_ask: state.questions_to_ask || [],
    slots_count: mode === 'individual' ? (state.slots || []).length : 0,
    language: lead.language,
  });
  const factsAnswered = (lead.questions || []).filter((topic) => {
    const field = {
      stellplatz: 'stellplatz_text',
      provision: 'provision_text',
      nebenkosten_hausgeld: 'nebenkosten_hausgeld_text',
      energieausweis: 'energieausweis_text',
      verfuegbarkeit: 'verfuegbar_ab_text',
      haustiere: 'haustiere_text',
      zustand_renovierung: 'zustand_text',
    }[topic];
    return field && objekt && String(objekt[field] || '').trim();
  });
  replyInput.answered_topics = factsAnswered;
  const request = buildReplyRequest({
    bueroName: makler.buero,
    replyInput,
    model: deps.config.LLM_MODEL_WRITE,
    schemaMode: deps.config.LLM_SCHEMA_MODE,
  });
  let paragraphs = null;
  let usedFallback = false;
  let llm = null;
  try {
    llm = await deps.llm(request);
  } catch {
    usedFallback = true;
  }
  const parsed = llm ? parseModelJson(llm.content) : { ok: false };
  const offerEnglish = lead.language === 'en' || deps.config.OFFER_ENGLISH_REPLY === true;
  let candidate = parsed.ok ? parsed.value?.paragraphs : null;
  if (Array.isArray(candidate) && !offerEnglish) candidate = stripEnglishLine(candidate);
  if (!parsed.ok || !paragraphsOk(candidate) || !paragraphsConsistent(candidate, objekt)) {
    usedFallback = true;
    paragraphs = null;
  } else {
    paragraphs = candidate;
  }
  let fragebogenUrl = '';
  if (deps.config.FRAGEBOGEN_ENABLED && deps.fragebogen?.issue && state.lead_id) {
    const issued = await deps.fragebogen.issue({
      leadId: state.lead_id,
      email: lead.contact?.email,
      listingId: lead.listing?.portal_listing_id,
    });
    fragebogenUrl = issued?.url || '';
  }
  const mail = composeFirstReply({
    lead: { ...lead, questions_to_ask: state.questions_to_ask },
    objekt,
    slots: state.slots || [],
    paragraphs,
    makler,
    leadId: state.lead_id,
    usedFallback,
    offerEnglish,
    fragebogenUrl,
  });
  return { ...state, mail, reply_input: replyInput, used_fallback: mail.used_fallback };
}

async function composeOwnerState(state, deps) {
  const lead = state.lead;
  const makler = deps.config.MAKLER_PROFILE;
  let fragebogenUrl = '';
  if (deps.config.FRAGEBOGEN_ENABLED && deps.fragebogen?.issue && state.lead_id) {
    const issued = await deps.fragebogen.issue({
      leadId: state.lead_id,
      email: lead.contact?.email,
      listingId: lead.listing?.portal_listing_id,
    });
    fragebogenUrl = issued?.url || '';
  }
  const mail = composeOwnerReply({
    lead,
    slots: state.slots || [],
    makler,
    leadId: state.lead_id,
    fragebogenUrl,
  });
  return { ...state, mail, used_fallback: false };
}

async function stepSend(state, deps) {
  if (state.halt || state.route !== 'inquiry') return state;
  const lead = state.lead;
  const hash = emailHash(lead.contact.email, deps.config.HASH_SALT);
  const opted = await deps.db.isOptout(hash);
  const decision = decideSend({ kind: 'first_reply', config: deps.config, optout: opted });
  const trusted = trustedRecipient(state.normalized);
  const to = lead.contact.email;
  const allowed = recipientAllowed({
    leadEmail: trusted,
    proposedTo: to,
    relayDomains: deps.config.ALLOWED_RECIPIENT_RELAY_DOMAINS,
  });
  if (!allowed) {
    await finish(deps, state, 'BLOCKED_RECIPIENT', 'done');
    return { ...state, halt: true, outcome: 'BLOCKED_RECIPIENT', sent: false };
  }
  const hourAgo = new Date(nowDate(deps).getTime() - 60 * 60 * 1000).toISOString();
  const sentCount = await deps.db.countSentSince(hourAgo);
  if (decision.ok && sentCount >= deps.config.MAX_REPLIES_PER_HOUR) {
    decision.ok = false;
    decision.reason = 'rate_limited';
  }
  const created = berlin(deps);
  const leadRowBase = leadRowFromState(state, deps, {
    reply_status: replyStatusFor(decision),
    optout: opted,
    pipeline_status: decision.ok ? 'kontaktiert' : 'neu',
    first_reply_at: decision.ok ? created.toISO() : '',
    reply_latency_s: decision.ok ? latencySeconds(state.normalized.date, created) : '',
  });
  if (!decision.ok) {
    const telegram_text = decision.reason === 'awaiting_freigabe'
      ? notifyFreigabe({
        leadId: state.lead_id,
        grade: state.grade,
        listingId: lead.listing?.portal_listing_id,
        kind: lead.lead_kind,
      })
      : notifyNeedsHuman({ leadId: state.lead_id, listingId: lead.listing?.portal_listing_id, reason: decision.reason });
    if (decision.reason !== 'optout') await deps.telegram.send(telegram_text);
    await finish(deps, state, decision.reason === 'awaiting_freigabe' ? 'PENDING_APPROVAL' : decision.reason.toUpperCase(), 'done');
    await emit(deps, {
      workflow: 'WF-01',
      step: 'N19',
      event_code: decision.reason,
      lead_id: state.lead_id,
      grade: state.grade,
      message_id_hash: state.normalized.message_id_hash,
      status: 'done',
      names: collectSecrets(lead),
    });
    return {
      ...state,
      sent: false,
      outcome: decision.reason === 'awaiting_freigabe' ? 'PENDING_APPROVAL' : decision.reason.toUpperCase(),
      telegram_text,
      lead_row: leadRowBase,
      approval_timeout_action: decision.approval_timeout_action || deps.config.APPROVAL_TIMEOUT_ACTION,
    };
  }
  const domain = deps.config.MAIL_DOMAIN || (deps.config.MAKLER_PROFILE.from_email || '').split('@')[1] || 'localhost';
  const mid = makeMessageId({ leadId: state.lead_id, domain, clock: () => nowDate(deps) });
  const fromEmail = deps.config.MAKLER_PROFILE.from_email || deps.config.SMTP_USER;
  await deps.mail.send({
    from: fromNameAddress(deps),
    to: trusted,
    subject: state.mail.subject,
    text: state.mail.text,
    messageId: mid.messageId,
    inReplyTo: state.normalized.message_id || undefined,
    references: state.normalized.message_id || undefined,
    headers: {
      'X-AI-Generated': 'true',
      'Auto-Submitted': 'auto-generated',
    },
  });
  await deps.db.insertOutbound({
    sent_message_id_hash: mid.hash,
    lead_id: state.lead_id,
    kind: 'first_reply',
    offered_slots: state.slots || [],
    sent_at: created.toISO(),
    rfc_message_id: mid.messageId,
  });
  await emit(deps, {
    workflow: 'WF-01',
    step: 'N19',
    event_code: 'SENT',
    lead_id: state.lead_id,
    grade: state.grade,
    message_id_hash: state.normalized.message_id_hash,
    status: 'done',
    meta: { slot_count: (state.slots || []).length },
    names: collectSecrets(lead),
  });
  return {
    ...state,
    sent: true,
    outcome: 'SENT',
    message_id: mid.messageId,
    message_id_hash_out: mid.hash,
    lead_row: leadRowBase,
    from_email: fromEmail,
  };
}

function replyStatusFor(decision) {
  if (decision.ok) return 'sent';
  if (decision.reason === 'awaiting_freigabe') return 'pending_approval';
  if (decision.reason === 'rate_limited') return 'rate_limited';
  if (decision.reason === 'optout') return '';
  return 'needs_human';
}

function fromNameAddress(deps) {
  const profile = deps.config.MAKLER_PROFILE;
  const email = profile.from_email || deps.config.SMTP_USER || 'makler@localhost';
  const name = profile.from_name || profile.name || '';
  return name ? `${name} <${email}>` : email;
}

function latencySeconds(inboundIso, sent) {
  if (!inboundIso) return '';
  const start = Date.parse(inboundIso);
  if (!Number.isFinite(start)) return '';
  return Math.max(0, Math.round((sent.toMillis() - start) / 1000));
}

function leadRowFromState(state, deps, extra) {
  const lead = state.lead;
  const created = berlin(deps);
  const retention = created.plus({ days: deps.config.RETENTION_DAYS_LEAD }).toISO();
  return buildLeadRow({
    lead_id: state.lead_id,
    created_at: created.toISO(),
    source: state.owner_source || 'immoscout24',
    portal_listing_id: lead.listing?.portal_listing_id || '',
    listing_title: lead.listing?.title || '',
    inquiry_type: lead.inquiry_type || 'unbekannt',
    lead_kind: lead.lead_kind === 'eigentuemer' ? 'eigentuemer' : 'interessent',
    salutation: lead.contact?.salutation || '',
    first_name: lead.contact?.first_name || '',
    last_name: lead.contact?.last_name || '',
    email: lead.contact?.email || '',
    email_hash: emailHash(lead.contact?.email, deps.config.HASH_SALT),
    phone: lead.contact?.phone || '',
    budget_max_eur: lead.budget?.amount_max_eur ?? '',
    equity_ratio_band: state.equity_ratio_band || 'unbekannt',
    financing_status: lead.financing_status || '',
    income_ok_flag: state.income_ok_flag === null || state.income_ok_flag === undefined ? '' : state.income_ok_flag,
    timeline_horizon: lead.timeline?.horizon || '',
    viewing_requested: lead.viewing_requested === true,
    score: state.score,
    grade: state.grade,
    reasons: state.reasons || [],
    missing_fields: lead.missing_fields || [],
    injection_suspected: lead.injection_suspected === true,
    reply_mode: deps.config.SEND_MODE,
    reply_status: extra.reply_status || '',
    first_reply_at: extra.first_reply_at || '',
    reply_latency_s: extra.reply_latency_s ?? '',
    offered_slots: (state.slots || []).map((slot) => slot.label),
    repeat_count: 0,
    last_lead_msg_at: state.normalized?.date || created.toISO(),
    followup_sent_at: '',
    optout: extra.optout === true,
    needs_human_reason: extra.needs_human_reason || '',
    booking_status: extra.booking_status || 'none',
    booked_slot: extra.booked_slot || '',
    reminder_sent_at: '',
    attendance: extra.attendance || '',
    reoffer_sent_at: '',
    pipeline_status: extra.pipeline_status || 'neu',
    crm_sync_status: 'pending',
    retention_until: retention,
  });
}

async function stepCrm(state, deps) {
  if (state.halt && !state.lead_row) return state;
  if (!state.lead_row) return state;
  const row = { ...state.lead_row };
  try {
    const result = await deps.crm.upsertLead(row);
    row.crm_sync_status = result.ok ? 'ok' : 'error';
    if (!result.ok) {
      await deps.db.enqueueCrm({
        idempotency_key: `${row.lead_id}:upsert_lead`,
        payload: { op: 'upsert_lead', lead_id: row.lead_id },
      });
    } else if (row.email_hash && row.portal_listing_id) {
      await deps.db.addClaim({
        emailHashValue: row.email_hash,
        portalListingId: row.portal_listing_id,
        leadId: row.lead_id,
      });
    }
    return { ...state, lead_row: row, crm: result };
  } catch {
    row.crm_sync_status = 'error';
    await deps.db.enqueueCrm({
      idempotency_key: `${row.lead_id}:upsert_lead`,
      payload: { op: 'upsert_lead', lead_id: row.lead_id },
    });
    await emit(deps, {
      workflow: 'WF-02',
      step: 'upsert',
      event_code: 'CRM_ERROR',
      lead_id: row.lead_id,
      status: 'error',
    });
    return { ...state, lead_row: row, crm: { ok: false, error: { code: 'UNKNOWN', retryable: true, message: 'crm_failed' } } };
  }
}

async function stepTelegram(state, deps) {
  if (state.route !== 'inquiry') return state;
  if (state.telegram_text && state.outcome !== 'SENT' && state.outcome !== 'PENDING_APPROVAL') {
    return state;
  }
  if (!state.lead_id) return state;
  let text = state.telegram_text;
  if (state.outcome === 'SENT' || state.sent) {
    text = notifyNewLead({
      leadId: state.lead_id,
      grade: state.grade,
      score: state.score,
      listingId: state.lead?.listing?.portal_listing_id,
      makler: deps.config.MAKLER_PROFILE,
      attachment: state.normalized?.has_other_attachment,
      kind: state.lead?.lead_kind,
    });
    await deps.telegram.send(text);
  }
  await finish(deps, state, state.outcome || 'DONE', 'done');
  return { ...state, telegram_text: text || state.telegram_text || '' };
}

async function finish(deps, state, outcome, status) {
  if (!state?.normalized?.message_id_hash) return;
  await deps.db.finishMessage({
    messageIdHash: state.normalized.message_id_hash,
    leadId: state.lead_id || null,
    outcome,
    status,
  });
}

async function runInquiry(state, deps) {
  let current = await stepExtract(state, deps);
  if (current.halt) return current;
  current = await stepScore(current, deps);
  current = await stepBusy(current, deps);
  current = await stepSlots(current, deps);
  current = await stepCompose(current, deps);
  current = await stepSend(current, deps);
  current = await stepCrm(current, deps);
  current = await stepTelegram(current, deps);
  assertSafeSideEffects(current, deps);
  return current;
}

function assertSafeSideEffects(state, deps) {
  const secrets = collectSecrets(state.lead || {});
  const blobs = [state.telegram_text || ''];
  if (state.event_title) blobs.push(state.event_title);
  if (state.event_description) blobs.push(state.event_description);
  for (const blob of blobs) {
    const hits = findPii(blob, secrets);
    if (hits.length) {
      const err = new Error('pii_in_side_effect');
      err.hits = hits;
      throw err;
    }
  }
  if (deps.telegram?.messages) {
    for (const msg of deps.telegram.messages) {
      const hits = findPii(msg, secrets);
      if (hits.length) {
        const err = new Error('pii_in_telegram');
        err.hits = hits;
        throw err;
      }
    }
  }
}

async function stepReplyMatch(state, deps) {
  if (state.halt) return state;
  const match = state.reply_match || await detectReply(state.normalized, deps);
  if (!match?.lead_id) {
    const text = notifyNeedsHuman({ reason: 'Antwort ohne Zuordnung' });
    await deps.telegram.send(text);
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text };
  }
  const crm = await deps.crm.findByLeadId(match.lead_id);
  let lead = crm?.lead;
  if (lead && !lead.email && deps.board?.getCard) {
    const card = await deps.board.getCard(match.lead_id);
    if (card?.email) lead = { ...lead, email: card.email, phone: lead.phone || card.phone || '' };
  }
  if (!lead) {
    const text = notifyNeedsHuman({ leadId: match.lead_id, reason: 'Lead nicht im CRM' });
    await deps.telegram.send(text);
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text, lead_id: match.lead_id };
  }
  const fromHash = emailHash(state.normalized.from, deps.config.HASH_SALT);
  if (!lead.email_hash || fromHash !== lead.email_hash) {
    const text = notifyNeedsHuman({
      leadId: match.lead_id,
      listingId: lead.portal_listing_id,
      reason: 'Absender passt nicht',
    });
    await deps.telegram.send(text);
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    return {
      ...state,
      halt: true,
      outcome: 'NEEDS_HUMAN',
      telegram_text: text,
      lead_id: match.lead_id,
      reply_reason: 'sender_mismatch',
      sent: false,
    };
  }
  const outbound = match.outbound || await deps.db.findLatestOutbound(match.lead_id, 'first_reply');
  return { ...state, lead_id: match.lead_id, crm_lead: lead, matched_outbound: outbound, match_via: match.via };
}

async function stepReplyClassify(state, deps) {
  if (state.halt || state.route !== 'reply') return state;
  const action = classifyReply(state.normalized.text_clean);
  return { ...state, reply_action: action.action, slot_index: action.slot_index || null, reply_reason: action.reason };
}

async function stepReplyStop(state, deps) {
  if (state.reply_action !== 'stop') return state;
  const email = state.crm_lead?.email;
  const hash = emailHash(email, deps.config.HASH_SALT);
  await deps.db.addOptout(hash);
  await deps.crm.updateStatus(state.lead_id, { optout: true, needs_human_reason: 'optout' });
  const text = notifyStop({
    leadId: state.lead_id,
    listingId: state.crm_lead?.portal_listing_id,
  });
  await deps.telegram.send(text);
  await finish(deps, state, 'OPTOUT', 'done');
  await emit(deps, {
    workflow: 'WF-06',
    step: 'R02',
    event_code: 'OPTOUT',
    lead_id: state.lead_id,
    status: 'done',
    names: [email, state.crm_lead?.first_name, state.crm_lead?.last_name, state.crm_lead?.phone],
  });
  return { ...state, halt: true, outcome: 'OPTOUT', telegram_text: text, sent: false };
}

async function stepReplyBook(state, deps) {
  if (state.halt || state.reply_action !== 'book') return state;
  const email = state.crm_lead.email;
  const hash = emailHash(email, deps.config.HASH_SALT);
  if (await deps.db.isOptout(hash) || String(state.crm_lead.optout) === 'true' || state.crm_lead.optout === true) {
    const text = notifyStop({ leadId: state.lead_id, listingId: state.crm_lead.portal_listing_id });
    await deps.telegram.send(text);
    await finish(deps, state, 'OPTOUT', 'done');
    return { ...state, halt: true, outcome: 'OPTOUT', telegram_text: text, sent: false };
  }
  const existing = await deps.db.getBooking(state.lead_id);
  if (existing) {
    const text = notifyNeedsHuman({
      leadId: state.lead_id,
      listingId: state.crm_lead.portal_listing_id,
      reason: 'bereits gebucht',
    });
    await deps.crm.updateStatus(state.lead_id, { needs_human_reason: 'already_booked', booking_status: 'needs_human' });
    await deps.telegram.send(text);
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text, sent: false };
  }
  const slots = state.matched_outbound?.offered_slots || [];
  const slot = slots[(state.slot_index || 1) - 1];
  if (!slot) {
    const text = notifyNeedsHuman({ leadId: state.lead_id, listingId: state.crm_lead.portal_listing_id, reason: 'Slot fehlt' });
    await deps.telegram.send(text);
    await finish(deps, state, 'NEEDS_HUMAN', 'done');
    return { ...state, halt: true, outcome: 'NEEDS_HUMAN', telegram_text: text };
  }
  const busy = await deps.calendar.getBusy({
    start: slot.start,
    end: slot.end,
    tz: deps.config.SLOT_RULES.tz,
  });
  const zone = deps.config.SLOT_RULES.tz;
  const start = DateTime.fromISO(slot.start, { zone });
  const end = DateTime.fromISO(slot.end, { zone });
  const free = !slotConflicts(start, end, busy, deps.config.SLOT_RULES.buffer_min, zone);
  if (!free) {
    const text = notifySlotBusy({ leadId: state.lead_id, listingId: state.crm_lead.portal_listing_id });
    await deps.crm.updateStatus(state.lead_id, { needs_human_reason: 'slot_busy', booking_status: 'needs_human' });
    await deps.telegram.send(text);
    await finish(deps, state, 'SLOT_BUSY', 'done');
    return { ...state, halt: true, outcome: 'SLOT_BUSY', slot_free: false, telegram_text: text, sent: false };
  }
  const decision = decideSend({ kind: 'confirmation', config: deps.config, optout: false });
  if (!decision.ok) {
    const text = notifyFreigabe({
      leadId: state.lead_id,
      grade: state.crm_lead.grade || '—',
      listingId: state.crm_lead.portal_listing_id,
      kind: state.crm_lead.lead_kind,
    });
    await deps.telegram.send(text);
    await finish(deps, state, 'PENDING_APPROVAL', 'done');
    return {
      ...state,
      halt: true,
      outcome: 'PENDING_APPROVAL',
      slot_free: true,
      telegram_text: text,
      sent: false,
      approval_timeout_action: deps.config.APPROVAL_TIMEOUT_ACTION,
    };
  }
  const listingId = state.crm_lead.portal_listing_id;
  const owner = state.crm_lead.lead_kind === 'eigentuemer';
  const title = owner ? `Bewertung ${state.lead_id}` : `Besichtigung ${listingId} · ${state.lead_id}`;
  const description = owner
    ? 'Bewertungstermin vor Ort. Keine Kontaktdaten in diesem Ereignis.'
    : 'Besichtigungstermin. Keine Kontaktdaten in diesem Ereignis.';
  const secrets = [email, state.crm_lead.phone, state.crm_lead.first_name, state.crm_lead.last_name].filter(Boolean);
  if (findPii(`${title}\n${description}`, secrets).length) {
    throw new Error('pii_in_event');
  }
  const created = await deps.calendar.createEvent({
    start: slot.start,
    end: slot.end,
    title,
    description,
    tz: zone,
  });
  const objekt = findObjekt(deps.objekte, listingId);
  const leadForMail = {
    contact: {
      salutation: state.crm_lead.salutation,
      last_name: state.crm_lead.last_name,
      email: state.crm_lead.email,
    },
    listing: { title: state.crm_lead.listing_title, portal_listing_id: listingId },
  };
  const mail = owner
    ? composeOwnerConfirmation({
      lead: leadForMail,
      slot,
      makler: deps.config.MAKLER_PROFILE,
      leadId: state.lead_id,
    })
    : composeConfirmation({
      lead: leadForMail,
      objekt,
      slot,
      makler: deps.config.MAKLER_PROFILE,
      leadId: state.lead_id,
    });
  const toOk = recipientAllowed({
    leadEmail: email,
    proposedTo: state.normalized.from,
    relayDomains: deps.config.ALLOWED_RECIPIENT_RELAY_DOMAINS,
  });
  if (!toOk) {
    await finish(deps, state, 'BLOCKED_RECIPIENT', 'error');
    return { ...state, halt: true, outcome: 'BLOCKED_RECIPIENT', sent: false };
  }
  const domain = deps.config.MAIL_DOMAIN || (deps.config.MAKLER_PROFILE.from_email || '').split('@')[1] || 'localhost';
  const mid = makeMessageId({ leadId: state.lead_id, domain, clock: () => nowDate(deps) });
  await deps.mail.send({
    from: fromNameAddress(deps),
    to: email,
    subject: mail.subject,
    text: mail.text,
    messageId: mid.messageId,
    inReplyTo: state.normalized.message_id || undefined,
    headers: { 'X-AI-Generated': 'true', 'Auto-Submitted': 'auto-generated' },
  });
  const sentAt = berlin(deps).toISO();
  await deps.db.insertOutbound({
    sent_message_id_hash: mid.hash,
    lead_id: state.lead_id,
    kind: 'confirmation',
    offered_slots: null,
    sent_at: sentAt,
    rfc_message_id: mid.messageId,
  });
  await deps.db.upsertBooking({
    lead_id: state.lead_id,
    slot_start: slot.start,
    slot_end: slot.end,
    event_id: created.event_id,
    status: 'booked',
    booking_version: 1,
  });
  await deps.crm.updateStatus(state.lead_id, {
    booking_status: 'booked',
    booked_slot: slot.label,
    pipeline_status: 'termin',
    reply_status: 'sent',
    attendance: 'unbekannt',
  });
  const text = notifyBooked({ leadId: state.lead_id, listingId, slotIndex: state.slot_index });
  await deps.telegram.send(text);
  await finish(deps, state, 'TERMIN', 'done');
  await emit(deps, {
    workflow: 'WF-06',
    step: 'R05',
    event_code: 'BOOKED',
    lead_id: state.lead_id,
    status: 'done',
    meta: { slot_index: state.slot_index, listing_id: listingId },
    names: secrets,
  });
  return {
    ...state,
    halt: false,
    outcome: 'TERMIN',
    sent: true,
    slot_free: true,
    mail,
    event_id: created.event_id,
    event_title: title,
    event_description: description,
    message_id: mid.messageId,
    telegram_text: text,
    pipeline_status: 'termin',
  };
}

async function stepReplyHuman(state, deps) {
  if (state.halt || state.reply_action === 'book' || state.reply_action === 'stop') return state;
  const text = notifyNeedsHuman({
    leadId: state.lead_id,
    listingId: state.crm_lead?.portal_listing_id,
    reason: state.reply_reason || 'unklar',
  });
  if (state.lead_id) {
    await deps.crm.updateStatus(state.lead_id, { needs_human_reason: state.reply_reason || 'unclear' });
  }
  await deps.telegram.send(text);
  await finish(deps, state, 'NEEDS_HUMAN', 'done');
  return { ...state, outcome: 'NEEDS_HUMAN', telegram_text: text, sent: false };
}

async function runReply(state, deps) {
  let current = await stepReplyMatch(state, deps);
  if (current.halt) return current;
  current = await stepReplyClassify(current, deps);
  if (current.reply_action === 'stop') return stepReplyStop(current, deps);
  if (current.reply_action === 'book') return stepReplyBook(current, deps);
  return stepReplyHuman(current, deps);
}

async function runInbound(raw, deps) {
  let state = await stepNormalize(raw, deps);
  state = await stepDedup(state, deps);
  if (!state.halt) {
    state = state.route === 'reply' ? await runReply(state, deps) : await runInquiry(state, deps);
  }
  await publishState(deps, state);
  return state;
}

function guardUnsolicited(kind, config) {
  return decideSend({ kind, config, optout: false });
}

module.exports = {
  runInbound,
  runInquiry,
  runReply,
  stepNormalize,
  stepDedup,
  stepExtract,
  stepScore,
  stepBusy,
  stepSlots,
  stepCompose,
  stepSend,
  stepCrm,
  stepTelegram,
  stepReplyMatch,
  stepReplyClassify,
  stepReplyStop,
  stepReplyBook,
  stepReplyHuman,
  guardUnsolicited,
  findObjekt,
};
