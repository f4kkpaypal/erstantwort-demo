'use strict';

const { DateTime } = require('luxon');
const { clientIp, rateAllow, formHits } = require('../core/clientIp');
const { verifyInitData, allowedTelegramIds } = require('../core/uiAuth');
const { applyFragebogen, formSchema } = require('../core/fragebogen');
const {
  ensureUi,
  presentLead,
  presentObjekt,
  sortLeads,
  filterLeads,
  metrics,
  dayHeading,
  buildDraft,
  bookingWord,
} = require('../core/uiModel');
const { notifyStop, notifyFreigabe } = require('../core/telegram');
const { makeMessageId } = require('../core/messageId');
const { AI_FIRST_LINE, composeMoveNotice } = require('../core/template');
const { pickSlots } = require('../core/slots');

const PIPELINE = new Set(['neu', 'kontaktiert', 'termin', 'abgeschlossen', 'verworfen']);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' }));
      }
    });
    req.on('error', () => reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' })));
  });
}

function nowOf(deps) {
  return deps.clock ? deps.clock() : new Date();
}

function authorize(req, deps) {
  const config = deps.config;
  if (config.DEMO_UI_NO_AUTH) {
    if (config.MAIL_MODE === 'smtp' || config.TELEGRAM_MODE === 'telegram') {
      return { ok: false, status: 403, error_code: 'demo_auth_blocked', message: 'Demo-Zugang ist bei echtem Versand gesperrt.' };
    }
    return { ok: true, demo: true };
  }
  const header = String(req.headers.authorization || '');
  const initData = header.toLowerCase().startsWith('tma ') ? header.slice(4).trim() : '';
  const checked = verifyInitData(initData, config.TELEGRAM_BOT_TOKEN, {
    maxAgeS: config.UI_INITDATA_MAX_AGE_S,
    now: nowOf(deps),
  });
  if (!checked.ok) {
    const expired = checked.error === 'expired';
    return {
      ok: false,
      status: 401,
      error_code: expired ? 'expired' : 'unauthorized',
      message: expired ? 'Sitzung abgelaufen. Bitte App neu öffnen.' : 'Anmeldung fehlt.',
    };
  }
  const allowed = allowedTelegramIds(config);
  if (!allowed.has(checked.user.id)) {
    return {
      ok: false,
      status: 403,
      error_code: 'forbidden',
      message: 'Diese App ist nur für das Maklerbüro freigeschaltet.',
    };
  }
  return { ok: true, demo: false, user: checked.user };
}

function leadById(state, id) {
  return state.leads.find((lead) => lead.lead_id === id) || null;
}

function objektById(state, id) {
  return state.objekte.find((row) => row.portal_listing_id === id) || null;
}

function cached(state, key) {
  if (!key || !state.idempotency.has(key)) return null;
  return state.idempotency.get(key);
}

async function handleUi(req, res, deps, url) {
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const uiPath = pathname.startsWith('/v1/ui') || pathname.startsWith('/f/');
  if (!uiPath) return false;
  try {
    if (pathname.startsWith('/f/')) {
      await handleForm(req, res, deps, pathname);
      return true;
    }
    const auth = authorize(req, deps);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error_code: auth.error_code, message: auth.message });
      return true;
    }
    const state = await ensureUi(deps);
    const parts = pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && pathname === '/v1/ui/bootstrap') {
      sendJson(res, 200, bootstrap(deps, state, auth.demo));
      return true;
    }
    if (req.method === 'GET' && pathname === '/v1/ui/leads') {
      const leads = sortLeads(filterLeads(state.leads, Object.fromEntries(url.searchParams)));
      sendJson(res, 200, {
        ok: true,
        demo: auth.demo,
        leads: leads.map((lead) => presentLead(lead, {
          detail: false,
          now: nowOf(deps),
          zone: deps.config.GENERIC_TIMEZONE,
          config: deps.config,
        })),
      });
      return true;
    }
    const leadMatch = pathname.match(/^\/v1\/ui\/leads\/([^/]+)$/);
    if (req.method === 'GET' && leadMatch) {
      const lead = leadById(state, decodeURIComponent(leadMatch[1]));
      if (!lead) {
        sendJson(res, 404, { ok: false, error_code: 'not_found' });
        return true;
      }
      lead._objekt = objektById(state, lead.portal_listing_id);
      const objektMissing = lead.lead_kind !== 'eigentuemer' && Boolean(lead.portal_listing_id) && !lead._objekt;
      sendJson(res, 200, {
        ok: true,
        lead: presentLead(lead, {
          detail: true,
          now: nowOf(deps),
          zone: deps.config.GENERIC_TIMEZONE,
          publicBase: deps.config.UI_PUBLIC_BASE,
          config: deps.config,
        }),
        objekt_missing: objektMissing,
      });
      return true;
    }
    const action = pathname.match(/^\/v1\/ui\/leads\/([^/]+)\/(approve|reject|stop|status|draft)$/);
    if (req.method === 'POST' && action) {
      const body = await readBody(req);
      const key = String(req.headers['idempotency-key'] || '');
      const previous = cached(state, key);
      if (previous) {
        sendJson(res, 200, previous);
        return true;
      }
      const result = await act(deps, state, decodeURIComponent(action[1]), action[2], body);
      if (result.ok) persistUi(deps);
      if (key && result.ok) state.idempotency.set(key, result);
      const { status, ...payload } = result;
      sendJson(res, status || 200, payload);
      return true;
    }
    if (req.method === 'GET' && pathname === '/v1/ui/bookings') {
      sendJson(res, 200, { ok: true, ...weekView(state, deps, url.searchParams.get('week')) });
      return true;
    }
    const bookingId = pathname.match(/^\/v1\/ui\/bookings\/([^/]+)\/(options|move|attendance)$/);
    if (bookingId && (req.method === 'GET' || req.method === 'POST')) {
      const booking = state.bookings.find((row) => row.id === decodeURIComponent(bookingId[1]));
      if (!booking) {
        sendJson(res, 404, { ok: false, error_code: 'not_found' });
        return true;
      }
      const kind = bookingId[2];
      if (req.method === 'GET' && kind === 'options') {
        sendJson(res, 200, { ok: true, slots: offerSlots(state, deps, booking), mailed: false });
        return true;
      }
      if (req.method === 'POST' && kind === 'move') {
        const body = await readBody(req);
        const result = await moveBooking(deps, state, booking, body.start);
        if (result.ok) persistUi(deps);
        const { status, ...payload } = result;
        sendJson(res, status || 200, payload);
        return true;
      }
      if (req.method === 'POST' && kind === 'attendance') {
        const body = await readBody(req);
        if (body.attendance !== 'erschienen' && body.attendance !== 'nicht_erschienen') {
          sendJson(res, 400, { ok: false, error_code: 'bad_attendance' });
          return true;
        }
        booking.attendance = body.attendance;
        const lead = leadById(state, booking.lead_id);
        if (lead) lead.attendance = body.attendance;
        persistUi(deps);
        sendJson(res, 200, { ok: true, attendance: booking.attendance, note: 'Nur Statistik. Fließt nicht in die Einstufung ein.' });
        return true;
      }
    }
    if (req.method === 'GET' && pathname === '/v1/ui/objekte') {
      sendJson(res, 200, { ok: true, objekte: state.objekte.map((row) => presentObjekt(row, deps.config)) });
      return true;
    }
    const objektMatch = pathname.match(/^\/v1\/ui\/objekte\/([^/]+)$/);
    if (req.method === 'GET' && objektMatch) {
      const objekt = objektById(state, decodeURIComponent(objektMatch[1]));
      if (!objekt) {
        sendJson(res, 404, { ok: false, error_code: 'not_found' });
        return true;
      }
      const view = presentObjekt(objekt, deps.config);
      view.schema = formSchema({
        lead: { inquiry_type: objekt.inquiry_type || 'miete', listing_title: objekt.title },
        objekt,
        makler: deps.config.MAKLER_PROFILE,
        config: deps.config,
      });
      sendJson(res, 200, { ok: true, objekt: view });
      return true;
    }
    if (pathname === '/v1/ui/metrics' && req.method === 'GET') {
      const days = Number(url.searchParams.get('days') || 7);
      sendJson(res, 200, {
        ok: true,
        ...metrics({
          leads: state.leads,
          bookings: state.bookings,
          config: deps.config,
          minutes: state.minutes,
          now: nowOf(deps),
          days: days === 30 ? 30 : 7,
        }),
      });
      return true;
    }
    if (pathname === '/v1/ui/settings' && req.method === 'GET') {
      sendJson(res, 200, settings(deps, state));
      return true;
    }
    if (pathname === '/v1/ui/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const reply = Number(body.minutes_per_reply);
      const booking = Number(body.minutes_per_booking);
      if (Number.isFinite(reply) && reply >= 1 && reply <= 120) state.minutes.reply = Math.round(reply);
      if (Number.isFinite(booking) && booking >= 1 && booking <= 120) state.minutes.booking = Math.round(booking);
      persistUi(deps);
      sendJson(res, 200, { ok: true, ...settings(deps, state) });
      return true;
    }
    sendJson(res, 404, { ok: false, error_code: 'not_found' });
    return true;
  } catch (err) {
    const code = err?.code === 'invalid_json' || err?.code === 'payload_too_large' ? err.code : 'internal';
    sendJson(res, code === 'internal' ? 500 : 400, { ok: false, error_code: code });
    return true;
  }
}

function bootstrap(deps, state, demo) {
  const config = deps.config;
  return {
    ok: true,
    demo,
    banner: demo ? 'Demo · fiktive Daten · kein Versand an Telegram' : '',
    product: config.PRODUCT_NAME || 'Erstantwort',
    city: config.OFFICE_MODE === 'live'
      ? (config.MAKLER_PROFILE.city ? `${config.MAKLER_PROFILE.city} · Ihr Katalog` : 'Ihr Katalog')
      : 'Nürnberg · Ihr Katalog',
    makler_name: config.MAKLER_PROFILE.name,
    send_mode: config.SEND_MODE,
    mode_label: config.SEND_MODE === 'auto' ? 'Modus: Automatik' : 'Modus: Freigabe',
    retention_days: config.RETENTION_DAYS_LEAD,
    sheet_url: config.MAKLER_PROFILE.sheet_url || '',
    sheet_contact: config.SHEET_INCLUDE_CONTACT === true,
    grade_hint: `${deps.config.FRAGEBOGEN_INCOME_ENABLED
      ? 'Die Einstufung folgt festen Regeln zu Budget, Finanzierung, Einkommen im Verhältnis zur Miete und Zeitrahmen.'
      : 'Die Einstufung folgt festen Regeln zu Budget, Finanzierung und Zeitrahmen.'} Sie dient nur Ihrer Priorisierung und ändert weder Antwort noch Terminvorschläge. Wen Sie einladen, entscheiden Sie.`,
    grade_hint_owner: 'Bei Eigentümer-Anfragen zählen Verkaufszeitraum, Objektart, Lage, Fläche und ein gewünschter Bewertungstermin. Kaufpreis und Miete spielen hier keine Rolle. Sie entscheiden, wen Sie einladen.',
    ...settings(deps, state),
  };
}

function settings(deps, state) {
  return {
    minutes_per_reply: state.minutes.reply,
    minutes_per_booking: state.minutes.booking,
    send_mode: deps.config.SEND_MODE,
    retention_days: deps.config.RETENTION_DAYS_LEAD,
    mode_label: deps.config.SEND_MODE === 'auto' ? 'Modus: Automatik' : 'Modus: Freigabe',
    retention_label: `Löschfrist: ${deps.config.RETENTION_DAYS_LEAD} Tage`,
  };
}

async function act(deps, state, leadId, action, body) {
  const lead = leadById(state, leadId);
  if (!lead) return { ok: false, status: 404, error_code: 'not_found' };
  if (action === 'status') {
    if (!PIPELINE.has(body.pipeline_status)) return { ok: false, status: 400, error_code: 'bad_status' };
    lead.pipeline_status = body.pipeline_status;
    return { ok: true, pipeline_status: lead.pipeline_status };
  }
  if (lead.optout === true || lead.needs_human_reason === 'lead_stop') {
    return { ok: false, status: 409, error_code: 'lead_stopped', message: 'Der Interessent hat widersprochen (STOP).' };
  }
  if (action === 'approve') {
    if (lead.reply_status !== 'pending_approval') return { ok: false, status: 409, error_code: 'not_pending' };
    if (deps.config.MAIL_MODE !== 'smtp') {
      lead.reply_status = 'sent';
      lead.pipeline_status = lead.pipeline_status === 'neu' ? 'kontaktiert' : lead.pipeline_status;
      lead.first_reply_at = nowOf(deps).toISOString();
      lead.send_simulated = true;
      return { ok: true, simulated: true, message: 'Demo: nicht gesendet, nur simuliert.' };
    }
    const url = lead.public_token ? `${deps.config.UI_PUBLIC_BASE}/f/${lead.public_token}` : '';
    const text = lead.draft_text || buildDraft(lead, lead._objekt || objektById(state, lead.portal_listing_id), url, deps.config);
    if (!text.includes(AI_FIRST_LINE) || !text.includes('STOP')) {
      return { ok: false, status: 409, error_code: 'draft_incomplete', message: 'Der Entwurf enthält nicht den KI-Hinweis und STOP.' };
    }
    if (!lead.email) return { ok: false, status: 409, error_code: 'missing_recipient', message: 'Empfänger fehlt.' };
    const domain = deps.config.MAIL_DOMAIN || (deps.config.MAKLER_PROFILE.from_email || '').split('@')[1] || 'localhost';
    const mid = makeMessageId({ leadId: lead.lead_id, domain, clock: () => nowOf(deps) });
    const profile = deps.config.MAKLER_PROFILE;
    const fromEmail = profile.from_email || deps.config.SMTP_USER;
    const from = profile.from_name ? `${profile.from_name} <${fromEmail}>` : fromEmail;
    await deps.mail.send({
      from,
      to: lead.email,
      subject: lead.draft_subject || `Ihre Anfrage [${lead.lead_id}]`,
      text,
      messageId: mid.messageId,
      headers: { 'X-AI-Generated': 'true', 'Auto-Submitted': 'auto-generated' },
    });
    if (deps.db?.insertOutbound) {
      await deps.db.insertOutbound({
        sent_message_id_hash: mid.hash,
        lead_id: lead.lead_id,
        kind: lead.draft_kind || 'first_reply',
        offered_slots: lead.offered_slots || [],
        sent_at: nowOf(deps).toISOString(),
        rfc_message_id: mid.messageId,
      });
    }
    lead.reply_status = 'sent';
    lead.pipeline_status = lead.pipeline_status === 'neu' ? 'kontaktiert' : lead.pipeline_status;
    lead.first_reply_at = nowOf(deps).toISOString();
    lead.send_simulated = false;
    lead.draft_text = text;
    lead.sent_message_id = mid.messageId;
    return { ok: true, simulated: false, message: 'Gesendet.', message_id: mid.messageId };
  }
  if (action === 'draft') {
    if (lead.reply_status !== 'pending_approval') return { ok: false, status: 409, error_code: 'not_pending' };
    const text = String(body.text || '');
    if (text.length > 8000) return { ok: false, status: 400, error_code: 'draft_too_long' };
    if (!text.includes(AI_FIRST_LINE) || !text.includes('STOP')) {
      return { ok: false, status: 409, error_code: 'draft_incomplete', message: 'Der Entwurf muss den KI-Hinweis und STOP behalten.' };
    }
    lead.draft_text = text;
    return { ok: true, message: 'Entwurf gespeichert.', draft_text: text };
  }
  if (action === 'reject') {
    lead.reply_status = 'rejected_by_makler';
    lead.needs_human_reason = 'manual_reply';
    return { ok: true, message: 'Bitte manuell antworten', simulated: true };
  }
  if (action === 'stop') {
    lead.needs_human_reason = 'makler_stop';
    lead.optout = false;
    if (deps.fragebogen?.revokeLead) deps.fragebogen.revokeLead(lead.lead_id);
    const text = notifyStop({ leadId: lead.lead_id, listingId: lead.portal_listing_id });
    if (deps.telegram?.send) await deps.telegram.send(text);
    return { ok: true, simulated: true, telegram_text: text, message: 'Automatik aus' };
  }
  return { ok: false, status: 404, error_code: 'not_found' };
}

function weekView(state, deps, weekParam) {
  const zone = deps.config.GENERIC_TIMEZONE || 'Europe/Berlin';
  let cursor = DateTime.fromJSDate(nowOf(deps), { zone }).startOf('week');
  if (weekParam && /^\d{4}-W\d{2}$/.test(weekParam)) {
    const parsed = DateTime.fromISO(`${weekParam}-1`, { zone });
    if (parsed.isValid) cursor = parsed.startOf('week');
  }
  const end = cursor.plus({ days: 7 });
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = cursor.plus({ days: i });
    const items = state.bookings.filter((row) => {
      const start = DateTime.fromISO(row.slot_start, { zone });
      return start.isValid && start.hasSame(day, 'day');
    }).map((row) => {
      const lead = leadById(state, row.lead_id);
      const objekt = objektById(state, row.portal_listing_id);
      const start = DateTime.fromISO(row.slot_start, { zone });
      const finish = DateTime.fromISO(row.slot_end, { zone });
      return {
        id: row.id,
        lead_id: row.lead_id,
        time: `${start.toFormat('HH:mm')}–${finish.toFormat('HH:mm')}`,
        title: objekt?.title || lead?.listing_title || 'Objekt',
        kind_label: row.kind === 'bewertung' || lead?.lead_kind === 'eigentuemer' ? 'Bewertungstermin' : 'Besichtigung',
        name: lead ? `${lead.first_name} ${String(lead.last_name || '').slice(0, 1)}.` : row.lead_id,
        status: bookingWord(row.status),
        attendance: row.attendance || '',
      };
    });
    days.push({ label: dayHeading(day), items });
  }
  return {
    week: cursor.toFormat("kkkk-'W'WW"),
    title: `Besichtigungen · KW ${cursor.weekNumber}`,
    days,
    empty: days.every((day) => day.items.length === 0),
    note: 'Freie Fenster: täglich 10–18 Uhr, 45 Minuten. Verschieben ändert den Termin hier und legt die Nachricht in die Freigabe. Versendet wird sie nicht von selbst.',
  };
}

function offerSlots(state, deps, booking) {
  const rules = deps.config.SLOT_RULES;
  const busy = state.bookings
    .filter((row) => row.id !== booking.id && row.status !== 'cancelled')
    .map((row) => ({ start: row.slot_start, end: row.slot_end }));
  return pickSlots({ now: nowOf(deps), busy, rules, count: 3 })
    .filter((slot) => slot.start !== booking.slot_start);
}

async function queueMoveNotice(deps, state, booking, lead, slot) {
  if (!lead?.email) return false;
  if (lead.optout === true || lead.needs_human_reason === 'lead_stop') return false;
  const objekt = objektById(state, lead.portal_listing_id);
  const owner = booking.kind === 'bewertung' || lead.lead_kind === 'eigentuemer';
  const mail = composeMoveNotice({
    contact: {
      salutation: lead.salutation,
      first_name: lead.first_name,
      last_name: lead.last_name,
    },
    title: lead.listing_title || objekt?.title || 'Ihr Objekt',
    where: (objekt?.viewing_location || '').trim() || 'den vereinbarten Treffpunkt',
    when: slot.label_long || slot.label,
    makler: deps.config.MAKLER_PROFILE,
    leadId: lead.lead_id,
    owner,
  });
  lead.reply_status = 'pending_approval';
  lead.draft_text = mail.text;
  lead.draft_subject = mail.subject;
  lead.draft_kind = 'reschedule';
  lead.include_draft = true;
  lead.send_simulated = false;
  if (deps.telegram?.send) {
    await deps.telegram.send(notifyFreigabe({
      leadId: lead.lead_id,
      grade: lead.grade,
      listingId: lead.portal_listing_id,
      kind: lead.lead_kind,
    }));
  }
  if (deps.db?.logEvent) {
    await deps.db.logEvent({
      workflow: 'UI',
      step: 'move',
      event_code: 'MOVE_FREIGABE',
      lead_id: lead.lead_id,
      status: 'done',
      ts: nowOf(deps).toISOString(),
    });
  }
  return true;
}

async function moveBooking(deps, state, booking, start) {
  const slot = offerSlots(state, deps, booking).find((row) => row.start === start);
  if (!slot) return { ok: false, status: 409, error_code: 'slot_unavailable', message: 'Dieser Termin ist nicht frei.' };
  booking.slot_start = slot.start;
  booking.slot_end = slot.end;
  booking.slot_label = slot.label;
  const lead = leadById(state, booking.lead_id);
  if (lead) lead.booked_slot = slot.label;
  if (deps.calendar?.updateForLead) {
    await deps.calendar.updateForLead(booking.lead_id, {
      start: slot.start,
      end: slot.end,
      tz: deps.config.GENERIC_TIMEZONE,
    });
  }
  const queued = await queueMoveNotice(deps, state, booking, lead, slot);
  const who = booking.kind === 'bewertung' || lead?.lead_kind === 'eigentuemer' ? 'Eigentümer' : 'Interessenten';
  return {
    ok: true,
    message: queued
      ? `Termin verschoben. Die Nachricht an den ${who} wartet auf Freigabe und wurde nicht gesendet.`
      : 'Termin verschoben. Es liegt keine Nachricht zur Freigabe.',
    slot_label: slot.label,
    mailed: false,
    queued,
  };
}

async function handleForm(req, res, deps, pathname) {
  const token = decodeURIComponent(pathname.slice(3));
  const ip = clientIp(req, deps.config.TRUST_PROXY);
  if (!rateAllow(formHits, ip, Date.now())) {
    sendJson(res, 429, { ok: false, error_code: 'rate_limited', message: 'Bitte später erneut versuchen.' });
    return;
  }
  const state = await ensureUi(deps);
  const row = deps.fragebogen.find(token);
  if (!row) {
    sendJson(res, 404, { ok: false, error_code: 'expired', message: 'Dieser Link ist nicht mehr gültig. Antworten Sie gern direkt auf unsere E-Mail.' });
    return;
  }
  const lead = leadById(state, row.lead_id);
  const objekt = lead ? objektById(state, lead.portal_listing_id) : null;
  if (!lead) {
    sendJson(res, 404, { ok: false, error_code: 'expired', message: 'Dieser Link ist nicht mehr gültig. Antworten Sie gern direkt auf unsere E-Mail.' });
    return;
  }
  if (row.revoked || lead.optout === true || lead.needs_human_reason === 'lead_stop') {
    sendJson(res, 200, {
      ok: false,
      error_code: 'stopped',
      message: `Sie haben der automatischen Bearbeitung widersprochen. ${deps.config.MAKLER_PROFILE.name} meldet sich persönlich.`,
    });
    return;
  }
  const expires = DateTime.fromISO(row.expires_at);
  if (expires.isValid && expires.toMillis() < nowOf(deps).getTime()) {
    sendJson(res, 200, { ok: false, error_code: 'expired', message: 'Dieser Link ist nicht mehr gültig. Antworten Sie gern direkt auf unsere E-Mail.' });
    return;
  }
  if (row.submitted_at) {
    sendJson(res, 200, { ok: false, error_code: 'already', message: 'Sie haben den Fragebogen bereits ausgefüllt. Änderungen? Antworten Sie einfach auf unsere E-Mail.' });
    return;
  }
  if (req.method === 'GET') {
    deps.fragebogen.markOpened(token);
    const schema = formSchema({ lead, objekt, makler: deps.config.MAKLER_PROFILE, config: deps.config });
    sendJson(res, 200, { ok: true, ...schema, demo: deps.config.UI_STORE !== 'sqlite' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error_code: 'method' });
    return;
  }
  const body = await readBody(req);
  if (body.datenschutz_gelesen !== true) {
    sendJson(res, 400, { ok: false, error_code: 'datenschutz', message: 'Bitte bestätigen Sie, dass Sie die Datenschutzhinweise gelesen haben.' });
    return;
  }
  const beforeGrade = lead.grade;
  const result = applyFragebogen({ lead, objekt, answers: body, config: deps.config });
  Object.assign(lead, result.lead);
  lead.abweichungen = result.abweichungen;
  lead.fragebogen_at = nowOf(deps).toISOString();
  lead.draft_text = lead.draft_text || '';
  persistUi(deps);
  deps.fragebogen.save(token, {
    submitted_at: lead.fragebogen_at,
    answers: result.answers,
  });
  let telegram = '';
  if (beforeGrade !== 'HOT' && result.after.grade === 'HOT' && deps.telegram?.send) {
    telegram = `Lead jetzt HOT ${lead.lead_id} · Objekt ${lead.portal_listing_id || '—'}`;
    await deps.telegram.send(telegram);
  }
  sendJson(res, 200, {
    ok: true,
    message: `Vielen Dank! ${deps.config.MAKLER_PROFILE.name} hat Ihre Angaben erhalten. Ihre Terminvorschläge finden Sie in unserer E-Mail. Sie können diese Seite schließen.`,
    grade: result.after.grade,
    score: result.after.score,
    grade_before: result.before.grade,
    score_before: result.before.score,
    reasons: result.after.reasons,
    telegram_text: telegram,
  });
}

function persistUi(deps) {
  if (deps.ui?.persist) deps.ui.persist();
}

module.exports = { handleUi, authorize, bookingWord, persistUi };
