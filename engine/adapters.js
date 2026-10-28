'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const { isPlaceholder } = require('../core/config');
const { LEAD_COLUMNS, OBJEKT_COLUMNS, buildLeadRow, contractOk, contractError, propstackDriver, sheetProjection } = require('../core/crm');
const { PgStore, MemoryStore } = require('../core/store');
const { SqliteStore } = require('../core/sqliteStore');
const { FragebogenStore } = require('../core/fragebogen');

const requestContext = new AsyncLocalStorage();
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures');
const NUMBER_FIELDS = new Set(['price_eur', 'kaltmiete_eur', 'warmmiete_eur', 'score', 'budget_max_eur', 'reply_latency_s', 'repeat_count']);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadFixtureObjekte() {
  return readJson(path.join(FIXTURE_ROOT, 'objekte.json'), []);
}

function loadObjekteFile(config) {
  const override = path.join(config.DATA_DIR, 'objekte.json');
  if (fs.existsSync(override)) return readJson(override, loadFixtureObjekte());
  return loadFixtureObjekte();
}

function safeError(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) return 'VALIDATION';
  if (status === 404) return 'NOT_FOUND';
  return 'UNKNOWN';
}

function codedError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

class FileCrm {
  constructor(file) {
    this.file = file;
    this.rows = new Map();
    const saved = readJson(file, []);
    if (Array.isArray(saved)) {
      for (const row of saved) {
        if (row?.lead_id) this.rows.set(row.lead_id, row);
      }
    }
  }

  persist() {
    writeJson(this.file, [...this.rows.values()]);
  }

  async upsertLead(row) {
    const existing = this.rows.has(row.lead_id);
    this.rows.set(row.lead_id, { ...row });
    this.persist();
    return contractOk(existing ? 'updated' : 'created', { contact_id: row.lead_id });
  }

  async updateStatus(leadId, patch) {
    const row = this.rows.get(leadId);
    if (!row) return contractError('NOT_FOUND', false, 'lead_not_found');
    this.rows.set(leadId, buildLeadRow({ ...row, ...patch, lead_id: leadId }));
    this.persist();
    return contractOk('updated', { contact_id: leadId });
  }

  async findByEmail(email) {
    const wanted = String(email || '').toLowerCase();
    for (const row of this.rows.values()) {
      if (String(row.email).toLowerCase() === wanted) return { ok: true, lead: row };
    }
    return { ok: true, lead: null };
  }

  async findByLeadId(leadId) {
    return { ok: true, lead: this.rows.get(leadId) || null };
  }

  async deleteLead(leadId) {
    const had = this.rows.delete(leadId);
    this.persist();
    return had;
  }

  async listLeads() {
    return [...this.rows.values()];
  }

  async reset() {
    this.rows.clear();
    this.persist();
  }
}

class GoogleAuth {
  constructor(config) {
    this.config = config;
    this.token = '';
    this.exp = 0;
  }

  configured() {
    return !isPlaceholder(this.config.GOOGLE_OAUTH_CLIENT_ID)
      && !isPlaceholder(this.config.GOOGLE_OAUTH_CLIENT_SECRET)
      && !isPlaceholder(this.config.GOOGLE_OAUTH_REFRESH_TOKEN);
  }

  async accessToken() {
    if (!this.configured()) throw codedError('AUTH');
    if (this.token && this.exp > Date.now() + 30000) return this.token;
    const body = new URLSearchParams({
      client_id: this.config.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: this.config.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: this.config.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw codedError(res.status === 400 || res.status === 401 ? 'AUTH' : safeError(res.status));
    const data = await res.json();
    if (!data.access_token) throw codedError('AUTH');
    this.token = data.access_token;
    this.exp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return this.token;
  }

  async api(url, options = {}) {
    const token = await this.accessToken();
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw codedError(safeError(res.status));
    if (res.status === 204) return null;
    return res.json();
  }

  async sheetValues(sheetId, tab) {
    if (!sheetId) throw codedError('AUTH');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(tab)}`;
    const data = await this.api(url);
    return data.values || [];
  }

  async putValues(sheetId, range, values) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    return this.api(url, { method: 'PUT', body: JSON.stringify({ values }) });
  }

  async appendValues(sheetId, range, values) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    return this.api(url, { method: 'POST', body: JSON.stringify({ values }) });
  }
}

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function rowToLead(headers, values) {
  const lead = {};
  headers.forEach((key, index) => {
    if (!key) return;
    lead[key] = values[index] == null ? '' : values[index];
  });
  return lead;
}

class SheetsCrm {
  constructor(config, google) {
    this.config = config;
    this.google = google;
    this.sheetId = config.GOOGLE_SHEET_ID;
  }

  async grid() {
    const values = await this.google.sheetValues(this.sheetId, 'Leads');
    if (!values.length) {
      await this.google.putValues(this.sheetId, 'Leads!A1', [LEAD_COLUMNS]);
      return { headers: LEAD_COLUMNS.slice(), rows: [] };
    }
    return { headers: values[0], rows: values.slice(1) };
  }

  async upsertLead(row) {
    try {
      const grid = await this.grid();
      const idCol = Math.max(0, grid.headers.indexOf('lead_id'));
      const visible = sheetProjection(row, this.config.SHEET_INCLUDE_CONTACT === true);
      const line = grid.headers.map((key) => cell(visible[key]));
      const index = grid.rows.findIndex((existing) => String(existing[idCol] || '') === String(row.lead_id));
      if (index === -1) {
        await this.google.appendValues(this.sheetId, 'Leads!A1', [line]);
        return contractOk('created', { contact_id: row.lead_id });
      }
      const sheetRow = index + 2;
      await this.google.putValues(this.sheetId, `Leads!A${sheetRow}`, [line]);
      return contractOk('updated', { contact_id: row.lead_id, row_number: sheetRow });
    } catch (err) {
      return contractError(err.code || 'UNKNOWN', err.code === 'RATE_LIMIT', 'crm_failed');
    }
  }

  async updateStatus(leadId, patch) {
    try {
      const grid = await this.grid();
      const idCol = Math.max(0, grid.headers.indexOf('lead_id'));
      const index = grid.rows.findIndex((existing) => String(existing[idCol] || '') === String(leadId));
      if (index === -1) return contractError('NOT_FOUND', false, 'lead_not_found');
      const current = rowToLead(grid.headers, grid.rows[index]);
      const merged = sheetProjection(
        buildLeadRow({ ...current, ...patch, lead_id: leadId }),
        this.config.SHEET_INCLUDE_CONTACT === true,
      );
      const line = grid.headers.map((key) => cell(merged[key]));
      await this.google.putValues(this.sheetId, `Leads!A${index + 2}`, [line]);
      return contractOk('updated', { contact_id: leadId });
    } catch (err) {
      return contractError(err.code || 'UNKNOWN', err.code === 'RATE_LIMIT', 'crm_failed');
    }
  }

  async findByEmail(email) {
    try {
      const grid = await this.grid();
      const wanted = String(email || '').toLowerCase();
      for (const values of grid.rows) {
        const lead = rowToLead(grid.headers, values);
        if (String(lead.email || '').toLowerCase() === wanted) return { ok: true, lead };
      }
      return { ok: true, lead: null };
    } catch (err) {
      return { ok: false, lead: null, error: { code: err.code || 'UNKNOWN' } };
    }
  }

  async findByLeadId(leadId) {
    try {
      const grid = await this.grid();
      const idCol = Math.max(0, grid.headers.indexOf('lead_id'));
      const values = grid.rows.find((existing) => String(existing[idCol] || '') === String(leadId));
      return { ok: true, lead: values ? rowToLead(grid.headers, values) : null };
    } catch (err) {
      return { ok: false, lead: null, error: { code: err.code || 'UNKNOWN' } };
    }
  }

  async deleteLead(leadId) {
    return this.updateStatus(leadId, {
      salutation: '',
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      retention_until: '',
      pipeline_status: 'geloescht',
    });
  }

  async listLeads() {
    const grid = await this.grid();
    return grid.rows.map((values) => rowToLead(grid.headers, values)).filter((row) => row.lead_id);
  }

  async reset() {
    await this.google.putValues(this.sheetId, 'Leads!A1', [LEAD_COLUMNS]);
  }
}

function createCrm(config) {
  if (config.CRM_TARGET === 'propstack') return propstackDriver();
  if (config.CRM_MODE === 'sheets') return new SheetsCrm(config, new GoogleAuth(config));
  if (config.CRM_MODE === 'memory') return new (require('../core/crm').MemoryCrm)();
  return new FileCrm(path.join(config.DATA_DIR, 'crm', 'leads.json'));
}

class MemoryCalendar {
  constructor(file) {
    this.file = file;
    this.events = readJson(file, []);
    if (!Array.isArray(this.events)) this.events = [];
  }

  persist() {
    if (this.file) writeJson(this.file, this.events);
  }

  async getBusy() {
    return this.events.map((row) => ({ start: row.start, end: row.end }));
  }

  async createEvent(event) {
    const event_id = `evt-${crypto.randomBytes(4).toString('hex')}`;
    this.events.push({
      event_id,
      start: event.start,
      end: event.end,
      title: event.title,
      description: event.description,
    });
    this.persist();
    return { event_id };
  }

  async updateForLead(leadId, patch) {
    let n = 0;
    for (const event of this.events) {
      if (!eventTitleForLead(event.title, leadId)) continue;
      if (patch.start) event.start = patch.start;
      if (patch.end) event.end = patch.end;
      n += 1;
    }
    if (n) this.persist();
    return n;
  }

  async deleteForLead(leadId) {
    const before = this.events.length;
    this.events = this.events.filter((event) => !eventTitleForLead(event.title, leadId));
    if (this.events.length !== before) this.persist();
    return before - this.events.length;
  }

  async reset() {
    this.events = this.events.filter((row) => !String(row.title || '').startsWith('Besichtigung '));
    this.persist();
  }
}

function eventTitleForLead(title, leadId) {
  const text = String(title || '');
  const id = String(leadId || '');
  if (!id || !text.includes(id)) return false;
  return text.startsWith('Besichtigung ') || text.startsWith('Bewertung ');
}

class GoogleCalendar {
  constructor(config, google) {
    this.config = config;
    this.google = google;
    this.calendarId = config.GOOGLE_CALENDAR_ID || 'primary';
  }

  async getBusy({ start, end, tz }) {
    const data = await this.google.api('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      body: JSON.stringify({
        timeMin: start,
        timeMax: end,
        timeZone: tz || 'Europe/Berlin',
        items: [{ id: this.calendarId }],
      }),
    });
    const busy = data?.calendars?.[this.calendarId]?.busy || [];
    return busy.map((row) => ({ start: row.start, end: row.end }));
  }

  async createEvent(event) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`;
    const data = await this.google.api(url, {
      method: 'POST',
      body: JSON.stringify({
        summary: event.title,
        description: event.description,
        start: { dateTime: event.start, timeZone: event.tz || 'Europe/Berlin' },
        end: { dateTime: event.end, timeZone: event.tz || 'Europe/Berlin' },
      }),
    });
    return { event_id: data.id };
  }

  async updateForLead(leadId, patch) {
    return this.touchLeadEvents(leadId, async (item) => {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(item.id)}`;
      await this.google.api(url, {
        method: 'PATCH',
        body: JSON.stringify({
          start: { dateTime: patch.start, timeZone: patch.tz || 'Europe/Berlin' },
          end: { dateTime: patch.end, timeZone: patch.tz || 'Europe/Berlin' },
        }),
      });
    });
  }

  async deleteForLead(leadId) {
    return this.touchLeadEvents(leadId, async (item) => {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(item.id)}`;
      await this.google.api(url, { method: 'DELETE' });
    });
  }

  async touchLeadEvents(leadId, fn) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?q=${encodeURIComponent(leadId)}&singleEvents=true&maxResults=20`;
    const data = await this.google.api(url);
    let n = 0;
    for (const item of data.items || []) {
      if (!eventTitleForLead(item.summary, leadId)) continue;
      await fn(item);
      n += 1;
    }
    return n;
  }

  async reset() {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?q=${encodeURIComponent('Besichtigung')}&singleEvents=true&maxResults=250`;
    const data = await this.google.api(url);
    for (const item of data.items || []) {
      if (!String(item.summary || '').startsWith('Besichtigung ')) continue;
      const del = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(item.id)}`;
      await this.google.api(del, { method: 'DELETE' });
    }
  }
}

function createCalendar(config) {
  if (config.CALENDAR_MODE === 'google') return new GoogleCalendar(config, new GoogleAuth(config));
  return new MemoryCalendar(path.join(config.DATA_DIR, 'calendar.json'));
}

function createMail(config) {
  const dir = path.join(config.DATA_DIR, 'outbox');
  if (config.MAIL_MODE !== 'smtp') {
    return {
      async send(message) {
        ensureDir(dir);
        const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
        writeJson(path.join(dir, name), {
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          messageId: message.messageId,
          inReplyTo: message.inReplyTo || '',
          references: message.references || '',
          headers: message.headers || {},
        });
      },
    };
  }
  if (isPlaceholder(config.SMTP_HOST) || isPlaceholder(config.SMTP_USER)) {
    return { async send() { throw codedError('mail_not_configured'); } };
  }
  const secure = config.SMTP_SECURE === 'ssl' || config.SMTP_PORT === 465;
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    requireTLS: !secure && config.SMTP_SECURE !== 'plain',
  });
  return {
    async send(message) {
      const messageId = String(message.messageId || '').replace(/^<|>$/g, '');
      await transporter.sendMail({
        from: message.from,
        to: message.to,
        envelope: { from: config.SMTP_USER, to: message.to },
        subject: message.subject,
        text: message.text,
        messageId,
        inReplyTo: message.inReplyTo,
        references: message.references,
        headers: message.headers,
      });
    },
  };
}

function assertOpsText(text) {
  const safe = String(text || '');
  if (!safe || safe.length > 400 || /@/.test(safe)) throw codedError('ops_alert_rejected');
  return safe;
}

function createTelegram(config) {
  const file = path.join(config.DATA_DIR, 'telegram.log');
  const write = (text) => {
    ensureDir(config.DATA_DIR);
    fs.appendFileSync(file, `${text}\n---\n`);
  };
  async function post(chatId, text) {
    const token = config.TELEGRAM_BOT_TOKEN;
    if (isPlaceholder(token) || !chatId) throw codedError('telegram_not_configured');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw codedError(res.status === 401 || res.status === 403 ? 'telegram_auth' : 'telegram_failed');
  }
  if (config.TELEGRAM_MODE !== 'telegram') {
    return {
      async send(text) { write(text); },
      async sendOps(text) { write(`ops ${assertOpsText(text)}`); },
    };
  }
  return {
    async send(text) {
      await post(config.MAKLER_PROFILE.telegram_user_id, text);
    },
    async sendOps(text) {
      const safe = assertOpsText(text);
      const chat = config.OPS_TELEGRAM_CHAT_ID || config.TELEGRAM_CHAT_ID || config.MAKLER_PROFILE.telegram_user_id;
      await post(chat, safe);
    },
  };
}

function sniffFixture(request) {
  const blob = JSON.stringify(request?.messages || []);
  if (blob.includes('63843270')) return 'E01';
  if (blob.includes('81220011')) return 'E02';
  return '';
}

function createLlm(config) {
  return async function llm(request) {
    const model = String(request?.model || '');
    if (/labs/i.test(model)) throw codedError('labs_model_forbidden');
    if (config.LLM_MODE !== 'live') {
      const store = requestContext.getStore();
      const fixture = store?.fixture || sniffFixture(request);
      if (!fixture) throw codedError('unknown_fixture');
      const file = path.join(FIXTURE_ROOT, 'llm', `${fixture}.json`);
      if (!fs.existsSync(file)) throw codedError('unknown_fixture');
      const data = readJson(file, null);
      const name = request?.response_format?.json_schema?.name;
      if (name === 'lead_extraction') {
        return { content: JSON.stringify(data.extraction), model: 'mock', tokens_in: 10, tokens_out: 20 };
      }
      if (name === 'reply_body') {
        return { content: JSON.stringify(data.reply), model: 'mock', tokens_in: 8, tokens_out: 12 };
      }
      throw codedError('unexpected_schema');
    }
    if (isPlaceholder(config.LLM_API_KEY)) throw codedError('missing_api_key');
    const res = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.LLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw codedError(`mistral_http_${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return {
      content,
      model: data.model || model,
      tokens_in: data.usage?.prompt_tokens || 0,
      tokens_out: data.usage?.completion_tokens || 0,
    };
  };
}

function coerceObjekt(row) {
  const out = {};
  for (const key of OBJEKT_COLUMNS) {
    const value = row[key];
    if (value === '' || value === undefined || value === null) {
      out[key] = NUMBER_FIELDS.has(key) ? null : '';
      continue;
    }
    if (NUMBER_FIELDS.has(key)) {
      const n = Number(String(value).replace(/\s/g, '').replace(/\./g, '').replace(',', '.'));
      out[key] = Number.isFinite(n) ? n : null;
      continue;
    }
    out[key] = value;
  }
  if (row.portal_listing_id) out.portal_listing_id = String(row.portal_listing_id);
  return out;
}

async function loadObjekte(config, google) {
  if (config.CRM_MODE === 'sheets' && config.GOOGLE_SHEET_ID && google) {
    try {
      const values = await google.sheetValues(config.GOOGLE_SHEET_ID, 'Objekte');
      if (values.length > 1) {
        const headers = values[0];
        return values.slice(1)
          .filter((row) => row.some((cellValue) => String(cellValue || '').trim()))
          .map((row) => {
            const obj = {};
            headers.forEach((key, index) => { obj[key] = row[index] ?? ''; });
            return coerceObjekt(obj);
          });
      }
    } catch {
      // Sheet is optional at boot. The seeded file remains the source until it answers.
    }
  }
  return loadObjekteFile(config).map(coerceObjekt);
}

async function seedObjekte(config, google) {
  const rows = loadFixtureObjekte();
  writeJson(path.join(config.DATA_DIR, 'objekte.json'), rows);
  if (config.CRM_MODE === 'sheets' && config.GOOGLE_SHEET_ID && google) {
    const values = [
      OBJEKT_COLUMNS,
      ...rows.map((row) => OBJEKT_COLUMNS.map((key) => cell(row[key]))),
    ];
    await google.putValues(config.GOOGLE_SHEET_ID, 'Objekte!A1', values);
  }
  return rows.map(coerceObjekt);
}

function createLogger(config) {
  const file = path.join(config.DATA_DIR, 'engine.log');
  return async function log(event) {
    ensureDir(config.DATA_DIR);
    const line = {
      ts: new Date().toISOString(),
      workflow: event.workflow || '',
      step: event.step || '',
      event_code: event.event_code || '',
      lead_id: event.lead_id || '',
      grade: event.grade || '',
      status: event.status || '',
      message_id_hash: event.message_id_hash || '',
      meta: event.meta || {},
    };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  };
}

async function createRuntime(config) {
  ensureDir(config.DATA_DIR);
  let db;
  let storeKind = 'memory';
  const sqliteFile = path.join(config.DATA_DIR, 'autopilot.sqlite');
  if (config.DATABASE_URL) {
    const pool = new Pool({ connectionString: config.DATABASE_URL });
    db = new PgStore(pool);
    await db.migrate();
    storeKind = 'postgres';
  } else if (config.UI_STORE === 'sqlite') {
    db = new SqliteStore(sqliteFile);
    storeKind = 'sqlite';
  } else {
    db = new MemoryStore();
  }
  const board = config.UI_STORE === 'sqlite'
    ? (storeKind === 'sqlite' ? db : new SqliteStore(sqliteFile))
    : null;
  const google = new GoogleAuth(config);
  const objekte = await loadObjekte(config, config.CRM_MODE === 'sheets' ? google : null);
  const fragebogen = board
    ? new FragebogenStore({
      salt: config.HASH_SALT,
      publicBase: config.UI_PUBLIC_BASE,
      linkDays: config.FRAGEBOGEN_LINK_DAYS,
      file: path.join(config.DATA_DIR, 'fragebogen.json'),
    })
    : null;
  return {
    config,
    clock: () => new Date(),
    db,
    board,
    crm: createCrm(config),
    calendar: createCalendar(config),
    mail: createMail(config),
    telegram: createTelegram(config),
    objekte,
    fragebogen,
    llm: createLlm(config),
    log: createLogger(config),
    storeKind,
    google,
    imapLastOk: '',
    imapLastError: '',
  };
}

module.exports = {
  requestContext,
  createRuntime,
  createCrm,
  createCalendar,
  createMail,
  createTelegram,
  createLlm,
  loadObjekte,
  seedObjekte,
  loadFixtureObjekte,
  FileCrm,
  MemoryCalendar,
  GoogleAuth,
};
