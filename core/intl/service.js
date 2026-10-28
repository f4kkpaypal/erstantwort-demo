'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { analyze } = require('./analyze');
const { scoreChat, sortLeads } = require('./score');
const { buildOptions, formatPrice } = require('./options');
const { listFreeSlots, assertSlot } = require('./slots');
const { IntlStore } = require('./store');

const AI_EN = 'AI-assisted message. Reply STOP to opt out.';
const AI_RU = 'Сообщение подготовлено с помощью ИИ. Напишите STOP, чтобы отписаться.';
const STOP_EN = 'Reply STOP to opt out.';
const STOP_RU = 'Напишите STOP, чтобы отписаться.';

const channel = {
  send() {
    return { ok: true, simulated: true, channel_msg_id: `sim-${Date.now()}` };
  },
};

function senderHash(salt, channelName, senderId) {
  return crypto.createHmac('sha256', String(salt)).update(`${channel}:${senderId}`).digest('hex');
}

function createIntl(config, options = {}) {
  const file = options.file || `${config.DATA_DIR || 'var'}/intl.sqlite`;
  const store = options.store || new IntlStore(file);
  let clock = options.clock || (() => new Date());
  let chain = Promise.resolve();
  const lock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const api = {
    store,
    clock,
    close() { store.close(); },
    now() { return clock(); },
    setClock(fn) { clock = fn; },
    digestTick(reason, actorId) { return runDigest(api, config, reason, actorId); },
    hash: senderHash,
    ingest(input) { return lock(() => ingest(api, config, input)); },
    send(leadId, body, actor) { return lock(() => sendLead(api, config, leadId, body, actor)); },
    reject(leadId, actor) { return lock(() => rejectLead(api, config, leadId, actor)); },
    saveDraft(leadId, body) { return lock(() => saveDraft(api, config, leadId, body)); },
    lead(id) { return presentLead(api, config, id); },
    leads() { return listPresent(api, config); },
    digest() { return buildDigest(api, config); },
    addProperty(body, actor) { return lock(() => addProperty(api, config, body, actor)); },
    addSlot(propertyId, body, actor) { return lock(() => addSlot(api, config, propertyId, body, actor)); },
    book(leadId, slotId, actor) { return lock(() => bookViewing(api, config, leadId, slotId, actor)); },
    setViewing(id, status, actor) { return lock(() => setViewing(api, config, id, status, actor)); },
    settings(body, actor) { return lock(() => updateSettings(api, config, body, actor)); },
    getSettings() { return readSettings(store); },
    seed(messages, mode) { return lock(() => seedMessages(api, config, messages, mode)); },
    sweep() { return sweepSending(api, config); },
    retain() { return sweepRetention(api); },
    erase(leadId, actor) { return lock(() => eraseSender(api, config, leadId, actor)); },
    setPipeline(leadId, pipeline, actor) { return lock(() => setPipeline(api, config, leadId, pipeline, actor)); },
    telegram(update) { return lock(() => applyTelegram(api, config, update)); },
    idem(key) { return store.one('SELECT * FROM i_idem WHERE key = ?', [key]); },
    audit(leadId) {
      const rows = leadId
        ? store.all('SELECT * FROM i_audit WHERE lead_id = ? ORDER BY id', [leadId])
        : store.all('SELECT * FROM i_audit ORDER BY id');
      return rows.map((row) => ({ ...row, meta: JSON.parse(row.meta || '{}') }));
    },
  };
  sweepSending(api, config);
  sweepRetention(api);
  return api;
}

function readSettings(store) {
  const rows = store.all('SELECT key, value FROM i_settings');
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function setting(store, key, value) {
  if (value === undefined) return store.one('SELECT value FROM i_settings WHERE key = ?', [key])?.value || '';
  store.run(
    'INSERT INTO i_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)],
  );
  return String(value);
}

function audit(store, config, action, leadId, meta, actor) {
  store.run(
    'INSERT INTO i_audit (ts, actor, action, lead_id, meta) VALUES (?, ?, ?, ?, ?)',
    [new Date().toISOString(), actor || 'system', action, leadId || null, JSON.stringify(meta || {})],
  );
}

function propertyRow(store, id) {
  const row = store.one('SELECT * FROM i_property WHERE id = ?', [id]);
  if (!row) return null;
  return { ...row, facts: JSON.parse(row.facts || '{}') };
}

function ensureGeneral(store, now) {
  if (propertyRow(store, 'general')) return;
  store.run(
    `INSERT INTO i_property (id, title, kind, price, currency, price_period, tz, tz_label_en, tz_label_ru, ref_en, ref_ru, price_en, price_ru, facts, active, created_at)
     VALUES ('general', 'General', 'sale', 0, 'USD', 'total', 'Asia/Dubai', 'Dubai time', 'время Дубая', 'this request', 'этому запросу', '', '', '{}', 1, ?)`,
    [now.toISOString()],
  );
}

function ingest(api, config, input) {
  const now = api.now();
  const channel = input.channel;
  const senderId = String(input.sender_id || '');
  if (channel === 'telegram' && !input.fixture && !allowedTestId(config, senderId)) {
    const n = Number(setting(api.store, 'dropped_non_test') || 0) + 1;
    setting(api.store, 'dropped_non_test', n);
    return { ok: true, stored: false, dropped: true };
  }
  const hash = senderHash(config.HASH_SALT, channel, senderId);
  const dedup = input.dedup_key;
  if (dedup && api.store.one('SELECT id FROM i_message WHERE dedup_key = ?', [dedup])) {
    return { ok: true, duplicate: true };
  }
  const opted = api.store.one('SELECT 1 AS n FROM i_optout WHERE channel = ? AND sender_hash = ?', [channel, hash]);
  let propertyId = input.property_id || '';
  if (!propertyId) {
    const previous = api.store.one(
      'SELECT property_id FROM i_lead WHERE channel = ? AND sender_hash = ? ORDER BY last_msg_at DESC',
      [channel, hash],
    );
    propertyId = previous?.property_id || 'general';
  }
  if (propertyId === 'general') ensureGeneral(api.store, now);
  const property = propertyRow(api.store, propertyId);
  const analysis = analyze(
    { kind: input.kind || 'text', text: input.text || '', non_text_type: input.non_text_type },
    { propertyKind: property?.kind, propertyCurrency: property?.currency, senderName: input.sender_name },
  );
  const scored = scoreChat(analysis, property, config.AED_PER_USD);
  const flags = [...analysis.flags];
  if (scored.budget_low && !flags.includes('budget_low')) flags.push('budget_low');
  const existing = api.store.one(
    'SELECT * FROM i_lead WHERE channel = ? AND sender_hash = ? AND property_id = ?',
    [channel, hash, propertyId],
  );
  const carried = carry(existing, analysis);
  const status = opted || analysis.intent === 'stop'
    ? 'stopped'
    : (analysis.intent === 'unclear' || flags.includes('review') || flags.includes('lang_other') || flags.includes('injection_suspect') || flags.includes('non_text')
      ? 'review'
      : 'pending_approval');
  const leadId = existing?.id || input.lead_id || `L-${crypto.randomBytes(4).toString('hex')}`;
  const msgId = `M-${crypto.randomBytes(4).toString('hex')}`;
  const when = input.received_at || now.toISOString();
  if (!existing) {
    api.store.run(
      `INSERT INTO i_lead (id, channel, sender_hash, sender_name, reply_target, property_id, language, intent, also_json, asks_discount,
        budget_amount, budget_currency, budget_period, timing_class, timing_label, cash, flags, non_text_type, score, grade, reasons,
        analysis_source, status, pipeline, optout, first_msg_at, last_msg_at, last_inbound_message_id, retention_until, business_connection_id, clean_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId, channel, hash, input.sender_name || '', input.reply_target || null, propertyId,
        carried.language, carried.intent, JSON.stringify(carried.also), carried.asks_discount ? 1 : 0,
        carried.budget?.amount ?? null, carried.budget?.currency || null, carried.budget?.period || null,
        carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0,
        JSON.stringify(flags), input.non_text_type || null, scored.score, scored.grade, JSON.stringify(scored.reasons),
        analysis.source, status, status === 'stopped' ? 1 : 0, when, when, msgId,
        new Date(Date.parse(when) + config.RETENTION_DAYS * 86400000).toISOString(),
        input.business_connection_id || null, analysis.name.name,
      ],
    );
  } else if (input.skip_reanalyze) {
    api.store.run('UPDATE i_lead SET last_msg_at = ? WHERE id = ?', [when, leadId]);
  } else {
    api.store.run(
      `UPDATE i_lead SET sender_name=?, language=?, intent=?, also_json=?, asks_discount=?, budget_amount=?, budget_currency=?, budget_period=?,
        timing_class=?, timing_label=?, cash=?, flags=?, non_text_type=?, score=?, grade=?, reasons=?, analysis_source=?, status=?, optout=?,
        last_msg_at=?, last_inbound_message_id=?, clean_name=?, business_connection_id=COALESCE(?, business_connection_id) WHERE id=?`,
      [
        input.sender_name || existing.sender_name, carried.language, carried.intent, JSON.stringify(carried.also),
        carried.asks_discount ? 1 : 0, carried.budget?.amount ?? null, carried.budget?.currency || null, carried.budget?.period || null,
        carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0, JSON.stringify(flags),
        input.non_text_type || null, scored.score, scored.grade, JSON.stringify(scored.reasons), analysis.source,
        status, status === 'stopped' ? 1 : 0, when, msgId, analysis.name.name, input.business_connection_id || null, leadId,
      ],
    );
    api.store.run('DELETE FROM i_draft WHERE lead_id = ?', [leadId]);
  }
  api.store.run(
    `INSERT INTO i_message (id, lead_id, direction, text, kind, channel_msg_id, dedup_key, created_at) VALUES (?, ?, 'in', ?, ?, ?, ?, ?)`,
    [msgId, leadId, input.text || '', input.kind || 'text', input.channel_msg_id || null, dedup || null, when],
  );
  if (analysis.intent === 'stop') {
    api.store.run(
      'INSERT INTO i_optout (channel, sender_hash, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [channel, hash, now.toISOString()],
    );
    api.store.run('UPDATE i_lead SET status = ?, optout = 1 WHERE channel = ? AND sender_hash = ?', ['stopped', channel, hash]);
    audit(api.store, config, 'stop', leadId, { channel }, 'system');
  }
  return { ok: true, lead_id: leadId, message_id: msgId, status, duplicate: false, stored: true };
}

function carry(existing, analysis) {
  if (!existing || analysis.intent === 'stop') return analysis;
  const next = { ...analysis, also: analysis.also || [] };
  if (!next.budget && existing.budget_amount != null) {
    next.budget = { amount: existing.budget_amount, currency: existing.budget_currency, period: existing.budget_period };
  }
  if (!next.timing && existing.timing_class) {
    next.timing = { class: existing.timing_class, label_en: existing.timing_label, label_ru: existing.timing_label };
  }
  if (!next.cash && existing.cash) next.cash = true;
  return next;
}

function loadLead(store, id) {
  const row = store.one('SELECT * FROM i_lead WHERE id = ?', [id]);
  if (!row) return null;
  return {
    ...row,
    also: JSON.parse(row.also_json || '[]'),
    flags: JSON.parse(row.flags || '[]'),
    reasons: JSON.parse(row.reasons || '[]'),
    asks_discount: row.asks_discount === 1,
    cash: row.cash === 1,
    optout: row.optout === 1,
    budget: row.budget_amount == null ? null : { amount: row.budget_amount, currency: row.budget_currency, period: row.budget_period },
    timing: row.timing_class ? { class: row.timing_class, label_en: row.timing_label, label_ru: row.timing_label } : null,
  };
}

function presentLead(api, config, id) {
  const lead = loadLead(api.store, id);
  if (!lead) return null;
  const property = propertyRow(api.store, lead.property_id);
  const analysis = {
    intent: lead.intent,
    also: lead.also,
    language: lead.language,
    asks_discount: lead.asks_discount,
    budget: lead.budget,
    timing: lead.timing,
    cash: lead.cash,
    flags: lead.flags,
  };
  const slots = property ? listFreeSlots(api.store, property, api.now()) : [];
  const options = lead.status === 'stopped' ? [] : buildOptions({ analysis, clean_name: lead.clean_name }, property, slots);
  const draft = api.store.one('SELECT * FROM i_draft WHERE lead_id = ?', [id]);
  const messages = api.store.all('SELECT id, direction, text, kind, created_at, deleted FROM i_message WHERE lead_id = ? ORDER BY created_at', [id]);
  const sends = api.store.all('SELECT status, fail_reason FROM i_send WHERE lead_id = ?', [id]);
  return {
    ...lead,
    property,
    options: lead.status === 'review' || lead.status === 'stopped' ? [] : options,
    manual_allowed: lead.status === 'review',
    draft,
    messages: messages.map((row) => ({ ...row, text: row.deleted ? '' : row.text })),
    slots,
    stale_sending: sends.some((row) => row.fail_reason === 'stale_sending'),
    events: humanEvents(api, lead),
  };
}

function listPresent(api) {
  const leads = api.store.all('SELECT id FROM i_lead').map((row) => loadLead(api.store, row.id));
  const rank = (lead) => (lead.status === 'stopped' ? 2 : lead.status === 'sent' ? 1 : 0);
  const grade = { HOT: 0, WARM: 1, COLD: 2 };
  return leads.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if ((grade[a.grade] ?? 9) !== (grade[b.grade] ?? 9)) return (grade[a.grade] ?? 9) - (grade[b.grade] ?? 9);
    if (b.score !== a.score) return b.score - a.score;
    return String(a.first_msg_at).localeCompare(String(b.first_msg_at));
  });
}

function humanEvents(api, lead) {
  const rows = api.store.all('SELECT action, ts FROM i_audit WHERE lead_id = ? ORDER BY id', [lead.id]);
  const labels = {
    stop: 'Opted out with STOP',
    send: lead.channel === 'telegram' ? 'Sent via Telegram (simulated)' : 'Sent via WhatsApp (simulated)',
    manual_send: 'Reply sent manually',
    reject: 'Not sent',
    viewing_book: 'Viewing booked (unconfirmed)',
    send_failed: 'Send failed, tried again',
  };
  const events = [{ action: 'inbound', label: lead.channel === 'telegram' ? 'Lead wrote on Telegram' : 'Lead wrote on WhatsApp' }];
  events.push({ action: 'grade', label: `Marked ${lead.grade} ${lead.score}` });
  for (const row of rows) {
    if (labels[row.action]) events.push({ action: row.action, label: labels[row.action], ts: row.ts });
    if (row.action === 'send_failed') events.push({ action: 'stale', label: 'Previous attempt state unknown, check the chat' });
  }
  if (lead.flags?.includes('non_text')) events.push({ action: 'non_text', label: 'Client sent a photo. Open the chat.' });
  return events;
}

function saveDraft(api, config, leadId, body) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return { ok: false, status: 404, error_code: 'not_found' };
  if (lead.status === 'stopped') return { ok: false, status: 409, error_code: 'lead_stopped' };
  if (!['pending_approval', 'review'].includes(lead.status)) return { ok: false, status: 409, error_code: 'not_pending' };
  const current = api.store.one('SELECT version FROM i_draft WHERE lead_id = ?', [leadId]);
  if (body.base_version != null && current && Number(body.base_version) !== current.version) {
    return { ok: false, status: 409, error_code: 'draft_changed' };
  }
  const text = String(body.text || '');
  if (text.length > 1000) return { ok: false, status: 400, error_code: 'draft_too_long' };
  const version = (current?.version || 0) + 1;
  api.store.run(
    `INSERT INTO i_draft (lead_id, option_id, text, slot_ids, edited, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lead_id) DO UPDATE SET option_id=excluded.option_id, text=excluded.text, slot_ids=excluded.slot_ids, edited=excluded.edited, version=excluded.version, updated_at=excluded.updated_at`,
    [leadId, body.option_id ?? null, text, JSON.stringify(body.slot_ids || []), body.edited ? 1 : 0, version, api.now().toISOString()],
  );
  audit(api.store, config, 'draft', leadId, { edited: body.edited === true }, 'broker');
  return { ok: true, version };
}

function finalText(lead, text, _manual, config) {
  const ru = lead.language === 'ru';
  const stop = ru ? (config.STOP_NOTE_RU || STOP_RU) : (config.STOP_NOTE_EN || STOP_EN);
  const ai = ru ? (config.AI_NOTE_RU || AI_RU) : (config.AI_NOTE_EN || AI_EN);
  let body = String(text || '').trim();
  if (!body.includes(ai)) body = `${body}\n${ai}`;
  if (!body.includes(stop)) body = `${body}\n${stop}`;
  return body;
}

function sendLead(api, config, leadId, body, actor) {
  const key = body.idempotency_key;
  if (!key) return { ok: false, status: 400, error_code: 'idempotency_required' };
  const prior = api.store.one('SELECT response FROM i_idem WHERE key = ?', [key]);
  if (prior) return JSON.parse(prior.response);
  sweepSending(api, config);
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.optout || lead.status === 'stopped') return fail(409, 'lead_stopped');
  const draft = api.store.one('SELECT * FROM i_draft WHERE lead_id = ?', [leadId]);
  if (!draft || !String(draft.text || '').trim()) return fail(400, 'empty_draft');
  if (body.draft_version != null && Number(body.draft_version) !== draft.version) return fail(409, 'draft_changed');
  const manual = body.manual === true || draft.option_id == null;
  if (lead.status === 'review' && !manual) return fail(400, 'manual_required');
  if (draft.option_id == null && body.manual !== true) return fail(400, 'manual_required');
  const text = finalText(lead, draft.text, manual, config);
  if (text.length > 1200) return fail(400, 'draft_too_long');
  const draftHash = crypto.createHash('sha256').update(text).digest('hex');
  const replyTo = lead.last_inbound_message_id;
  const clash = api.store.one(
    `SELECT status FROM i_send WHERE lead_id = ? AND reply_to_message_id = ? AND draft_hash = ?`,
    [leadId, replyTo, draftHash],
  );
  if (clash && clash.status !== 'failed') return fail(409, 'duplicate_send');
  const gate = businessGate(api, lead);
  if (!gate.ok) return fail(409, gate.error_code);
  if (!['pending_approval', 'review'].includes(lead.status)) return fail(409, 'not_pending');
  const hourAgo = new Date(api.now().getTime() - 3600000).toISOString();
  const sentN = api.store.one(
    `SELECT COUNT(*) AS n FROM i_send WHERE created_at >= ? AND status IN ('simulated','sent')`,
    [hourAgo],
  ).n;
  if (sentN >= config.MAX_REPLIES_PER_HOUR) return fail(429, 'rate_limited');
  const property = propertyRow(api.store, lead.property_id);
  const slots = property ? listFreeSlots(api.store, property, api.now()) : [];
  const wanted = JSON.parse(draft.slot_ids || '[]');
  if (wanted.length && wanted.some((id) => !slots.some((slot) => slot.id === id))) return fail(409, 'slot_unavailable');
  const sendId = `S-${crypto.randomBytes(4).toString('hex')}`;
  const now = api.now().toISOString();
  return api.store.transaction(() => {
    if (clash && clash.status === 'failed') {
      api.store.run(
        `UPDATE i_send SET status='sending', fail_reason=NULL, idempotency_key=?, updated_at=? WHERE lead_id=? AND reply_to_message_id=? AND draft_hash=?`,
        [key, now, leadId, replyTo, draftHash],
      );
    } else {
      api.store.run(
        `INSERT INTO i_send (send_id, lead_id, reply_to_message_id, draft_hash, manual, idempotency_key, status, channel, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)`,
        [sendId, leadId, replyTo, draftHash, manual ? 1 : 0, key, lead.channel, now, now],
      );
    }
    const delivered = channel.send({ lead, text });
    const simulated = delivered.simulated || config.CHANNEL_MODE !== 'test_live';
    api.store.run(
      `UPDATE i_send SET status=?, updated_at=? WHERE lead_id=? AND reply_to_message_id=? AND draft_hash=?`,
      [simulated ? 'simulated' : 'sent', now, leadId, replyTo, draftHash],
    );
    api.store.run(
      `INSERT INTO i_message (id, lead_id, direction, text, kind, option_id, created_at) VALUES (?, ?, 'out', ?, 'text', ?, ?)`,
      [`O-${crypto.randomBytes(3).toString('hex')}`, leadId, text, draft.option_id, now],
    );
    api.store.run(`UPDATE i_lead SET status='sent' WHERE id=?`, [leadId]);
    audit(api.store, config, manual ? 'manual_send' : 'send', leadId, { simulated }, actor || 'broker');
    const response = { ok: true, status: 200, simulated, send_id: sendId, lead_status: 'sent' };
    api.store.run('INSERT INTO i_idem (key, route, response, created_at) VALUES (?, ?, ?, ?)', [key, 'send', JSON.stringify(response), now]);
    return response;
  });
}

function businessGate(api, lead) {
  if (!lead.business_connection_id) return { ok: true };
  const conn = api.store.one('SELECT * FROM i_tg_conn WHERE business_connection_id = ?', [lead.business_connection_id]);
  if (!conn || conn.can_reply !== 1 || conn.is_enabled === 0) return { ok: false, error_code: 'cannot_reply' };
  const age = api.now().getTime() - Date.parse(lead.last_msg_at || 0);
  if (age > 24 * 3600 * 1000) return { ok: false, error_code: 'window_closed' };
  return { ok: true };
}

function fail(status, error_code) {
  return { ok: false, status, error_code };
}

function rejectLead(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.status === 'stopped') return fail(409, 'lead_stopped');
  api.store.run(`UPDATE i_lead SET status='review' WHERE id=?`, [leadId]);
  api.store.run('DELETE FROM i_draft WHERE lead_id=?', [leadId]);
  audit(api.store, config, 'reject', leadId, {}, actor || 'broker');
  return { ok: true, status: 'review' };
}

function validZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function periodOf(value) {
  if (value === 'once') return 'total';
  return value;
}

function propertyError(body) {
  const period = periodOf(body.price_period);
  const price = Number(body.price);
  if (!body.title || typeof body.title !== 'string') return 'invalid_property';
  if (!['rent', 'sale'].includes(body.kind)) return 'invalid_property';
  if (!Number.isFinite(price) || price <= 0) return 'invalid_property';
  if (!['USD', 'AED'].includes(body.currency)) return 'invalid_property';
  if (!['year', 'month', 'total'].includes(period)) return 'invalid_property';
  if (body.kind === 'sale' && period !== 'total') return 'invalid_property';
  if (body.kind === 'rent' && !['year', 'month'].includes(period)) return 'invalid_property';
  if (body.area_unit != null && body.area_unit !== '' && !['sqft', 'sqm'].includes(body.area_unit)) return 'invalid_property';
  if (!validZone(body.tz)) return 'invalid_timezone';
  return '';
}

function addProperty(api, config, body, actor) {
  const problem = propertyError(body);
  if (problem) return fail(400, problem);
  const period = periodOf(body.price_period);
  const id = body.id || `P-${crypto.randomBytes(3).toString('hex')}`;
  const price = formatPair({ ...body, price_period: period });
  api.store.run(
    `INSERT INTO i_property (id, title, kind, price, currency, price_period, tz, tz_label_en, tz_label_ru, area_value, area_unit, ref_en, ref_ru, price_en, price_ru, facts, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, body.title, body.kind, Number(body.price), body.currency, period, body.tz, body.tz_label_en || null, body.tz_label_ru || null,
      body.area_value || null, body.area_unit || null, body.ref_en || body.title, body.ref_ru || body.title,
      price.en, price.ru, JSON.stringify(body.facts || {}), api.now().toISOString()],
  );
  audit(api.store, config, 'property_add', null, { property_id: id }, actor || 'broker');
  return { ok: true, id };
}

function formatPair(body) {
  const property = { price: body.price, currency: body.currency, price_period: body.price_period };
  return { en: formatPrice(property, 'en'), ru: formatPrice(property, 'ru') };
}

function addSlot(api, config, propertyId, body, actor) {
  const property = propertyRow(api.store, propertyId);
  if (!property) return fail(404, 'not_found');
  const duration = body.duration_min == null ? 45 : Number(body.duration_min);
  if (![30, 45, 60].includes(duration)) return fail(400, 'invalid_slot');
  if (!body.start_utc || Number.isNaN(Date.parse(body.start_utc))) return fail(400, 'invalid_slot');
  const check = assertSlot(api.store, property, body.start_utc, duration, api.now());
  if (!check.ok) return { ok: false, status: 400, error_code: check.error_code };
  const id = `SL-${crypto.randomBytes(3).toString('hex')}`;
  api.store.run(
    `INSERT INTO i_slot (id, property_id, start_utc, duration_min, status, created_at) VALUES (?, ?, ?, ?, 'free', ?)`,
    [id, propertyId, check.start, duration, api.now().toISOString()],
  );
  audit(api.store, config, 'slot_add', null, { property_id: propertyId }, actor || 'broker');
  return { ok: true, id };
}

function bookViewing(api, config, leadId, slotId, actor) {
  const lead = loadLead(api.store, leadId);
  const slot = slotId ? api.store.one('SELECT * FROM i_slot WHERE id = ?', [slotId]) : null;
  if (!lead || !slot) return fail(404, 'not_found');
  if (slot.status !== 'free' || Date.parse(slot.start_utc) <= api.now().getTime()) return fail(409, 'slot_unavailable');
  const id = `V-${crypto.randomBytes(3).toString('hex')}`;
  api.store.run(
    `INSERT INTO i_viewing (id, lead_id, property_id, slot_id, start_utc, status, created_at) VALUES (?, ?, ?, ?, ?, 'unconfirmed', ?)`,
    [id, leadId, slot.property_id, slotId, slot.start_utc, api.now().toISOString()],
  );
  audit(api.store, config, 'viewing_book', leadId, { slot_id: slotId }, actor || 'broker');
  return { ok: true, id, status: 'unconfirmed' };
}

function setViewing(api, config, id, status, actor) {
  if (!['confirmed', 'cancelled'].includes(status)) return fail(400, 'invalid_viewing');
  const row = api.store.one('SELECT * FROM i_viewing WHERE id = ?', [id]);
  if (!row) return fail(404, 'not_found');
  api.store.run('UPDATE i_viewing SET status = ? WHERE id = ?', [status, id]);
  if (status === 'confirmed') api.store.run(`UPDATE i_slot SET status='booked' WHERE id=?`, [row.slot_id]);
  audit(api.store, config, status === 'confirmed' ? 'viewing_confirm' : 'viewing_cancel', row.lead_id, { viewing_id: id }, actor || 'broker');
  return { ok: true, status };
}

function updateSettings(api, config, body, actor) {
  if (body.manual_approval === false || body.auto_send_hot === true) return fail(409, 'locked');
  if (body.lang != null && !['en', 'ru'].includes(body.lang)) return fail(400, 'invalid_settings');
  if (body.broker_tz != null && !validZone(body.broker_tz)) return fail(400, 'invalid_timezone');
  for (const key of ['lang', 'broker_name', 'broker_tz']) {
    if (body[key] != null) setting(api.store, key, String(body[key]));
  }
  audit(api.store, config, 'settings_change', null, { keys: Object.keys(body) }, actor || 'broker');
  return { ok: true, settings: readSettings(api.store) };
}

function buildDigest(api, config) {
  const now = api.now();
  const zone = config.BROKER_TZ || 'Asia/Dubai';
  const leads = api.store.all('SELECT id FROM i_lead').map((row) => loadLead(api.store, row.id));
  const waiting = leads.filter((lead) => lead.status !== 'stopped' && lead.status !== 'sent' && !lead.optout);
  const ordered = sortLeads(waiting, 'digest');
  const writeFirst = ordered.map((lead) => ({
    id: lead.id,
    name: lead.clean_name || lead.sender_name,
    grade: lead.grade,
    property_id: lead.property_id,
    waiting_minutes: Math.round((now.getTime() - Date.parse(lead.first_msg_at)) / 60000),
  }));
  const today = DateTime.fromJSDate(now, { zone }).toISODate();
  const viewings = api.store.all(`SELECT * FROM i_viewing WHERE status != 'cancelled'`).filter((row) => {
    return DateTime.fromISO(row.start_utc, { setZone: true }).setZone(zone).toISODate() === today;
  });
  const hot = leads.filter((lead) => lead.grade === 'HOT' && lead.pipeline !== 'closed' && !lead.optout && lead.status !== 'stopped');
  const seen = new Set();
  const groups = {};
  for (const lead of hot) {
    if (seen.has(lead.property_id)) continue;
    seen.add(lead.property_id);
    const property = propertyRow(api.store, lead.property_id);
    if (!property || !property.price) continue;
    const key = `${property.kind}|${property.currency}|${property.price_period}`;
    groups[key] = groups[key] || { kind: property.kind, currency: property.currency, period: property.price_period, sum: 0 };
    groups[key].sum += property.price;
  }
  return {
    ok: true,
    write_first: writeFirst.slice(0, 5),
    write_first_full: writeFirst,
    viewings_today: viewings,
    listed_value: Object.values(groups),
    note: 'Sum of listing prices, not revenue, commission or forecast',
    empty: writeFirst.length === 0,
  };
}

function runDigest(api, config, reason, actorId) {
  const zone = config.BROKER_TZ || 'Asia/Dubai';
  const local = DateTime.fromJSDate(api.now(), { zone });
  const today = local.toISODate();
  const sentOn = setting(api.store, 'digest_last_sent_date');
  const count = Number(setting(api.store, 'digest_sent_count') || 0);
  if (reason === 'demand') {
    const allowed = new Set(config.TELEGRAM_ALLOWED_USER_IDS || []);
    if (!allowed.has(String(actorId || ''))) return { ok: false, digest_sent_on_demand: false };
    audit(api.store, config, 'digest_sent', null, { on_demand: true }, String(actorId));
    return { ok: true, digest_sent_on_demand: true, digest: buildDigest(api, config) };
  }
  const [hour, minute] = String(config.DIGEST_TIME || '08:30').split(':').map(Number);
  const due = local.hour > hour || (local.hour === hour && local.minute >= minute);
  if (!due || sentOn === today) return { ok: true, digest_sent: count, skipped: sentOn === today };
  const onTheMinute = local.hour === hour && local.minute === minute && reason === 'schedule';
  const label = onTheMinute ? '' : 'late';
  setting(api.store, 'digest_last_sent_date', today);
  setting(api.store, 'digest_sent_count', count + 1);
  setting(api.store, 'digest_last_label', label);
  audit(api.store, config, 'digest_sent', null, { label: label || 'on_time' }, 'system');
  return { ok: true, digest_sent: count + 1, label, digest: buildDigest(api, config) };
}

function seedMessages(api, config, pack, mode) {
  const skip = new Set(mode === 'minus_t06' ? ['T06'] : []);
  for (const [id, property] of Object.entries(pack.meta.properties)) addFixtureProperty(api, { ...property, id });
  addFixtureSlots(api, pack, api.now());
  for (const message of pack.messages) {
    if (skip.has(message.id)) continue;
    ingest(api, config, {
      channel: message.channel,
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      text: message.text,
      property_id: message.property_id,
      received_at: message.received_at,
      dedup_key: `seed:${message.id}`,
      reply_target: message.channel === 'wa_sim' ? message.sender_id : null,
      fixture: true,
      lead_id: message.id,
    });
  }
  addDemoViewings(api);
  const counts = { HOT: 0, WARM: 0, COLD: 0 };
  for (const row of api.store.all('SELECT grade FROM i_lead')) counts[row.grade] += 1;
  return counts;
}

function addDemoViewings(api) {
  const plan = [
    { leadId: 'T02', status: 'confirmed', nth: 0 },
    { leadId: 'T20', status: 'unconfirmed', nth: 1 },
  ];
  for (const item of plan) {
    const id = `V-demo-${item.leadId}`;
    const existing = api.store.one('SELECT slot_id FROM i_viewing WHERE id = ?', [id]);
    if (existing) {
      api.store.run(`UPDATE i_slot SET status = 'free' WHERE id = ? AND status = 'booked'`, [existing.slot_id]);
      api.store.run('DELETE FROM i_viewing WHERE id = ?', [id]);
    }
    const lead = api.store.one('SELECT id, property_id FROM i_lead WHERE id = ?', [item.leadId]);
    if (!lead) continue;
    const slot = api.store.all(
      `SELECT * FROM i_slot WHERE property_id = ? AND status != 'removed' ORDER BY start_utc`,
      [lead.property_id],
    )[item.nth];
    if (!slot) continue;
    api.store.run(
      `INSERT INTO i_viewing (id, lead_id, property_id, slot_id, start_utc, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, lead.id, lead.property_id, slot.id, slot.start_utc, item.status, api.now().toISOString()],
    );
    if (item.status === 'confirmed') api.store.run(`UPDATE i_slot SET status = 'booked' WHERE id = ?`, [slot.id]);
  }
}

function addFixtureProperty(api, property) {
  if (propertyRow(api.store, property.id)) return;
  addProperty(api, {}, {
    id: property.id,
    title: property.title,
    kind: property.kind,
    price: property.price,
    currency: property.cur,
    price_period: property.period,
    tz: property.tz,
    tz_label_en: property.tz_label_en,
    tz_label_ru: property.tz_label_ru,
    ref_en: property.ref_en,
    ref_ru: property.ref_ru,
    area_value: property.facts?.area_value,
    area_unit: property.facts?.area_unit,
    facts: property.facts || {},
  }, 'system');
  api.store.run('UPDATE i_property SET price_en=?, price_ru=? WHERE id=?', [property.price_en, property.price_ru, property.id]);
}

function addFixtureSlots(api, pack, now) {
  const fixtureNow = DateTime.fromISO(pack.meta.now, { setZone: true });
  const current = DateTime.fromJSDate(now, { zone: 'Asia/Dubai' });
  const shiftDays = Math.round(current.startOf('day').diff(fixtureNow.setZone('Asia/Dubai').startOf('day'), 'days').days);
  for (const [id, property] of Object.entries(pack.meta.properties)) {
    for (const start of property.slots || []) {
      const shifted = DateTime.fromISO(start, { setZone: true }).plus({ days: shiftDays }).toUTC().toISO();
      if (api.store.one('SELECT id FROM i_slot WHERE property_id=? AND start_utc=?', [id, shifted])) continue;
      if (Date.parse(shifted) <= now.getTime()) continue;
      const slotId = `SL-${id}-${start.slice(0, 13)}`;
      api.store.run(
        `INSERT INTO i_slot (id, property_id, start_utc, duration_min, status, created_at) VALUES (?, ?, ?, 45, 'free', ?)`,
        [slotId, id, shifted, now.toISOString()],
      );
    }
  }
}

function setPipeline(api, config, leadId, pipeline, actor) {
  if (!['open', 'viewing', 'closed'].includes(pipeline)) return fail(400, 'invalid_pipeline');
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  api.store.run('UPDATE i_lead SET pipeline = ? WHERE id = ?', [pipeline, leadId]);
  audit(api.store, config, 'status', leadId, { pipeline }, actor || 'broker');
  return { ok: true, pipeline };
}

function sweepRetention(api) {
  const now = api.now().toISOString();
  const leads = api.store.all(
    `SELECT id FROM i_lead WHERE retention_until IS NOT NULL AND retention_until < ?`,
    [now],
  );
  for (const lead of leads) {
    api.store.run(`UPDATE i_message SET text = '', deleted = 1 WHERE lead_id = ?`, [lead.id]);
    api.store.run(`UPDATE i_lead SET sender_name = '', clean_name = '', reply_target = NULL WHERE id = ?`, [lead.id]);
    api.store.run('DELETE FROM i_draft WHERE lead_id = ?', [lead.id]);
  }
  return leads.length;
}

function eraseSender(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  const leads = api.store.all('SELECT id FROM i_lead WHERE channel = ? AND sender_hash = ?', [lead.channel, lead.sender_hash]);
  for (const row of leads) {
    api.store.run('DELETE FROM i_message WHERE lead_id = ?', [row.id]);
    api.store.run('DELETE FROM i_draft WHERE lead_id = ?', [row.id]);
    api.store.run('DELETE FROM i_send WHERE lead_id = ?', [row.id]);
    api.store.run('DELETE FROM i_viewing WHERE lead_id = ?', [row.id]);
    api.store.run('DELETE FROM i_lead WHERE id = ?', [row.id]);
    audit(api.store, config, 'erase', row.id, {}, actor || 'broker');
  }
  const kept = api.store.one('SELECT channel FROM i_optout WHERE channel = ? AND sender_hash = ?', [lead.channel, lead.sender_hash]);
  return { ok: true, erased: leads.length, optout_kept: Boolean(kept) };
}

function sweepSending(api, config) {
  const ttl = (config.SENDING_TTL_SEC || 120) * 1000;
  const cutoff = new Date(api.now().getTime() - ttl).toISOString();
  const rows = api.store.all(`SELECT send_id, lead_id FROM i_send WHERE status='sending' AND created_at < ?`, [cutoff]);
  for (const row of rows) {
    api.store.run(`UPDATE i_send SET status='failed', fail_reason='stale_sending', updated_at=? WHERE send_id=?`, [api.now().toISOString(), row.send_id]);
    audit(api.store, config, 'send_failed', row.lead_id, { reason: 'stale_sending' }, 'system');
  }
  return rows.length;
}

function allowedTestId(config, senderId) {
  const ids = new Set((config.TG_TEST_LEAD_IDS || []).map(String));
  return ids.has(String(senderId));
}

function applyTelegram(api, config, update) {
  if (update.update_id != null) {
    const seen = api.store.one('SELECT update_id FROM i_tg_update WHERE update_id=?', [update.update_id]);
    if (seen) return { ok: true, duplicate: true };
    api.store.run('INSERT INTO i_tg_update (update_id) VALUES (?)', [update.update_id]);
  }
  if (update.business_connection) {
    const row = update.business_connection;
    api.store.run(
      `INSERT INTO i_tg_conn (business_connection_id, can_reply, is_enabled, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(business_connection_id) DO UPDATE SET can_reply=excluded.can_reply, is_enabled=excluded.is_enabled, updated_at=excluded.updated_at`,
      [row.id, row.rights?.can_reply ? 1 : 0, row.is_enabled ? 1 : 0, api.now().toISOString()],
    );
  }
  const edited = update.edited_business_message;
  if (edited) return editBusiness(api, config, edited);
  const deleted = update.deleted_business_messages;
  if (deleted) {
    const chatId = String(deleted.chat?.id || '');
    if (!chatId) return { ok: false, status: 400, error_code: 'chat_required' };
    for (const id of deleted.message_ids || []) {
      api.store.run(
        `UPDATE i_message SET text = '', deleted = 1 WHERE dedup_key = ?`,
        [`telegram:${chatId}:${id}`],
      );
    }
    return { ok: true, deleted: true };
  }
  const message = update.message || update.business_message;
  if (!message) return { ok: true, ignored: true };
  const chatId = String(message.chat?.id || '');
  if (String(message.text || '').trim() === '/digest') {
    const allowed = new Set((config.TELEGRAM_ALLOWED_USER_IDS || []).map(String));
    if (!allowed.has(chatId)) return { ok: false, error_code: 'forbidden', digest_sent_on_demand: false };
    const result = runDigest(api, config, 'demand', chatId);
    return { ...result, sent: false, telegram_delivery: false };
  }
  if (!allowedTestId(config, chatId)) {
    const n = Number(setting(api.store, 'dropped_non_test') || 0) + 1;
    setting(api.store, 'dropped_non_test', n);
    return { ok: true, stored: false, text: 'This bot is not public.' };
  }
  const text = message.text || '';
  const leadCmd = text.match(/^\/lead\s+(P\d+)\s+([\s\S]+)$/);
  const propertyId = leadCmd ? leadCmd[1] : (message.property_id || '');
  const body = leadCmd ? leadCmd[2] : text;
  const kind = message.photo || message.voice || message.location ? 'non_text' : 'text';
  if (message.business_connection_id) {
    const known = api.store.one(
      'SELECT business_connection_id FROM i_tg_conn WHERE business_connection_id = ?',
      [message.business_connection_id],
    );
    if (!known) {
      api.store.run(
        `INSERT INTO i_tg_conn (business_connection_id, can_reply, is_enabled, updated_at) VALUES (?, NULL, NULL, ?)`,
        [message.business_connection_id, api.now().toISOString()],
      );
    }
  }
  const received = message.date ? new Date(message.date * 1000) : api.now();
  return ingest(api, config, {
    channel: 'telegram',
    sender_id: chatId,
    sender_name: message.from?.first_name || 'Telegram',
    text: body,
    property_id: propertyId,
    kind,
    non_text_type: message.photo ? 'photo' : message.voice ? 'voice' : message.location ? 'location' : null,
    dedup_key: `telegram:${chatId}:${message.message_id}`,
    channel_msg_id: String(message.message_id),
    reply_target: chatId,
    business_connection_id: message.business_connection_id || null,
    received_at: received.toISOString(),
  });
}

function editBusiness(api, config, message) {
  const chatId = String(message.chat?.id || '');
  const row = api.store.one('SELECT * FROM i_message WHERE dedup_key = ?', [`telegram:${chatId}:${message.message_id}`]);
  if (!row) return { ok: true, missing: true };
  api.store.run('UPDATE i_message SET text=?, edited=1 WHERE id=?', [message.text || '', row.id]);
  const lead = loadLead(api.store, row.lead_id);
  if (!lead) return { ok: true };
  const property = propertyRow(api.store, lead.property_id);
  const analysis = analyze(
    { kind: 'text', text: message.text || '' },
    { propertyKind: property?.kind, propertyCurrency: property?.currency, senderName: lead.sender_name },
  );
  const scored = scoreChat(analysis, property, config.AED_PER_USD);
  const flags = [...analysis.flags];
  if (scored.budget_low && !flags.includes('budget_low')) flags.push('budget_low');
  const carried = carry(lead, analysis);
  const opted = api.store.one('SELECT 1 AS n FROM i_optout WHERE channel = ? AND sender_hash = ?', [lead.channel, lead.sender_hash]);
  let status = analysis.intent === 'stop'
    ? 'stopped'
    : (analysis.intent === 'unclear' || flags.includes('review') || flags.includes('lang_other') || flags.includes('injection_suspect') || flags.includes('non_text')
      ? 'review'
      : 'pending_approval');
  if (opted && analysis.intent !== 'stop') status = 'stopped';
  api.store.run(
    `UPDATE i_lead SET language=?, intent=?, also_json=?, asks_discount=?, budget_amount=?, budget_currency=?, budget_period=?,
      timing_class=?, timing_label=?, cash=?, flags=?, score=?, grade=?, reasons=?, analysis_source=?, status=?, optout=? WHERE id=?`,
    [
      carried.language, carried.intent, JSON.stringify(carried.also), carried.asks_discount ? 1 : 0,
      carried.budget?.amount ?? null, carried.budget?.currency || null, carried.budget?.period || null,
      carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0,
      JSON.stringify(flags), scored.score, scored.grade, JSON.stringify(scored.reasons), analysis.source,
      status, status === 'stopped' ? 1 : 0, lead.id,
    ],
  );
  api.store.run('DELETE FROM i_draft WHERE lead_id = ?', [lead.id]);
  if (analysis.intent === 'stop') {
    api.store.run(
      'INSERT INTO i_optout (channel, sender_hash, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [lead.channel, lead.sender_hash, api.now().toISOString()],
    );
    api.store.run('UPDATE i_lead SET status = ?, optout = 1 WHERE channel = ? AND sender_hash = ?', ['stopped', lead.channel, lead.sender_hash]);
    audit(api.store, config, 'stop', lead.id, { channel: lead.channel, edited: true }, 'system');
  }
  return { ok: true, same_lead: true, lead_id: lead.id, status };
}

module.exports = {
  createIntl,
  senderHash,
  AI_EN,
  AI_RU,
  STOP_EN,
  STOP_RU,
};
