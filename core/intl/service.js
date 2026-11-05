'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { analyze } = require('./analyze');
const { scoreChat, sortLeads } = require('./score');
const { classifyReadiness, readinessRank } = require('./readiness');
const { parseProposal } = require('./when');
const { matchProperty } = require('./matchProperty');
const { brochurePdf } = require('./brochure');
const { createBrokerCalendar } = require('./calendar');
const { buildOptions, formatPrice, slotPhrase, rewriteReplyTime } = require('./options');
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
  const calendar = options.calendar || createBrokerCalendar(config, {
    now: () => clock(),
    busy: options.busy,
    getBusy: options.getBusy,
    timeoutMs: options.timeoutMs,
    zone: config.BROKER_TZ,
    lunch: options.lunch,
  });
  let chain = Promise.resolve();
  const lock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const api = {
    store,
    clock,
    calendar,
    close() { store.close(); },
    now() { return clock(); },
    setClock(fn) { clock = fn; },
    digestTick(reason, actorId) { return runDigest(api, config, reason, actorId); },
    hash: senderHash,
    ingest(input) { return lock(() => ingest(api, config, input)); },
    send(leadId, body, actor) { return lock(() => sendLead(api, config, leadId, body, actor)); },
    reject(leadId, actor) { return lock(() => rejectLead(api, config, leadId, actor)); },
    archive(leadId, actor) { return lock(() => archiveLead(api, config, leadId, actor)); },
    applySlot(leadId, body) { return lock(() => applyChosenSlot(api, config, leadId, body)); },
    stop(leadId, actor) { return lock(() => stopLead(api, config, leadId, actor)); },
    saveDraft(leadId, body) { return lock(() => saveDraft(api, config, leadId, body)); },
    lead(id) { return presentLead(api, config, id); },
    leads(query) { return listPresent(api, query || {}); },
    digest() { return buildDigest(api, config); },
    addProperty(body, actor) { return lock(() => addProperty(api, config, body, actor)); },
    brochure(id) { return brochureFor(api, id); },
    publicFile(id, exp, sig) { return openPublicFile(api, config, id, exp, sig); },
    addSlot(propertyId, body, actor) { return lock(() => addSlot(api, config, propertyId, body, actor)); },
    book(leadId, slotId, actor) { return lock(() => bookViewing(api, config, leadId, slotId, actor)); },
    setViewing(id, status, actor) { return lock(() => setViewing(api, config, id, status, actor)); },
    settings(body, actor) { return lock(() => updateSettings(api, config, body, actor)); },
    settleHot(leadId) { return lock(() => {
      const settled = settleHotTime(api, config, leadId);
      if (isPromise(settled)) return settled.then(() => ({ ok: true }));
      return { ok: true };
    }); },
    getSettings() { return readSettings(store); },
    seed(messages, mode) { return lock(() => seedMessages(api, config, messages, mode)); },
    sweep() { return sweepSending(api, config); },
    compete() { return lock(() => settleOpenHot(api, config)); },
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

function catalog(store) {
  return store.all(`SELECT * FROM i_property WHERE active = 1 AND id != 'general'`).map((row) => ({
    ...row,
    facts: JSON.parse(row.facts || '{}'),
  }));
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
  let titleMatched = false;
  if (!propertyId && input.kind !== 'non_text') {
    const matched = matchProperty(input.text || '', catalog(api.store));
    if (matched) {
      propertyId = matched.id;
      titleMatched = true;
    }
  }
  if (!propertyId) propertyId = 'general';
  if (propertyId === 'general') ensureGeneral(api.store, now);
  const property = propertyRow(api.store, propertyId);
  const analysis = analyze(
    { kind: input.kind || 'text', text: input.text || '', non_text_type: input.non_text_type },
    { propertyKind: property?.kind, propertyCurrency: property?.currency, senderName: input.sender_name },
  );
  const scored = scoreChat(analysis, property, config.AED_PER_USD);
  const readiness = classifyReadiness(input.kind === 'non_text' ? '' : (input.text || ''), analysis);
  const proposed = input.kind === 'non_text'
    ? null
    : parseProposal(input.text || '', property?.tz || config.BROKER_TZ || 'Asia/Dubai', now);
  const flags = [...analysis.flags];
  if (scored.budget_low && !flags.includes('budget_low')) flags.push('budget_low');
  const existing = api.store.one(
    'SELECT * FROM i_lead WHERE channel = ? AND sender_hash = ? AND property_id = ?',
    [channel, hash, propertyId],
  );
  const carried = carry(existing, analysis);
  const bound = propertyId !== 'general' && !flags.includes('link');
  const status = replyStatus(analysis, flags, opted, titleMatched || bound);
  const leadId = existing?.id || input.lead_id || `L-${crypto.randomBytes(4).toString('hex')}`;
  const msgId = `M-${crypto.randomBytes(4).toString('hex')}`;
  const when = input.received_at || now.toISOString();
  if (!existing) {
    api.store.run(
      `INSERT INTO i_lead (id, channel, sender_hash, sender_name, reply_target, property_id, language, intent, also_json, asks_discount,
        budget_amount, budget_currency, budget_period, timing_class, timing_label, cash, flags, non_text_type, score, grade, reasons,
        analysis_source, status, pipeline, optout, first_msg_at, last_msg_at, last_inbound_message_id, retention_until, business_connection_id, clean_name, readiness, proposed_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId, channel, hash, input.sender_name || '', input.reply_target || null, propertyId,
        carried.language, carried.intent, JSON.stringify(carried.also), carried.asks_discount ? 1 : 0,
        carried.budget?.amount ?? null, carried.budget?.currency || null, carried.budget?.period || null,
        carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0,
        JSON.stringify(flags), input.non_text_type || null, scored.score, scored.grade, JSON.stringify(scored.reasons),
        analysis.source, status, status === 'stopped' ? 1 : 0, when, when, msgId,
        new Date(Date.parse(when) + config.RETENTION_DAYS * 86400000).toISOString(),
        input.business_connection_id || null, analysis.name.name, readiness.label, proposed?.start_utc || null,
      ],
    );
  } else if (input.skip_reanalyze) {
    api.store.run('UPDATE i_lead SET last_msg_at = ? WHERE id = ?', [when, leadId]);
  } else {
    api.store.run(
      `UPDATE i_lead SET sender_name=?, language=?, intent=?, also_json=?, asks_discount=?, budget_amount=?, budget_currency=?, budget_period=?,
        timing_class=?, timing_label=?, cash=?, flags=?, non_text_type=?, analysis_source=?, status=?, optout=?,
        last_msg_at=?, last_inbound_message_id=?, clean_name=?, business_connection_id=COALESCE(?, business_connection_id),
        proposed_utc=? WHERE id=?`,
      [
        input.sender_name || existing.sender_name, carried.language, carried.intent, JSON.stringify(carried.also),
        carried.asks_discount ? 1 : 0, carried.budget?.amount ?? null, carried.budget?.currency || null, carried.budget?.period || null,
        carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0, JSON.stringify(flags),
        input.non_text_type || null, analysis.source,
        status, status === 'stopped' ? 1 : 0, when, msgId, analysis.name.name, input.business_connection_id || null,
        proposed?.start_utc || null, leadId,
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
  if (!input.skip_reanalyze && status !== 'stopped') {
    const settled = settleHotTime(api, config, leadId);
    if (isPromise(settled)) {
      return settled.then(() => ({ ok: true, lead_id: leadId, message_id: msgId, status, duplicate: false, stored: true }));
    }
  }
  return { ok: true, lead_id: leadId, message_id: msgId, status, duplicate: false, stored: true };
}

function replyStatus(analysis, flags, opted, titleMatched = false) {
  if (opted || analysis.intent === 'stop') return 'stopped';
  const otherScript = analysis.language === 'other' || flags.includes('lang_other');
  const blocked = flags.includes('non_text') || flags.includes('injection_suspect') || flags.includes('optout');
  if (otherScript && !blocked) return 'pending_approval';
  if (blocked) return 'review';
  if (titleMatched) return 'pending_approval';
  if (analysis.intent === 'unclear' || flags.includes('review')) return 'review';
  return 'pending_approval';
}

const HOT_BROKER = 'broker';
const COMPETE_MS = 45 * 1000;

function autoSendHot(store) {
  const value = setting(store, 'auto_send_hot');
  return value === '1' || value === 'true';
}

function sameInstant(a, b) {
  if (!a || !b) return false;
  return Date.parse(a) === Date.parse(b);
}

function claimHold(api, start, lead) {
  const row = api.store.one(
    `SELECT lead_id FROM i_time_hold WHERE broker_key = ? AND start_utc = ?`,
    [HOT_BROKER, start],
  );
  if (!row) {
    api.store.run(
      `INSERT INTO i_time_hold (broker_key, start_utc, lead_id, score, first_msg_at) VALUES (?, ?, ?, ?, ?)`,
      [HOT_BROKER, start, lead.id, lead.score || 0, lead.first_msg_at],
    );
    return true;
  }
  if (row.lead_id === lead.id) {
    api.store.run(
      `UPDATE i_time_hold SET score = ?, first_msg_at = ? WHERE broker_key = ? AND start_utc = ?`,
      [lead.score || 0, lead.first_msg_at, HOT_BROKER, start],
    );
    return true;
  }
  const holder = loadLead(api.store, row.lead_id);
  if (holder && (holder.status === 'sent' || holder.status === 'stopped' || holder.status === 'archived')) return false;
  api.store.run(
    `UPDATE i_time_hold SET lead_id = ?, score = ?, first_msg_at = ? WHERE broker_key = ? AND start_utc = ?`,
    [lead.id, lead.score || 0, lead.first_msg_at, HOT_BROKER, start],
  );
  return true;
}

function heldStarts(api) {
  return api.store.all(`SELECT start_utc FROM i_time_hold WHERE broker_key = ?`, [HOT_BROKER]).map((row) => row.start_utc);
}

function nextOpenSlot(api, lead, avoid) {
  const property = propertyRow(api.store, lead.property_id);
  const offered = offerFor(api, property, '');
  const pick = (slots) => {
    const blocked = new Set([...(avoid || []), ...heldStarts(api)].map((value) => Date.parse(value)));
    return (slots || []).find((slot) => !blocked.has(Date.parse(slot.start_utc))) || null;
  };
  if (isPromise(offered)) return offered.then((value) => pick(value.slots));
  return pick(offered.slots);
}

function writeHotDraft(api, config, lead, proposed) {
  const property = propertyRow(api.store, lead.property_id);
  const offered = offerFor(api, property, '');
  if (isPromise(offered)) return offered.then((value) => writeHotDraftFrom(api, config, lead, proposed, value.slots));
  return writeHotDraftFrom(api, config, lead, proposed, offered.slots);
}

function writeHotDraftFrom(api, config, lead, proposed, slotsIn) {
  const property = propertyRow(api.store, lead.property_id);
  let slots = slotsIn || [];
  if (proposed && proposed.free && proposed.start_utc && !slots.some((slot) => sameInstant(slot.start_utc, proposed.start_utc))) {
    slots = [{
      id: proposed.id || `client-${String(proposed.start_utc).replace(/[^0-9]/g, '').slice(0, 14)}`,
      start_utc: proposed.start_utc,
      duration_min: 45,
      source: 'client',
    }, ...slots];
  }
  const options = buildOptions({
    analysis: {
      intent: lead.intent,
      also: lead.also,
      language: lead.language,
      asks_discount: lead.asks_discount,
      budget: lead.budget,
      timing: lead.timing,
      cash: lead.cash,
      flags: lead.flags,
    },
    clean_name: lead.clean_name,
    proposed,
    title_match: false,
    force_ask: proposed && proposed.force_ask === true,
  }, property, slots);
  const pick = (proposed && proposed.free)
    ? (options.find((row) => row.id === 'confirm') || options[0])
    : (options.find((row) => row.id === 'ask') || options.find((row) => row.id === 'other') || options[0]);
  if (!pick || !pick.text) return null;
  return saveDraft(api, config, lead.id, {
    text: pick.text,
    option_id: pick.id,
    slot_ids: pick.slot_ids || [],
    edited: false,
    attachments: [],
  });
}

function settleHotTime(api, config, leadId) {
  if (!autoSendHot(api.store)) return;
  const lead = loadLead(api.store, leadId);
  if (!lead || lead.readiness !== 'HOT' || !lead.proposed_utc) return;
  return settleGroup(api, config, lead.proposed_utc);
}

function settleOpenHot(api, config) {
  if (!autoSendHot(api.store)) return;
  const starts = new Set();
  for (const row of api.store.all(
    `SELECT proposed_utc FROM i_lead WHERE readiness = 'HOT' AND proposed_utc IS NOT NULL AND status IN ('pending_approval', 'review')`,
  )) {
    if (row.proposed_utc) starts.add(row.proposed_utc);
  }
  for (const row of api.store.all(
    `SELECT start_utc FROM i_time_hold WHERE broker_key = ? AND competition_due_at IS NOT NULL`,
    [HOT_BROKER],
  )) {
    starts.add(row.start_utc);
  }
  let pending = null;
  for (const start of starts) {
    const result = settleGroup(api, config, start);
    if (isPromise(result)) pending = pending ? pending.then(() => result) : result;
  }
  return pending;
}

function cancelCompetitions(api) {
  const rows = api.store.all(
    `SELECT broker_key, start_utc, lead_id FROM i_time_hold WHERE broker_key = ? AND competition_due_at IS NOT NULL`,
    [HOT_BROKER],
  );
  for (const row of rows) {
    const lead = loadLead(api.store, row.lead_id);
    if (lead && lead.status === 'sent') {
      api.store.run(
        `UPDATE i_time_hold SET competition_due_at = NULL WHERE broker_key = ? AND start_utc = ?`,
        [row.broker_key, row.start_utc],
      );
    } else {
      api.store.run(`DELETE FROM i_time_hold WHERE broker_key = ? AND start_utc = ?`, [row.broker_key, row.start_utc]);
    }
  }
}

function hotPeers(api, start) {
  return api.store.all(
    `SELECT id FROM i_lead WHERE readiness = 'HOT' AND proposed_utc = ? AND status NOT IN ('stopped', 'archived')`,
    [start],
  ).map((row) => loadLead(api.store, row.id)).filter(Boolean);
}

function holdRow(api, start) {
  return api.store.one(
    `SELECT * FROM i_time_hold WHERE broker_key = ? AND start_utc = ?`,
    [HOT_BROKER, start],
  );
}

function rememberLeader(api, start, leader, due) {
  const row = holdRow(api, start);
  if (!row) {
    api.store.run(
      `INSERT INTO i_time_hold (broker_key, start_utc, lead_id, score, first_msg_at, competition_due_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [HOT_BROKER, start, leader.id, leader.score || 0, leader.first_msg_at, due],
    );
    return;
  }
  api.store.run(
    `UPDATE i_time_hold SET lead_id = ?, score = ?, first_msg_at = ?, competition_due_at = ? WHERE broker_key = ? AND start_utc = ?`,
    [leader.id, leader.score || 0, leader.first_msg_at, row.competition_due_at || due, HOT_BROKER, start],
  );
}

function clearDue(api, start) {
  api.store.run(
    `UPDATE i_time_hold SET competition_due_at = NULL WHERE broker_key = ? AND start_utc = ?`,
    [HOT_BROKER, start],
  );
}

function settleGroup(api, config, start) {
  const peers = hotPeers(api, start);
  const hold = holdRow(api, start);
  const holder = hold ? loadLead(api.store, hold.lead_id) : null;
  const pending = peers
    .filter((row) => row.status === 'pending_approval' || row.status === 'review')
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.first_msg_at).localeCompare(String(b.first_msg_at)));
  if (holder && holder.status === 'sent') return dispatchHot(api, config, null, pending, start);
  if (!pending.length) return;
  if (pending.length === 1) {
    clearDue(api, start);
    return dispatchHot(api, config, pending[0], [], start);
  }
  const due = hold?.competition_due_at || new Date(api.now().getTime() + COMPETE_MS).toISOString();
  rememberLeader(api, start, pending[0], due);
  if (api.now().getTime() < Date.parse(due)) return;
  clearDue(api, start);
  return dispatchHot(api, config, pending[0], pending.slice(1), start);
}

function dispatchHot(api, config, winner, losers, start) {
  if (winner && winner.status !== 'sent' && !claimHold(api, start, winner)) {
    return dispatchHot(api, config, null, [winner, ...losers], start);
  }
  if (api.calendar && api.calendar.async) return dispatchHotAsync(api, config, winner, losers, start);
  return dispatchHotSync(api, config, winner, losers, start);
}

function sendHot(api, config, leadId, version, start) {
  return sendLead(api, config, leadId, {
    idempotency_key: `hot-${leadId}-${start}`,
    draft_version: version,
  }, 'system');
}

function loserDraft(api, config, loser, alt) {
  if (alt) return writeHotDraft(api, config, loser, { start_utc: alt.start_utc, free: true, id: alt.id });
  return writeHotDraft(api, config, loser, { start_utc: loser.proposed_utc, free: false, force_ask: true });
}

function dispatchHotSync(api, config, winner, losers, start) {
  const avoid = [start];
  if (winner && winner.status !== 'sent') {
    const draft = writeHotDraft(api, config, winner, { start_utc: start, free: true });
    if (draft && draft.ok) sendHot(api, config, winner.id, draft.version, start);
  }
  for (const loser of losers) {
    const alt = nextOpenSlot(api, loser, avoid);
    let assigned = start;
    let draft = null;
    if (alt && claimHold(api, alt.start_utc, loser)) {
      avoid.push(alt.start_utc);
      assigned = alt.start_utc;
      draft = loserDraft(api, config, loser, alt);
    } else {
      draft = loserDraft(api, config, loser, null);
    }
    if (draft && draft.ok && (loser.status === 'pending_approval' || loser.status === 'review')) {
      sendHot(api, config, loser.id, draft.version, assigned);
    }
  }
}

async function dispatchHotAsync(api, config, winner, losers, start) {
  if (api.calendar && api.calendar.error) return;
  const avoid = [start];
  if (winner && winner.status !== 'sent') {
    const draft = await writeHotDraft(api, config, winner, { start_utc: start, free: true });
    if (api.calendar && api.calendar.error) return;
    if (draft && draft.ok) await sendHot(api, config, winner.id, draft.version, start);
  }
  for (const loser of losers) {
    const alt = await nextOpenSlot(api, loser, avoid);
    let assigned = start;
    let draft = null;
    if (alt && claimHold(api, alt.start_utc, loser)) {
      avoid.push(alt.start_utc);
      assigned = alt.start_utc;
      draft = await loserDraft(api, config, loser, alt);
    } else {
      draft = await loserDraft(api, config, loser, null);
    }
    if (draft && draft.ok && (loser.status === 'pending_approval' || loser.status === 'review')) {
      await sendHot(api, config, loser.id, draft.version, assigned);
    }
  }
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

function propertyMatch(api, text, propertyId) {
  const matched = matchProperty(text, catalog(api.store));
  if (!matched || matched.id !== propertyId) return null;
  return { id: matched.id, score: matched.score, reasons: matched.reasons };
}

function latestInbound(store, leadId) {
  return store.one(
    `SELECT text FROM i_message WHERE lead_id = ? AND direction = 'in' AND deleted = 0 ORDER BY created_at DESC LIMIT 1`,
    [leadId],
  );
}

function isPromise(value) {
  return Boolean(value && typeof value.then === 'function');
}

function finishOffer(api, property, parsed, slots, free, error) {
  const zone = property?.tz || api.calendar?.zone || 'Asia/Dubai';
  let list = Array.isArray(slots) ? slots.slice() : [];
  if (error || (api.calendar && api.calendar.error)) {
    return { slots: [], proposed: null, error: error || api.calendar.error };
  }
  if (!list.length && property && !(api.calendar && api.calendar.mode === 'google')) {
    list = listFreeSlots(api.store, property, api.now());
  }
  let proposed = null;
  if (parsed) {
    const existing = list.find((slot) => Date.parse(slot.start_utc) === Date.parse(parsed.start_utc));
    const id = existing?.id || `client-${String(parsed.start_utc).replace(/[^0-9]/g, '').slice(0, 14)}`;
    proposed = { start_utc: parsed.start_utc, free: free !== false, id, zone: parsed.zone || zone };
    if (proposed.free && !existing) {
      list = [{ id, start_utc: parsed.start_utc, duration_min: 45, source: 'client' }, ...list];
    }
    if (!proposed.free) list = list.filter((slot) => Date.parse(slot.start_utc) !== Date.parse(parsed.start_utc));
  }
  return { slots: list, proposed: publicProposal(proposed, property), error: null };
}

function offerFor(api, property, text) {
  const zone = property?.tz || api.calendar?.zone || 'Asia/Dubai';
  const parsed = parseProposal(text || '', zone, api.now());
  const calendar = api.calendar;
  if (calendar && calendar.error) return finishOffer(api, property, parsed, [], false, calendar.error);
  const slotArgs = { now: api.now(), count: 8, zone: calendar?.zone || zone, durationMin: 45 };
  const slotsResult = calendar && typeof calendar.freeSlots === 'function' ? calendar.freeSlots(slotArgs) : [];
  const freeResult = parsed && calendar && typeof calendar.isFree === 'function'
    ? calendar.isFree(parsed.start_utc, 45)
    : true;
  if (isPromise(slotsResult) || isPromise(freeResult)) {
    return Promise.all([
      Promise.resolve(freeResult).catch(() => false),
      Promise.resolve(slotsResult).catch(() => []),
    ]).then(([free, slots]) => finishOffer(api, property, parsed, calendar && calendar.error ? [] : slots, free, calendar && calendar.error));
  }
  return finishOffer(api, property, parsed, slotsResult, freeResult, null);
}

function publicProposal(proposed, property) {
  if (!proposed) return null;
  const host = property || { tz: proposed.zone || 'Asia/Dubai' };
  return {
    start_utc: proposed.start_utc,
    free: proposed.free === true,
    id: proposed.id,
    label_en: slotPhrase({ start_utc: proposed.start_utc }, host, 'en').when,
    label_ru: slotPhrase({ start_utc: proposed.start_utc }, host, 'ru').when,
  };
}

function labelSlots(slots, property) {
  const host = property || { tz: 'Asia/Dubai' };
  return (slots || []).map((slot) => {
    const en = slotPhrase(slot, host, 'en');
    const ru = slotPhrase(slot, host, 'ru');
    return {
      ...slot,
      label_en: slot.label_en || en.when,
      label_ru: slot.label_ru || ru.when,
      proposal_en: slot.proposal_en || `${en.when}. ${en.note}`,
      proposal_ru: slot.proposal_ru || `${ru.when}. ${ru.note}`,
    };
  });
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
  const inbound = latestInbound(api.store, id);
  const matched = propertyMatch(api, inbound?.text || '', lead.property_id);
  const offered = offerFor(api, property, inbound?.text || '');
  if (isPromise(offered)) return offered.then((value) => presentWithOffer(api, config, lead, property, analysis, inbound, matched, value));
  return presentWithOffer(api, config, lead, property, analysis, inbound, matched, offered);
}

function presentWithOffer(api, config, lead, property, analysis, inbound, matched, offered) {
  const id = lead.id;
  const slots = labelSlots(offered.slots, property);
  const options = lead.status === 'stopped' ? [] : buildOptions({
    analysis,
    clean_name: lead.clean_name,
    proposed: offered.proposed,
    title_match: Boolean(matched) || Boolean(property && property.id && property.id !== 'general'),
  }, clientProperty(api, config, property), slots);
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
    proposed: offered.proposed,
    readiness: lead.readiness || classifyReadiness(inbound?.text || '', analysis).label,
    calendar_mode: api.calendar?.mode || 'mock',
    calendar_source: api.calendar?.source || 'mock-schedule',
    calendar_error: offered.error || null,
    match: matched,
    stale_sending: sends.some((row) => row.fail_reason === 'stale_sending'),
    events: humanEvents(api, lead),
  };
}

function listPresent(api, query = {}) {
  const wantArchive = query.archived === true;
  const leads = api.store.all('SELECT id FROM i_lead')
    .map((row) => loadLead(api.store, row.id))
    .filter((lead) => (lead.status === 'archived') === wantArchive);
  const rank = (lead) => (lead.status === 'stopped' ? 2 : lead.status === 'sent' ? 1 : 0);
  return leads.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (readinessRank(a) !== readinessRank(b)) return readinessRank(a) - readinessRank(b);
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
    archive: 'Archived',
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
    `INSERT INTO i_draft (lead_id, option_id, text, slot_ids, edited, version, updated_at, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lead_id) DO UPDATE SET option_id=excluded.option_id, text=excluded.text, slot_ids=excluded.slot_ids, edited=excluded.edited, version=excluded.version, updated_at=excluded.updated_at, attachments=excluded.attachments`,
    [leadId, body.option_id ?? null, text, JSON.stringify(body.slot_ids || []), body.edited ? 1 : 0, version, api.now().toISOString(), JSON.stringify(cleanAttachments(body.attachments, api, config))],
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
  const inbound = latestInbound(api.store, leadId);
  const offered = offerFor(api, property, inbound?.text || '');
  const finish = (offeredValue) => sendResolved(api, config, {
    lead, draft, body, actor, text, draftHash, replyTo, clash, key, offered: offeredValue,
  });
  if (isPromise(offered)) return offered.then(finish);
  return finish(offered);
}

function sendResolved(api, config, ctx) {
  const { lead, draft, body, actor, text, draftHash, replyTo, clash, key, offered } = ctx;
  const leadId = lead.id;
  const manual = body.manual === true || draft.option_id == null;
  const wanted = JSON.parse(draft.slot_ids || '[]');
  if (offered.error && wanted.length) return fail(409, 'calendar_unavailable');
  const allowed = new Set((offered.slots || []).map((slot) => slot.id));
  if (!offered.error && wanted.length && wanted.some((id) => !allowed.has(id))) return fail(409, 'slot_unavailable');
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
    const attachments = cleanAttachments(JSON.parse(draft.attachments || '[]'), api, config);
    const response = { ok: true, status: 200, simulated, send_id: sendId, lead_status: 'sent', attachments };
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

function archiveLead(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.status === 'archived') return { ok: true, status: 'archived' };
  api.store.run(`UPDATE i_lead SET status='archived' WHERE id=?`, [leadId]);
  api.store.run('DELETE FROM i_draft WHERE lead_id=?', [leadId]);
  audit(api.store, config, 'archive', leadId, {}, actor || 'broker');
  return { ok: true, status: 'archived', simulated: true, sent: false };
}

function applyChosenSlot(api, config, leadId, body) {
  const presented = presentLead(api, config, leadId);
  if (!presented) return fail(404, 'not_found');
  if (!['pending_approval', 'review'].includes(presented.status)) return fail(409, 'not_pending');
  const slot = (presented.slots || []).find((row) => row.id === body.slot_id);
  if (!slot) return fail(409, 'slot_unavailable');
  const lang = presented.language === 'ru' ? 'ru' : 'en';
  const when = lang === 'ru' ? slot.label_ru : slot.label_en;
  const current = (presented.draft && presented.draft.text) || presented.options?.[0]?.text || '';
  const text = rewriteReplyTime(current, when, lang);
  const saved = saveDraft(api, config, leadId, {
    text,
    option_id: presented.status === 'review' ? null : (presented.draft?.option_id || 'one'),
    edited: true,
    slot_ids: [slot.id],
    base_version: body.base_version,
  });
  if (!saved.ok) return saved;
  return { ok: true, text, version: saved.version, slot_ids: [slot.id] };
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

function stopLead(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  const now = api.now().toISOString();
  return api.store.transaction(() => {
    api.store.run(
      'INSERT INTO i_optout (channel, sender_hash, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [lead.channel, lead.sender_hash, now],
    );
    const leads = api.store.all('SELECT id FROM i_lead WHERE channel = ? AND sender_hash = ?', [lead.channel, lead.sender_hash]);
    for (const row of leads) {
      api.store.run(`UPDATE i_lead SET status='stopped', optout=1 WHERE id=?`, [row.id]);
      api.store.run('DELETE FROM i_draft WHERE lead_id=?', [row.id]);
    }
    audit(api.store, config, 'stop', leadId, { by: 'broker' }, actor || 'broker');
    return { ok: true, status: 'stopped', leads: leads.length, sent: false, simulated: true };
  });
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

const FILE_TTL_MS = 7 * 24 * 3600 * 1000;

function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('file:')) return text;
  if (text.startsWith('/v1/intl/properties/') && text.endsWith('/brochure.pdf')) return text;
  if (text.startsWith('/v1/intl/public/files/')) return text;
  if (/^data:(image\/(?:png|jpeg|gif|webp)|application\/pdf);base64,/i.test(text)) {
    if (text.length > 120000) return null;
    return text;
  }
  if (/^https?:\/\//i.test(text) && text.length <= 500 && !/^javascript:/i.test(text)) return text;
  return null;
}

function fileSignature(config, id, exp) {
  return crypto.createHmac('sha256', String(config.HASH_SALT)).update(`${id}.${exp}`).digest('base64url');
}

function publicFileUrl(config, id) {
  const exp = Date.now() + FILE_TTL_MS;
  const sig = fileSignature(config, id, exp);
  return `/v1/intl/public/files/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
}

function fileIdFromPublic(url) {
  const match = String(url || '').match(/\/v1\/intl\/public\/files\/([^?]+)/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

function persistDataUrl(api, propertyId, kind, dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp)|application\/pdf);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return '';
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length || bytes.length > 90000) return '';
  const id = `F-${crypto.randomBytes(6).toString('hex')}`;
  api.store.run(
    `INSERT INTO i_file (id, property_id, kind, mime, name, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, propertyId || null, kind, match[1].toLowerCase(), kind, bytes, api.now().toISOString()],
  );
  return id;
}

function storedFileRef(api, propertyId, kind, url) {
  const text = String(url || '');
  if (!text.startsWith('data:')) return text;
  const id = persistDataUrl(api, propertyId, kind, text);
  return id ? `file:${id}` : '';
}

function resolveFileId(api, url, kind) {
  const text = String(url || '').trim();
  if (text.startsWith('file:')) return text.slice(5);
  const brochure = text.match(/^\/v1\/intl\/properties\/([^/]+)\/brochure\.pdf$/);
  if (brochure) return `brochure:${decodeURIComponent(brochure[1])}`;
  const existing = fileIdFromPublic(text);
  if (existing) return existing;
  if (text.startsWith('data:')) return persistDataUrl(api, null, kind || 'file', text);
  return '';
}

function publishUrl(api, config, url, kind) {
  const text = String(url || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text.slice(0, 500);
  const id = resolveFileId(api, text, kind);
  if (!id || !config) return '';
  return publicFileUrl(config, id);
}

function clientProperty(api, config, property) {
  if (!property) return property;
  const copy = { ...property };
  if (copy.brochure_url) copy.brochure_url = publishUrl(api, config, copy.brochure_url, 'brochure') || copy.brochure_url;
  if (copy.plan_url) copy.plan_url = publishUrl(api, config, copy.plan_url, 'plan') || copy.plan_url;
  return copy;
}

function cleanAttachments(list, api, config) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 4).map((item) => {
    const kind = ['brochure', 'plan', 'link'].includes(item.kind) ? item.kind : 'link';
    const name = String(item.name || 'file').slice(0, 40);
    const fileId = item.file_id || resolveFileId(api, item.url, kind);
    const url = publishUrl(api, config, item.file_id ? `file:${item.file_id}` : item.url, kind);
    return { kind, name, url, file_id: fileId || fileIdFromPublic(url) || null };
  }).filter((item) => item.url);
}

async function openPublicFile(api, config, id, exp, sig) {
  const expN = Number(exp);
  const expected = fileSignature(config, id, exp);
  const given = Buffer.from(String(sig || ''));
  const want = Buffer.from(expected);
  const fresh = Number.isFinite(expN) && expN >= Date.now();
  const same = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!fresh || !same) return fail(403, 'file_forbidden');
  if (String(id).startsWith('brochure:')) {
    const propertyId = String(id).slice('brochure:'.length);
    const property = propertyRow(api.store, propertyId);
    if (!property || property.id === 'general') return fail(404, 'not_found');
    const settings = readSettings(api.store);
    const bytes = await brochurePdf(property, { brokerName: settings.broker_name || property.agency || 'Broker' });
    return fileResponse(bytes, 'application/pdf', `${propertyId}.pdf`);
  }
  const row = api.store.one('SELECT mime, name, bytes FROM i_file WHERE id = ?', [id]);
  if (!row || row.bytes == null) return fail(404, 'not_found');
  return fileResponse(Buffer.from(row.bytes), row.mime || 'application/octet-stream', row.name || 'file');
}

function fileResponse(bytes, mime, name) {
  return {
    ok: true,
    status: 200,
    body_bytes: bytes,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `inline; filename="${String(name).replace(/[^a-z0-9._-]+/gi, '_')}"`,
      'Cache-Control': 'private, max-age=300',
    },
  };
}

function profileOf(body, id) {
  const address = String(body.address || '').trim().slice(0, 160);
  const district = String(body.district || '').trim().slice(0, 80);
  const bedrooms = body.bedrooms == null || body.bedrooms === '' ? null : Number(body.bedrooms);
  if (bedrooms != null && (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 20)) return { error: 'invalid_property' };
  const listing = cleanUrl(body.listing_url);
  const plan = cleanUrl(body.plan_url);
  let brochure = cleanUrl(body.brochure_url);
  if (listing == null || plan == null || brochure == null) return { error: 'invalid_property' };
  if (body.make_brochure) brochure = `/v1/intl/properties/${id}/brochure.pdf`;
  return { address, district, bedrooms, listing, plan, brochure };
}

function addProperty(api, config, body, actor) {
  const problem = propertyError(body);
  if (problem) return fail(400, problem);
  const period = periodOf(body.price_period);
  const id = body.id || `P-${crypto.randomBytes(3).toString('hex')}`;
  const profile = profileOf(body, id);
  if (profile.error) return fail(400, profile.error);
  if (String(profile.plan).startsWith('data:')) {
    profile.plan = storedFileRef(api, id, 'plan', profile.plan);
    if (!profile.plan) return fail(400, 'invalid_property');
  }
  if (String(profile.brochure).startsWith('data:')) {
    profile.brochure = storedFileRef(api, id, 'brochure', profile.brochure);
    if (!profile.brochure) return fail(400, 'invalid_property');
  }
  const price = formatPair({ ...body, price_period: period });
  const facts = { ...(body.facts || {}) };
  if (profile.bedrooms != null) facts.bedrooms = profile.bedrooms;
  if (profile.district) facts.district = profile.district;
  const fields = [body.title, body.kind, Number(body.price), body.currency, period, body.tz, body.tz_label_en || null, body.tz_label_ru || null,
    body.area_value || null, body.area_unit || null, body.ref_en || body.title, body.ref_ru || body.title,
    price.en, price.ru, JSON.stringify(facts), profile.address, profile.district, profile.bedrooms, profile.listing, profile.brochure, profile.plan];
  if (propertyRow(api.store, id)) {
    api.store.run(
      `UPDATE i_property SET title=?, kind=?, price=?, currency=?, price_period=?, tz=?, tz_label_en=?, tz_label_ru=?, area_value=?, area_unit=?, ref_en=?, ref_ru=?, price_en=?, price_ru=?, facts=?, address=?, district=?, bedrooms=?, listing_url=?, brochure_url=?, plan_url=? WHERE id=?`,
      [...fields, id],
    );
    audit(api.store, config, 'property_add', null, { property_id: id, updated: true }, actor || 'broker');
    return { ok: true, id, updated: true };
  }
  api.store.run(
    `INSERT INTO i_property (id, title, kind, price, currency, price_period, tz, tz_label_en, tz_label_ru, area_value, area_unit, ref_en, ref_ru, price_en, price_ru, facts, active, created_at, address, district, bedrooms, listing_url, brochure_url, plan_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ...fields.slice(0, 15), api.now().toISOString(), ...fields.slice(15)],
  );
  audit(api.store, config, 'property_add', null, { property_id: id }, actor || 'broker');
  return { ok: true, id };
}

async function brochureFor(api, id) {
  const property = propertyRow(api.store, id);
  if (!property || property.id === 'general') return fail(404, 'not_found');
  const settings = readSettings(api.store);
  const bytes = await brochurePdf(property, {
    brokerName: settings.broker_name || property.broker_name || property.agency || 'Broker',
    brokerPhone: settings.broker_phone || property.broker_phone || '',
  });
  return {
    ok: true,
    status: 200,
    body_bytes: bytes,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${id}.pdf"`,
      'Cache-Control': 'no-store',
    },
  };
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
  if (body.manual_approval === false) return fail(409, 'locked');
  let settled = null;
  if (body.auto_send_hot != null) {
    setting(api.store, 'auto_send_hot', body.auto_send_hot ? '1' : '0');
    settled = body.auto_send_hot ? settleOpenHot(api, config) : null;
    if (!body.auto_send_hot) cancelCompetitions(api);
  }
  if (body.lang != null && !['en', 'ru'].includes(body.lang)) return fail(400, 'invalid_settings');
  if (body.broker_tz != null && !validZone(body.broker_tz)) return fail(400, 'invalid_timezone');
  for (const key of ['lang', 'broker_name', 'broker_tz']) {
    if (body[key] != null) setting(api.store, key, String(body[key]));
  }
  audit(api.store, config, 'settings_change', null, { keys: Object.keys(body) }, actor || 'broker');
  const response = { ok: true, settings: readSettings(api.store) };
  if (isPromise(settled)) return settled.then(() => response);
  return response;
}

function buildDigest(api, config) {
  const now = api.now();
  const zone = config.BROKER_TZ || 'Asia/Dubai';
  const leads = api.store.all('SELECT id FROM i_lead').map((row) => loadLead(api.store, row.id));
  const waiting = leads.filter((lead) => lead.status !== 'stopped' && lead.status !== 'sent' && lead.status !== 'archived' && !lead.optout);
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
  const hot = leads.filter((lead) => lead.grade === 'HOT' && lead.pipeline !== 'closed' && !lead.optout && lead.status !== 'stopped' && lead.status !== 'archived');
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
  for (const [id, property] of Object.entries(pack.meta.properties)) {
    const zone = property.tz || 'Asia/Dubai';
    const templates = (property.slots || [])
      .map((start) => DateTime.fromISO(start, { setZone: true }).setZone(zone))
      .filter((value) => value.isValid);
    if (!templates.length) continue;
    const firstDay = templates[0].startOf('day');
    const base = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone });
    let anchor = base.set({
      hour: templates[0].hour,
      minute: templates[0].minute,
      second: 0,
      millisecond: 0,
    });
    if (anchor <= base) anchor = anchor.plus({ days: 1 });
    for (const template of templates) {
      const delta = Math.round(template.startOf('day').diff(firstDay, 'days').days);
      const shifted = anchor.plus({ days: Math.max(0, delta) }).set({
        hour: template.hour,
        minute: template.minute,
        second: 0,
        millisecond: 0,
      });
      if (shifted.toMillis() <= base.toMillis()) continue;
      const iso = shifted.toUTC().toISO();
      if (api.store.one('SELECT id FROM i_slot WHERE property_id=? AND start_utc=?', [id, iso])) continue;
      const slotId = `SL-${id}-${template.toFormat('MMdd-HHmm')}`;
      api.store.run(
        `INSERT INTO i_slot (id, property_id, start_utc, duration_min, status, created_at) VALUES (?, ?, ?, 45, 'free', ?)`,
        [slotId, id, iso, base.toUTC().toISO()],
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
  const readiness = classifyReadiness(message.text || '', analysis);
  const proposed = parseProposal(message.text || '', property?.tz || config.BROKER_TZ || 'Asia/Dubai', api.now());
  const flags = [...analysis.flags];
  if (scored.budget_low && !flags.includes('budget_low')) flags.push('budget_low');
  const carried = carry(lead, analysis);
  const opted = api.store.one('SELECT 1 AS n FROM i_optout WHERE channel = ? AND sender_hash = ?', [lead.channel, lead.sender_hash]);
  let status = replyStatus(analysis, flags, Boolean(opted));
  if (opted && analysis.intent !== 'stop') status = 'stopped';
  const inboundCount = api.store.one(
    `SELECT COUNT(*) AS n FROM i_message WHERE lead_id = ? AND direction = 'in' AND deleted = 0`,
    [lead.id],
  ).n;
  const freezeScore = lead.status === 'sent' || inboundCount > 1;
  if (freezeScore) {
    api.store.run(
      `UPDATE i_lead SET language=?, intent=?, also_json=?, asks_discount=?, budget_amount=?, budget_currency=?, budget_period=?,
        timing_class=?, timing_label=?, cash=?, flags=?, analysis_source=?, status=?, optout=?, proposed_utc=? WHERE id=?`,
      [
        carried.language, carried.intent, JSON.stringify(carried.also), carried.asks_discount ? 1 : 0,
        carried.budget?.amount ?? null, carried.budget?.currency || null, carried.budget?.period || null,
        carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0,
        JSON.stringify(flags), analysis.source, status, status === 'stopped' ? 1 : 0,
        proposed?.start_utc || null, lead.id,
      ],
    );
  } else {
    api.store.run(
      `UPDATE i_lead SET language=?, intent=?, also_json=?, asks_discount=?, budget_amount=?, budget_currency=?, budget_period=?,
        timing_class=?, timing_label=?, cash=?, flags=?, score=?, grade=?, reasons=?, analysis_source=?, status=?, optout=?,
        readiness=?, proposed_utc=? WHERE id=?`,
      [
        carried.language, carried.intent, JSON.stringify(carried.also), carried.asks_discount ? 1 : 0,
        carried.budget?.amount ?? null, carried.budget?.currency || null, carried.budget?.period || null,
        carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0,
        JSON.stringify(flags), scored.score, scored.grade, JSON.stringify(scored.reasons), analysis.source,
        status, status === 'stopped' ? 1 : 0, readiness.label, proposed?.start_utc || null, lead.id,
      ],
    );
  }
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
