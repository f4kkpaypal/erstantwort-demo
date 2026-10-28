'use strict';

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { AI_FIRST_LINE, STOP_LINE, FRAGEBOGEN_INTRO, composeOwnerReply } = require('./template');
const { formSchema, flagsFrom } = require('./fragebogen');

const DEMO_FILE = path.join(__dirname, '..', 'fixtures', 'ui_demo.json');
const PII_KEYS = ['email', 'phone', 'income_min_eur', 'income_band_eur', 'schufa_available', 'persons_count', 'pets', 'public_token'];

function loadDemoFile() {
  return JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function displayName(lead, full) {
  const first = String(lead.first_name || '').trim();
  const last = String(lead.last_name || '').trim();
  if (full) return [first, last].filter(Boolean).join(' ') || lead.lead_id;
  const initial = last ? `${last.slice(0, 1)}.` : '';
  return [first, initial].filter(Boolean).join(' ') || lead.lead_id;
}

function berlin(iso, zone) {
  const dt = DateTime.fromISO(iso, { zone: zone || 'Europe/Berlin' });
  return dt.isValid ? dt.setZone(zone || 'Europe/Berlin') : null;
}

function weekday(dt) {
  return dt.setLocale('de').toFormat('ccc').replace(/\.$/, '');
}

function formatWhen(iso, zone) {
  const dt = berlin(iso, zone);
  if (!dt) return '';
  return `${weekday(dt)}., ${dt.toFormat('dd.LL., HH:mm')}`;
}

function dayHeading(dt) {
  return `${weekday(dt)}., ${dt.toFormat('dd.LL.')}`;
}

function statusLabel(lead) {
  if (lead.optout === true || lead.optout === 'true' || lead.needs_human_reason === 'lead_stop') {
    return 'Automatik aus (STOP)';
  }
  if (lead.needs_human_reason === 'makler_stop') return 'Automatik aus (STOP)';
  if (lead.reply_status === 'sent' && lead.send_simulated) return 'Gesendet (Demo)';
  if (lead.needs_human_reason === 'fact_guard' && lead.reply_status === 'pending_approval') return 'Prüfung nötig';
  if (lead.reply_status === 'pending_approval') return 'Freigabe nötig';
  if (lead.needs_human_reason || lead.reply_status === 'needs_human') return 'Prüfung nötig';
  if (lead.booking_status === 'booked' || lead.booking_status === 'confirmed') {
    const prefix = lead.lead_kind === 'eigentuemer' ? 'Bewertungstermin' : 'Termin';
    return `${prefix}: ${lead.booked_slot || ''}`.trim();
  }
  if (lead.reply_status === 'sent' && lead.reply_latency_s !== '' && lead.reply_latency_s != null) {
    const total = Number(lead.reply_latency_s);
    if (Number.isFinite(total)) {
      const min = Math.floor(total / 60);
      const sec = String(total % 60).padStart(2, '0');
      return `Beantwortet in ${min}:${sec} Min.`;
    }
  }
  if (lead.reply_status === 'sent') return 'Beantwortet';
  if (lead.reply_status === 'rejected_by_makler') return 'Abgelehnt';
  return '';
}

function waitingLabel(lead, now, zone) {
  if (lead.reply_status !== 'pending_approval' || !lead.created_at) return '';
  const start = berlin(lead.created_at, zone);
  const current = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone: zone || 'Europe/Berlin' });
  if (!start || !current.isValid) return '';
  const hours = Math.max(0, Math.floor(current.diff(start, 'hours').hours));
  return `Wartet seit ${hours} Std. auf Freigabe.`;
}

function missingLabels(lead, config) {
  const flags = flagsFrom(config);
  const owner = lead?.lead_kind === 'eigentuemer';
  const kauf = !owner && lead?.inquiry_type === 'kauf';
  const enabled = new Set();
  if (owner) {
    enabled.add('timeline');
    enabled.add('object_type');
    enabled.add('area');
    enabled.add('district');
    enabled.add('phone');
  } else if (kauf) {
    enabled.add('timeline');
    enabled.add('budget');
    enabled.add('financing');
    enabled.add('phone');
  } else {
    enabled.add('timeline');
    enabled.add('phone');
    if (flags.budget) enabled.add('budget');
  }
  const labels = {
    budget: 'Budget',
    financing: 'Finanzierung',
    timeline: owner ? 'Verkaufszeitraum' : (kauf ? 'Kaufzeitpunkt' : 'Einzugstermin'),
    phone: 'Telefon',
    object_type: 'Objektart',
    area: 'Fläche',
    district: 'Lage',
  };
  const fields = Array.isArray(lead?.missing_fields) ? lead.missing_fields : [];
  const visible = fields.filter((field) => enabled.has(field));
  return {
    missing_fields: visible,
    missing_labels: visible.map((field) => labels[field]).filter(Boolean),
  };
}

function buildDraft(lead, objekt, url, config) {
  if (lead.lead_kind === 'eigentuemer') {
    const labels = Array.isArray(lead.offered_slots) && lead.offered_slots.length
      ? lead.offered_slots
      : ['Do., 22.10., 16:00', 'Fr., 23.10., 16:00', 'Mo., 26.10., 16:00'];
    const makler = config?.MAKLER_PROFILE || {
      name: 'Maria K.',
      buero: 'Erstantwort Demo',
      adresse: 'Johannisstraße 1, 90419 Nürnberg',
      telefon: '+49 911 0000000',
      impressum_url: 'http://127.0.0.1:18791/impressum',
      datenschutz_url: 'http://127.0.0.1:18791/datenschutz',
    };
    return composeOwnerReply({
      lead: {
        contact: { salutation: lead.salutation, last_name: lead.last_name, first_name: lead.first_name },
        listing: { title: lead.listing_title },
        owner: {
          object_type: lead.object_type,
          city: lead.object_city,
          district: lead.object_district,
          area_sqm: lead.area_sqm,
        },
      },
      slots: labels.map((label) => ({ label })),
      makler,
      leadId: lead.lead_id,
      fragebogenUrl: url,
    }).text;
  }
  const fact = objekt?.verfuegbar_ab_text || objekt?.stellplatz_text || '';
  const lines = [
    AI_FIRST_LINE,
    '',
    `Guten Tag ${lead.first_name || ''},`.trim(),
    '',
    'vielen Dank für Ihr Interesse an der Immobilie.',
  ];
  if (fact) {
    lines.push('', 'Zu Ihren Fragen:', `  • Verfügbar ab: ${objekt.verfuegbar_ab_text || fact}`);
  }
  lines.push(
    '',
    'Mögliche Besichtigungstermine:',
    '  1) Do., 22.10., 16:00',
    '  2) Fr., 23.10., 16:00',
    '  3) Mo., 26.10., 16:00',
  );
  if (url) lines.push('', `${FRAGEBOGEN_INTRO} ${url}`);
  lines.push('', STOP_LINE);
  return lines.join('\n');
}

function hideIncome(config) {
  return !config || config.FRAGEBOGEN_INCOME_ENABLED !== true;
}

function gradeChanged(lead) {
  if (lead.fragebogen_status !== 'submitted' || !lead.grade_before) return false;
  return lead.grade_before !== lead.grade || Number(lead.score_before) !== Number(lead.score);
}

function bookingWord(status) {
  if (status === 'confirmed') return 'bestätigt';
  if (status === 'cancelled') return 'abgesagt';
  if (status === 'booked') return 'gebucht';
  return 'unbestätigt';
}

function presentLead(lead, { detail, now, zone, publicBase, config }) {
  let reasons = Array.isArray(lead.reasons) ? lead.reasons.slice(0, 3) : [];
  let signals = Array.isArray(lead.signals) ? lead.signals : [];
  if (hideIncome(config)) {
    reasons = reasons.filter((reason) => !/Einkommen/i.test(reason));
    signals = signals.filter((row) => row.code !== 'income' && !/Einkommen/i.test(row.reason || ''));
  }
  const gaps = missingLabels(lead, config);
  const card = {
    lead_id: lead.lead_id,
    demo: lead.demo !== false,
    grade: lead.grade,
    score: lead.score,
    display_name: displayName(lead, false),
    listing_title: lead.listing_title,
    lead_kind: lead.lead_kind === 'eigentuemer' ? 'eigentuemer' : 'interessent',
    kind_label: lead.lead_kind === 'eigentuemer' ? 'Eigentümer' : 'Interessent',
    portal_listing_id: lead.portal_listing_id,
    inquiry_type: lead.inquiry_type,
    reasons,
    status_label: statusLabel(lead),
    pipeline_status: lead.pipeline_status || '',
    reply_status: lead.reply_status || '',
    optout: lead.optout === true || lead.optout === 'true',
    injection_suspected: lead.injection_suspected === true,
    fragebogen_status: lead.fragebogen_status || '',
    attachment: false,
    created_at: lead.created_at,
  };
  if (!detail) return card;
  const url = lead.public_token ? `${publicBase}/f/${lead.public_token}` : '';
  return {
    ...card,
    full_name: displayName(lead, true),
    salutation: lead.salutation || '',
    email: lead.email || '',
    phone: lead.phone || '',
    missing_fields: gaps.missing_fields,
    missing_labels: gaps.missing_labels,
    signals,
    score_before: lead.score_before ?? null,
    grade_before: lead.grade_before || '',
    fragebogen_at: lead.fragebogen_at || '',
    abweichungen: lead.abweichungen || [],
    waiting_label: waitingLabel(lead, now, zone),
    excerpt: String(lead.excerpt || '').slice(0, 600),
    excerpt_note: 'Originalnachricht im Postfach',
    object_label: ownerObjectLabel(lead),
    urgency_label: lead.lead_kind === 'eigentuemer' ? urgencyLabel(lead.timeline_horizon) : '',
    area_label: lead.lead_kind === 'eigentuemer' && lead.area_sqm ? `ca. ${lead.area_sqm} m²` : '',
    valuation_label: lead.lead_kind === 'eigentuemer'
      ? (lead.valuation_requested ? 'Bewertungstermin gewünscht' : 'Noch kein Bewertungstermin')
      : '',
    source_label: sourceLabel(lead),
    offered_slots: Array.isArray(lead.offered_slots) ? lead.offered_slots : [],
    preferred_days: lead.preferred_days || '',
    draft_text: lead.include_draft === false ? '' : (lead.draft_text || buildDraft(lead, lead._objekt, url, config)),
    lead_reply: lead.lead_reply || '',
    booked_slot: lead.booked_slot || '',
    booking_status: lead.booking_status || '',
    needs_human_reason: lead.needs_human_reason || '',
    send_simulated: lead.send_simulated === true,
    grade_changed: gradeChanged(lead),
    eingang_label: formatWhen(lead.created_at, zone),
  };
}

function sortLeads(leads) {
  return leads.slice().sort((a, b) => {
    const ap = a.reply_status === 'pending_approval' ? 0 : 1;
    const bp = b.reply_status === 'pending_approval' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
}

function filterLeads(leads, query) {
  const grade = String(query.grade || '').toUpperCase();
  const chip = String(query.chip || query.filter || '').toLowerCase();
  const listing = String(query.listing || '');
  return leads.filter((lead) => {
    if (listing && lead.portal_listing_id !== listing) return false;
    if (grade && lead.grade !== grade) return false;
    if (chip === 'hot' || chip === 'warm' || chip === 'cold') return lead.grade === chip.toUpperCase();
    if (chip === 'eigentuemer') return lead.lead_kind === 'eigentuemer';
    if (chip === 'interessent') return lead.lead_kind !== 'eigentuemer';
    if (chip === 'freigabe') return lead.reply_status === 'pending_approval';
    if (chip === 'pruefung') return Boolean(lead.needs_human_reason) || lead.reply_status === 'needs_human';
    return true;
  });
}

function metrics({ leads, bookings, config, minutes, now, days }) {
  const zone = config.GENERIC_TIMEZONE || 'Europe/Berlin';
  const current = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone });
  const from = current.minus({ days: Number(days) || 7 });
  const periodLeads = leads.filter((lead) => {
    const dt = DateTime.fromISO(lead.created_at, { zone });
    return dt.isValid && dt >= from && dt <= current.endOf('day');
  });
  const autoSent = periodLeads.filter((lead) => lead.reply_status === 'sent' && lead.reply_mode === 'auto');
  const within = autoSent.filter((lead) => Number(lead.reply_latency_s) <= config.FIRST_RESPONSE_SLA_SECONDS);
  const approvePhase = config.SEND_MODE !== 'auto';
  const periodBookings = (bookings || []).filter((row) => {
    const dt = DateTime.fromISO(row.slot_start, { zone });
    return dt.isValid && dt >= from && dt <= current.plus({ days: 7 });
  });
  const isTermin = (row) => row.status === 'booked' || row.status === 'confirmed';
  const termine = periodBookings.filter(isTermin).length;
  const manualFree = periodBookings.filter((row) => isTermin(row) && !row.needs_human_reason);
  const A = approvePhase ? 0 : autoSent.length;
  const T = manualFree.length;
  const tAntwort = minutes.reply;
  const tTermin = minutes.booking;
  const stunden = approvePhase ? null : (A * tAntwort + T * tTermin) / 60;
  return {
    days: Number(days) || 7,
    anfragen: periodLeads.length,
    sla_percent: approvePhase || autoSent.length === 0 ? null : Math.round((100 * within.length) / autoSent.length),
    sla_label: approvePhase ? '— (Freigabephase)' : null,
    termine,
    eingesparte_stunden: stunden,
    schaetzung: true,
    approve_phase: approvePhase,
    minutes_per_reply: tAntwort,
    minutes_per_booking: tTermin,
    demo_data: config.OFFICE_MODE !== 'live',
    formula: `Schätzung: (automatische Antworten × ${tAntwort} Min. + gebuchte Termine × ${tTermin} Min.) ÷ 60. Minutenwerte können Sie anpassen.${config.OFFICE_MODE !== 'live' ? ' Demo · diese Zahlen stammen aus Demodaten.' : ''}`,
    counts: { auto_replies: A, bookings: T },
  };
}

function ownerObjectLabel(lead) {
  const type = {
    wohnung: 'Wohnung',
    haus: 'Haus',
    grundstueck: 'Grundstück',
    gewerbe: 'Gewerbe',
  }[lead.object_type] || '';
  const place = [lead.object_district, lead.object_city].filter(Boolean).join(', ');
  return [type, place].filter(Boolean).join(' · ') || lead.listing_title || '';
}

function urgencyLabel(horizon) {
  return {
    bis_3_monate: 'Verkauf in den nächsten 3 Monaten',
    '3_bis_6_monate': 'Verkauf in 3 bis 6 Monaten',
    ueber_6_monate: 'Verkauf später',
  }[horizon] || '';
}

function sourceLabel(lead) {
  if (lead.lead_kind !== 'eigentuemer') return 'ImmoScout24';
  const name = { immowelt: 'Immowelt', heimziel: 'Heimziel', generic: 'Allgemeines Format' }[lead.source] || 'Eigentümer-Lead';
  return lead.demo === false ? `${name} · angenommenes Format` : `${name} · Demo, angenommenes Format`;
}

function presentObjekt(objekt, config) {
  const sampleLead = { inquiry_type: objekt.inquiry_type || (objekt.price_eur ? 'kauf' : 'miete'), listing_title: objekt.title };
  const schema = formSchema({ lead: sampleLead, objekt, makler: config.MAKLER_PROFILE, config });
  const price = objekt.kaltmiete_eur
    ? `${new Intl.NumberFormat('de-DE').format(objekt.kaltmiete_eur)} € / Monat kalt`
    : (objekt.price_eur ? `${new Intl.NumberFormat('de-DE').format(objekt.price_eur)} € Kaufpreis` : '');
  const modeLabel = { individual: 'Einzeln', group: 'Gruppe', off: 'Aus' }[objekt.booking_mode] || objekt.booking_mode;
  return {
    ...objekt,
    booking_mode: modeLabel,
    demo: true,
    badge: 'Autopilot aktiv',
    price_label: price,
    meta: `${objekt.district || 'Nürnberg'} · ${objekt.rooms || '–'} Zimmer · ${objekt.area_m2 || '–'} m²`,
    info: 'Der Autopilot ist aktiv – jede ImmoScout24-Anfrage erhält Ihre Antwort mit Terminvorschlägen und dem Link zu Ihrem Fragebogen.',
    question_count: schema.question_count,
    hint: 'Diese Texte gehen wörtlich in die Antwort. Leeres Feld = Thema beantworten Sie persönlich.',
  };
}

function createUiState(deps) {
  const demo = clone(loadDemoFile());
  const config = deps.config;
  const state = {
    objekte: demo.objekte,
    leads: demo.leads,
    bookings: demo.bookings,
    minutes: {
      reply: config.UI_MINUTES_PER_REPLY,
      booking: config.UI_MINUTES_PER_BOOKING,
    },
    idempotency: new Map(),
  };
  if (deps.fragebogen?.issue) {
    for (const lead of state.leads) {
      if (!lead.public_token) continue;
      deps.fragebogen.issue({
        leadId: lead.lead_id,
        email: lead.email,
        listingId: lead.portal_listing_id,
        token: lead.public_token,
      });
      if (lead.token_state === 'submitted') {
        deps.fragebogen.save(lead.public_token, { submitted_at: lead.fragebogen_at || new Date().toISOString() });
      }
      if (lead.token_state === 'revoked' || lead.optout) deps.fragebogen.revokeLead(lead.lead_id);
    }
  }
  return {
    state,
    reset() {
      const fresh = createUiState(deps);
      state.objekte = fresh.state.objekte;
      state.leads = fresh.state.leads;
      state.bookings = fresh.state.bookings;
      state.minutes = fresh.state.minutes;
      state.idempotency.clear();
    },
  };
}

function createLiveUi(deps) {
  const board = deps.board;
  const fallback = {
    reply: deps.config.UI_MINUTES_PER_REPLY,
    booking: deps.config.UI_MINUTES_PER_BOOKING,
  };
  const state = {
    objekte: deps.objekte || [],
    leads: [],
    bookings: [],
    minutes: { ...fallback },
    idempotency: new Map(),
    live: true,
  };
  return {
    state,
    async load() {
      state.leads = await board.listCards();
      state.bookings = await board.listUiBookings();
      state.minutes = await board.minutes(fallback);
      state.objekte = deps.objekte || [];
    },
    persist() {
      for (const lead of state.leads) board.upsertCard(lead);
      for (const booking of state.bookings) board.upsertUiBooking(booking);
      board.setMinutes(state.minutes);
    },
    reset() {
      state.leads = [];
      state.bookings = [];
      state.minutes = { ...fallback };
      state.idempotency.clear();
    },
  };
}

async function ensureUi(deps) {
  if (!deps.fragebogen && deps.config) {
    const { FragebogenStore } = require('./fragebogen');
    deps.fragebogen = new FragebogenStore({
      salt: deps.config.HASH_SALT,
      publicBase: deps.config.UI_PUBLIC_BASE,
      linkDays: deps.config.FRAGEBOGEN_LINK_DAYS,
      now: () => (deps.clock ? deps.clock() : new Date()),
    });
  }
  if (!deps.ui) {
    if (deps.config?.UI_STORE === 'sqlite' && deps.board) {
      deps.ui = createLiveUi(deps);
      await deps.ui.load();
    } else {
      deps.ui = createUiState(deps);
    }
  }
  return deps.ui.state;
}

module.exports = {
  loadDemoFile,
  displayName,
  statusLabel,
  presentLead,
  sortLeads,
  filterLeads,
  metrics,
  presentObjekt,
  buildDraft,
  createUiState,
  createLiveUi,
  ensureUi,
  gradeChanged,
  bookingWord,
  PII_KEYS,
  formatWhen,
  dayHeading,
  missingLabels,
};
