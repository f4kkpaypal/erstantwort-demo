'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadConfig, listenHost, secretConfigured } = require('../core/config');
const { verifyInitData, allowedTelegramIds } = require('../core/uiAuth');
const { createIntl } = require('../core/intl/service');
const { clientIp, rateAllow } = require('../core/clientIp');

const UI_ROOT = path.join(__dirname, '..', 'ui-intl');
const hits = new Map();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'",
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
      if (size > 180000) {
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' })); }
    });
    req.on('error', reject);
  });
}

function authorize(req, config) {
  const header = String(req.headers.authorization || '');
  const initData = header.toLowerCase().startsWith('tma ') ? header.slice(4).trim() : '';
  const checked = verifyInitData(initData, config.TELEGRAM_BOT_TOKEN, { maxAgeS: config.UI_INITDATA_MAX_AGE_S });
  if (!checked.ok) return { ok: false, status: 401, error_code: 'unauthorized' };
  if (!allowedTelegramIds(config).has(checked.user.id)) return { ok: false, status: 403, error_code: 'forbidden' };
  return { ok: true, user: checked.user };
}

function bootError(config) {
  if (config.REAL_DATA_ALLOWED) return 'real_data_blocked';
  if (config.DEMO_UI_NO_AUTH && String(config.UI_PUBLIC_BASE || '').startsWith('https://')) return 'demo_ui_no_auth_blocked';
  if (config.CHANNEL_MODE === 'invalid') return 'channel_mode_invalid';
  if (!secretConfigured(config.HASH_SALT)) return 'hash_salt_missing';
  return '';
}

function buildIntlServer(config, intl) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://intl.local');
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/v1/health')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }
      if (req.method === 'GET' && !pathname.startsWith('/v1/')) {
        serveStatic(res, pathname);
        return;
      }
      const pub = pathname.match(/^\/v1\/intl\/public\/files\/([^/]+)$/);
      if (pub && req.method === 'GET') {
        const result = await intl.publicFile(decodeURIComponent(pub[1]), url.searchParams.get('exp'), url.searchParams.get('sig'));
        if (result && Buffer.isBuffer(result.body_bytes)) {
          res.writeHead(result.status || 200, result.headers || {});
          res.end(result.body_bytes);
          return;
        }
        sendJson(res, Number.isInteger(result.status) ? result.status : 404, result);
        return;
      }
      if (req.method === 'POST' && pathname === '/v1/intl/telegram') {
        const secret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
        if (!config.TELEGRAM_WEBHOOK_SECRET || secret !== config.TELEGRAM_WEBHOOK_SECRET) {
          sendJson(res, 403, { ok: false, error_code: 'forbidden' });
          return;
        }
        const update = await readBody(req);
        const result = await intl.telegram(update);
        sendJson(res, Number.isInteger(result.status) ? result.status : 200, { ...result, telegram_delivery: false });
        return;
      }
      const auth = authorize(req, config);
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, error_code: auth.error_code, message: auth.status === 403 ? 'This bot is not public.' : 'Sign-in required.' });
        return;
      }
      if (!rateAllow(hits, clientIp(req, config.TRUST_PROXY), Date.now(), { limit: 120 })) {
        sendJson(res, 429, { ok: false, error_code: 'rate_limited', message: 'Too many requests.' });
        return;
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await route(intl, config, req, pathname, body, auth.user, url);
      if (result && Buffer.isBuffer(result.body_bytes)) {
        res.writeHead(result.status || 200, result.headers || {});
        res.end(result.body_bytes);
        return;
      }
      sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok === false ? 400 : 200), result);
    } catch (err) {
      const code = err.code === 'invalid_json' || err.code === 'body_too_large' ? 400 : 500;
      if (code === 500) console.error('intl_request_failed');
      sendJson(res, code, { ok: false, error_code: err.code || 'internal', message: 'Request failed.' });
    }
  });
}

async function route(intl, config, req, pathname, body, user, url) {
  if (req.method === 'POST' && pathname === '/v1/sim/wa/inbound') {
    if (config.CHANNEL_MODE !== 'sim') return { ok: false, status: 403, error_code: 'sim_only' };
    return intl.ingest({
      channel: 'wa_sim',
      sender_id: body.from_id,
      sender_name: body.name,
      text: body.text,
      property_id: body.property_id,
      kind: body.kind || 'text',
      non_text_type: body.non_text_type,
      dedup_key: `wa_sim:${body.session_id || 'local'}:${body.msg_id || Date.now()}`,
      reply_target: body.session_id || 'local',
    });
  }
  if (req.method === 'GET' && pathname === '/v1/intl/leads') {
    return { ok: true, leads: intl.leads({ archived: url.searchParams.get('archived') === '1' }) };
  }
  const one = pathname.match(/^\/v1\/intl\/leads\/([^/]+)$/);
  if (req.method === 'GET' && one) {
    const lead = await Promise.resolve(intl.lead(decodeURIComponent(one[1])));
    return lead ? { ok: true, lead } : { ok: false, status: 404, error_code: 'not_found' };
  }
  const sub = pathname.match(/^\/v1\/intl\/leads\/([^/]+)\/(draft|send|reject|viewing|analyze|status|stop|archive|apply-slot)$/);
  if (sub) {
    const id = decodeURIComponent(sub[1]);
    if (sub[2] === 'draft' && req.method === 'PUT') return intl.saveDraft(id, body);
    if (sub[2] === 'send' && req.method === 'POST') {
      return intl.send(id, { ...body, idempotency_key: req.headers['idempotency-key'] || body.idempotency_key }, user.id);
    }
    if (sub[2] === 'reject' && req.method === 'POST') return intl.reject(id, user.id);
    if (sub[2] === 'archive' && req.method === 'POST') return intl.archive(id, user.id);
    if (sub[2] === 'apply-slot' && req.method === 'POST') return intl.applySlot(id, body);
    if (sub[2] === 'stop' && req.method === 'POST') return intl.stop(id, user.id);
    if (sub[2] === 'viewing' && req.method === 'POST') return intl.book(id, body.slot_id, user.id);
    if (sub[2] === 'analyze' && req.method === 'POST') return { ok: true, lead: await Promise.resolve(intl.lead(id)) };
    if (sub[2] === 'status' && req.method === 'POST') return intl.setPipeline(id, body.pipeline, user.id);
  }
  const erase = pathname.match(/^\/v1\/intl\/leads\/([^/]+)\/erase$/);
  if (erase && req.method === 'POST') return intl.erase(decodeURIComponent(erase[1]), user.id);
  if (req.method === 'GET' && pathname === '/v1/intl/digest') return intl.digest();
  if (req.method === 'POST' && pathname === '/v1/intl/digest/send') {
    const result = intl.digestTick('demand', user.id);
    return { ...result, sent: false, simulated: true, telegram_delivery: false };
  }
  if (req.method === 'GET' && pathname === '/v1/intl/properties') {
    const properties = intl.store.all('SELECT * FROM i_property WHERE active = 1 AND id != ?', ['general']).map((row) => ({
      ...row,
      facts: JSON.parse(row.facts || '{}'),
      slots: intl.store.all(`SELECT * FROM i_slot WHERE property_id = ? AND status != 'removed' ORDER BY start_utc`, [row.id]),
    }));
    return { ok: true, properties };
  }
  if (req.method === 'POST' && pathname === '/v1/intl/properties') return intl.addProperty(body, user.id);
  const brochure = pathname.match(/^\/v1\/intl\/properties\/([^/]+)\/brochure\.pdf$/);
  if (brochure && req.method === 'GET') return intl.brochure(decodeURIComponent(brochure[1]));
  const slots = pathname.match(/^\/v1\/intl\/properties\/([^/]+)\/slots$/);
  if (slots && req.method === 'POST') return intl.addSlot(decodeURIComponent(slots[1]), body, user.id);
  if (slots && req.method === 'GET') {
    const property = intl.store.one('SELECT * FROM i_property WHERE id = ?', [decodeURIComponent(slots[1])]);
    const { listFreeSlots } = require('../core/intl/slots');
    return { ok: true, slots: property ? listFreeSlots(intl.store, property, intl.now()) : [] };
  }
  const viewing = pathname.match(/^\/v1\/intl\/viewings\/([^/]+)\/(confirm|cancel)$/);
  if (viewing && req.method === 'POST') return intl.setViewing(decodeURIComponent(viewing[1]), viewing[2] === 'confirm' ? 'confirmed' : 'cancelled', user.id);
  if (req.method === 'GET' && pathname === '/v1/intl/viewings') {
    const viewings = intl.store.all(
      `SELECT v.*, l.sender_name, l.clean_name, l.channel, p.title, p.tz, p.tz_label_en, p.tz_label_ru
       FROM i_viewing v
       LEFT JOIN i_lead l ON l.id = v.lead_id
       LEFT JOIN i_property p ON p.id = v.property_id
       ORDER BY v.start_utc`,
    );
    return { ok: true, viewings };
  }
  if (pathname === '/v1/intl/settings' && req.method === 'GET') {
    const saved = intl.getSettings();
    return {
      ok: true,
      settings: saved,
      manual_approval: true,
      auto_send_hot: saved.auto_send_hot === '1' || saved.auto_send_hot === 'true',
      ephemeral: config.EPHEMERAL_DISK === true,
    };
  }
  if (pathname === '/v1/intl/settings' && req.method === 'POST') return intl.settings(body, user.id);
  if (req.method === 'GET' && pathname === '/v1/intl/audit') return { ok: true, rows: intl.audit(url.searchParams.get('lead_id') || '') };
  if (req.method === 'POST' && pathname === '/v1/intl/seed') {
    const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
    const counts = await intl.seed(pack, body.mode === 'minus_t06' ? 'minus_t06' : 'all');
    return { ok: true, counts };
  }
  return { ok: false, status: 404, error_code: 'not_found' };
}

function serveStatic(res, pathname) {
  if (pathname === '/favicon.ico') {
    pathname = '/favicon.svg';
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(UI_ROOT, rel));
  if (!file.startsWith(UI_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'",
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

async function seedIfEmpty(intl) {
  const count = intl.store.one('SELECT COUNT(*) AS n FROM i_lead').n;
  if (count > 0) return { seeded: false, count };
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
  const counts = await intl.seed(pack, 'all');
  return { seeded: true, counts };
}

async function startIntl(env = process.env) {
  const config = loadConfig(env);
  const problem = bootError(config);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const intl = createIntl(config);
  await seedIfEmpty(intl);
  intl.digestTick('startup');
  const timer = setInterval(() => {
    try {
      intl.digestTick('schedule');
      intl.retain();
      intl.sweep();
      intl.compete();
    } catch {
      console.error('intl_tick_failed');
    }
  }, 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  const server = buildIntlServer(config, intl);
  const port = Number(env.INTL_PORT || env.ENGINE_PORT || 8791);
  await new Promise((resolve) => {
    server.listen(port, listenHost(env), () => {
      const bound = server.address();
      console.log(`intl_listening host=${listenHost(env)} port=${bound && bound.port ? bound.port : port}`);
      resolve();
    });
  });
  return { server, intl, config, timer };
}

if (require.main === module) startIntl();

module.exports = { buildIntlServer, startIntl, bootError, seedIfEmpty };
