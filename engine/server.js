'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadConfig, listenHost, secretConfigured } = require('../core/config');
const { normalizeInbound } = require('../core/normalize');
const { LEAD_COLUMNS, OBJEKT_COLUMNS } = require('../core/crm');
const { loadFixtureEml } = require('../core/eml');
const {
  runInbound,
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
} = require('../core/pipeline');
const { createRuntime, requestContext, seedObjekte, loadFixtureObjekte } = require('./adapters');
const { handleUi } = require('./uiRoutes');
const { startLoops } = require('./loops');
const { runRetention } = require('../core/retention');

const STEPS = {
  '/v1/step/normalize': stepNormalize,
  '/v1/step/dedup': stepDedup,
  '/v1/step/extract': stepExtract,
  '/v1/step/score': stepScore,
  '/v1/step/busy': stepBusy,
  '/v1/step/slots': stepSlots,
  '/v1/step/compose': stepCompose,
  '/v1/step/send': stepSend,
  '/v1/step/crm': stepCrm,
  '/v1/step/telegram': stepTelegram,
  '/v1/step/reply/match': stepReplyMatch,
  '/v1/step/reply/classify': stepReplyClassify,
  '/v1/step/reply/stop': stepReplyStop,
  '/v1/step/reply/book': stepReplyBook,
  '/v1/step/reply/human': stepReplyHuman,
};

const DEMO_IDS = new Set(['E01', 'E02', 'E11']);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function safeCode(err) {
  const code = String(err?.code || err?.message || 'internal');
  if (/^[a-z0-9_]+$/i.test(code) && code.length <= 80) return code;
  return 'internal';
}

function tokenOk(presented, expected) {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(presented || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
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

function healthBody(deps) {
  const config = deps.config;
  return {
    ok: true,
    service: 'anfragen-autopilot',
    timezone: config.GENERIC_TIMEZONE,
    send_mode: config.SEND_MODE,
    approval_timeout_action: config.APPROVAL_TIMEOUT_ACTION,
    flags: {
      followup_email_enabled: config.FOLLOWUP_EMAIL_ENABLED,
      noshow_reoffer_enabled: config.NOSHOW_REOFFER_ENABLED,
      interesse_followup_enabled: config.INTERESSE_FOLLOWUP_ENABLED,
    },
    retention_days_lead: config.RETENTION_DAYS_LEAD,
    first_response_sla_seconds: config.FIRST_RESPONSE_SLA_SECONDS,
    sla_applies_to: config.SLA_APPLIES_TO,
    portal: config.PORTAL,
    crm_target: config.CRM_TARGET,
    crm_mode: config.CRM_MODE,
    calendar_mode: config.CALENDAR_MODE,
    mail_mode: config.MAIL_MODE,
    telegram_mode: config.TELEGRAM_MODE,
    bot_polling: config.BOT_POLLING === true && config.TELEGRAM_MODE === 'telegram',
    llm_mode: config.LLM_MODE,
    store: deps.storeKind || 'injected',
    ui_store: config.UI_STORE,
    office_mode: config.OFFICE_MODE,
    product: config.PRODUCT_NAME,
    office_slug: /^[a-z0-9-]{0,32}$/.test(config.OFFICE_SLUG || '') ? (config.OFFICE_SLUG || '') : '',
    imap_mode: config.IMAP_MODE,
    imap_last_ok: deps.imapLastOk || '',
    imap_last_error: deps.imapLastError || '',
    owner_leads_enabled: config.OWNER_LEADS_ENABLED === true,
  };
}

function demoStatePath(deps) {
  return path.join(deps.config.DATA_DIR || 'var', 'demo_state.json');
}

function writeDemoState(deps, state) {
  if (!state?.lead_id) return;
  if (state.outcome !== 'SENT' && state.outcome !== 'TERMIN') return;
  const existing = readDemoState(deps) || {};
  const sameLead = existing.lead_id === state.lead_id;
  const slots = state.slots || [];
  const slotLabels = slots.map((slot) => (typeof slot === 'string' ? slot : slot.label)).filter(Boolean);
  const payload = {
    lead_id: state.lead_id,
    outbound_message_id: state.outcome === 'SENT'
      ? state.message_id
      : (sameLead && existing.outbound_message_id) || state.message_id || null,
    portal_listing_id: state.lead?.listing?.portal_listing_id
      || state.crm_lead?.portal_listing_id
      || (sameLead ? existing.portal_listing_id : null)
      || null,
    slot_labels: slotLabels.length ? slotLabels : (sameLead ? existing.slot_labels || [] : []),
    outcome: state.outcome,
  };
  const file = demoStatePath(deps);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function readDemoState(deps) {
  try {
    return JSON.parse(fs.readFileSync(demoStatePath(deps), 'utf8'));
  } catch {
    return null;
  }
}

function fixtureMail(id, deps) {
  const mail = loadFixtureEml(id);
  if (id !== 'E11') return mail;
  const saved = readDemoState(deps);
  if (!saved?.lead_id || !saved?.outbound_message_id) {
    const err = new Error('demo_state_missing');
    err.code = 'demo_state_missing';
    throw err;
  }
  const leadId = saved.lead_id;
  const messageId = saved.outbound_message_id;
  mail.subject = String(mail.subject).replaceAll('{{LEAD_ID}}', leadId);
  mail.inReplyTo = messageId;
  mail.references = messageId;
  mail.textPlain = String(mail.textPlain).replaceAll('{{LEAD_ID}}', leadId).replaceAll('{{IN_REPLY_TO}}', messageId);
  return mail;
}

function clearRuntimeFiles(deps) {
  const root = deps.config.DATA_DIR || 'var';
  const single = ['demo_state.json', 'telegram.log', 'calendar.json', 'engine.log'];
  for (const name of single) {
    fs.rmSync(path.join(root, name), { force: true });
  }
  fs.rmSync(path.join(root, 'crm', 'leads.json'), { force: true });
  const outbox = path.join(root, 'outbox');
  if (fs.existsSync(outbox)) {
    for (const name of fs.readdirSync(outbox)) fs.rmSync(path.join(outbox, name), { force: true });
  }
}

async function resetRuntime(deps) {
  if (deps.db?.reset) await deps.db.reset();
  if (deps.crm?.reset) await deps.crm.reset();
  if (deps.calendar?.reset) await deps.calendar.reset();
  if (deps.ui?.reset) deps.ui.reset();
  if (deps.fragebogen?.reset) deps.fragebogen.reset();
  clearRuntimeFiles(deps);
  if (!deps.objekte?.length) deps.objekte = loadFixtureObjekte();
}

function fixtureFrom(body, req) {
  return body?.fixture
    || body?.normalized?.fixture
    || body?.headers?.['x-fixture']
    || req.headers['x-fixture']
    || '';
}

function engineAuthorized(req, config) {
  if (!secretConfigured(config.ENGINE_TOKEN)) return false;
  return tokenOk(req.headers['x-engine-token'], config.ENGINE_TOKEN);
}

function hashFromBody(body) {
  if (body?.normalized?.message_id_hash) return body.normalized.message_id_hash;
  if (!body || typeof body !== 'object') return '';
  const source = body.imap || body;
  if (!source.messageId && !source.message_id && !source.subject && !source.textPlain && !source.text) return '';
  try {
    return normalizeInbound(source, { ownAddresses: [] }).message_id_hash || '';
  } catch {
    return '';
  }
}

async function failProcessing(deps, body, errorCode) {
  const hash = hashFromBody(body);
  let marked = false;
  if (hash && deps.db?.failProcessing) {
    try {
      marked = await deps.db.failProcessing(hash);
    } catch {
      marked = false;
    }
  }
  if (!marked || !deps.telegram?.send) return;
  try {
    await deps.telegram.send(`Störung · Verarbeitung fehlgeschlagen · ${errorCode}`);
  } catch {
    // The alert must not hide the original failure.
  }
}

function noteAccess(deps, entry) {
  if (Array.isArray(deps.access)) deps.access.push(entry);
  if (!deps.config?.DATA_DIR || deps.storeKind === 'injected') return;
  try {
    fs.appendFileSync(path.join(deps.config.DATA_DIR, 'access.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // Access logging must not change the reply.
  }
}

function buildServer(deps) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://engine.local');
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    let body = {};
    try {
      if (req.method === 'GET' && pathname === '/v1/health') {
        sendJson(res, 200, healthBody(deps));
        return;
      }
      if (await handleUi(req, res, deps, url)) return;
      if (!engineAuthorized(req, deps.config)) {
        sendJson(res, 401, { halt: true, outcome: 'ERROR', error_code: 'unauthorized' });
        return;
      }
      if (req.method === 'GET' && pathname === '/v1/crm/contract') {
        sendJson(res, 200, {
          ok: true,
          target: deps.config.CRM_TARGET,
          propstack: 'NOT_IMPLEMENTED',
          columns: LEAD_COLUMNS,
          objekt_columns: OBJEKT_COLUMNS,
          label: 'Ihr CRM (Demo)',
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/v1/calendar/contract') {
        sendJson(res, 200, {
          ok: true,
          mode: deps.config.CALENDAR_MODE,
          timezone: deps.config.SLOT_RULES.tz,
          slot_rules: deps.config.SLOT_RULES,
          title_pattern: 'Besichtigung {listing_id} · {lead_id}',
          description: 'Besichtigungstermin. Keine Kontaktdaten in diesem Ereignis.',
        });
        return;
      }
      const fixtureMatch = pathname.match(/^\/v1\/demo\/fixture\/(E\d+)$/);
      if (req.method === 'GET' && fixtureMatch) {
        const id = fixtureMatch[1];
        if (!DEMO_IDS.has(id)) {
          sendJson(res, 200, { halt: true, outcome: 'ERROR', error_code: 'unknown_fixture' });
          return;
        }
        sendJson(res, 200, fixtureMail(id, deps));
        return;
      }
      if (pathname === '/v1/admin/reset' || pathname === '/v1/admin/seed' || pathname === '/v1/admin/retention') {
        if (req.method !== 'POST' || !tokenOk(req.headers['x-admin-token'], deps.config.ADMIN_TOKEN)) {
          sendJson(res, 403, { ok: false, error_code: 'forbidden' });
          return;
        }
        if (pathname.endsWith('/retention')) {
          const result = await runRetention(deps);
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        if (pathname.endsWith('/reset')) {
          await resetRuntime(deps);
          sendJson(res, 200, {
            ok: true,
            reset: true,
            objekte_kept: true,
            warning: 'STOP-Hashes und Demo-Leads wurden gelöscht. Objekte bleiben.',
          });
          return;
        }
        const rows = await seedObjekte(deps.config, deps.google);
        deps.objekte = rows;
        sendJson(res, 200, { ok: true, seeded: 'objekte', count: rows.length });
        return;
      }
      body = req.method === 'POST' ? await readBody(req) : {};
      const fixture = String(fixtureFrom(body, req) || '');
      const run = async () => {
        if (pathname === '/v1/intake/run' && req.method === 'POST') {
          const state = await runInbound(body.imap || body, deps);
          writeDemoState(deps, state);
          return state;
        }
        const step = STEPS[pathname];
        if (!step || req.method !== 'POST') {
          return { missing: true };
        }
        const state = await step(body, deps);
        if (pathname === '/v1/step/send' || pathname === '/v1/step/reply/book') writeDemoState(deps, state);
        return state;
      };
      const state = await requestContext.run({ fixture }, run);
      if (state?.missing) {
        sendJson(res, 404, { halt: true, outcome: 'ERROR', error_code: 'not_found' });
        return;
      }
      noteAccess(deps, {
        ts: new Date().toISOString(),
        method: req.method,
        path: pathname,
        outcome: state?.outcome || '',
        error_code: state?.error_code || '',
      });
      sendJson(res, 200, state);
    } catch (err) {
      const errorCode = safeCode(err);
      noteAccess(deps, {
        ts: new Date().toISOString(),
        method: req.method,
        path: pathname,
        outcome: 'ERROR',
        error_code: errorCode,
      });
      await failProcessing(deps, body, errorCode);
      const status = errorCode === 'forbidden' ? 403 : 500;
      sendJson(res, status, { halt: true, outcome: 'ERROR', error_code: errorCode });
    }
  });
}

function assertBoot(config) {
  if (!secretConfigured(config.ENGINE_TOKEN)) {
    console.error('engine_token_missing');
    process.exit(1);
  }
  if (!secretConfigured(config.HASH_SALT)) {
    console.error('hash_salt_missing');
    process.exit(1);
  }
  if (config.DEMO_UI_NO_AUTH && (config.MAIL_MODE === 'smtp' || config.TELEGRAM_MODE === 'telegram')) {
    console.error('demo_ui_no_auth_blocked');
    process.exit(1);
  }
  if (config.REAL_DATA_ALLOWED) {
    console.error('real_data_blocked');
    process.exit(1);
  }
  if (config.DEMO_UI_NO_AUTH && String(config.UI_PUBLIC_BASE || '').startsWith('https://')) {
    console.error('demo_ui_no_auth_blocked');
    process.exit(1);
  }
  if (config.PRODUCT_MODE === 'intl' && config.CHANNEL_MODE === 'invalid') {
    console.error('channel_mode_invalid');
    process.exit(1);
  }
  if (config.MAIL_MODE === 'smtp') {
    const from = config.MAKLER_PROFILE.from_email;
    if (!secretConfigured(config.MAIL_DOMAIN) || !from || !config.ALLOWED_SENDER_DOMAINS.length) {
      console.error('smtp_config_incomplete');
      process.exit(1);
    }
    if (config.UI_STORE !== 'sqlite') {
      console.error('ui_store_required');
      process.exit(1);
    }
  }
  if (config.IMAP_MODE === 'imap') {
    if (!config.IMAP_HOST || !config.IMAP_USER || !config.IMAP_PASSWORD) {
      console.error('imap_config_incomplete');
      process.exit(1);
    }
    if (config.UI_STORE !== 'sqlite') {
      console.error('ui_store_required');
      process.exit(1);
    }
  }
  if (config.OFFICE_MODE === 'live') {
    const profile = config.MAKLER_PROFILE;
    if (!profile.name || !profile.adresse || !(profile.email || profile.from_email)) {
      console.error('operator_profile_incomplete');
      process.exit(1);
    }
  }
}

async function main() {
  const config = loadConfig();
  assertBoot(config);
  const deps = await createRuntime(config);
  startLoops(deps);
  const server = buildServer(deps);
  const host = listenHost();
  await new Promise((resolve) => server.listen(config.ENGINE_PORT, host, resolve));
  console.log(`engine_listening host=${host} port=${config.ENGINE_PORT} store=${deps.storeKind} llm=${config.LLM_MODE}`);
}

if (require.main === module) {
  main().catch(() => {
    console.error('engine_start_failed');
    process.exit(1);
  });
}

module.exports = { buildServer, healthBody, main };
