'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { redactMeta } = require('./redact');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id_hash TEXT PRIMARY KEY,
  content_hash TEXT,
  lead_id TEXT,
  outcome TEXT,
  status TEXT,
  first_seen_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS outbound (
  sent_message_id_hash TEXT PRIMARY KEY,
  lead_id TEXT,
  kind TEXT,
  offered_slots TEXT,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS bookings (
  lead_id TEXT PRIMARY KEY,
  slot_start TEXT,
  slot_end TEXT,
  event_id TEXT,
  status TEXT,
  booking_version INTEGER
);
CREATE TABLE IF NOT EXISTS optout (
  email_hash TEXT PRIMARY KEY,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS lead_claims (
  email_hash TEXT,
  portal_listing_id TEXT,
  lead_id TEXT,
  PRIMARY KEY (email_hash, portal_listing_id)
);
CREATE TABLE IF NOT EXISTS lead_counter (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS crm_outbox (
  idempotency_key TEXT PRIMARY KEY,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS ui_leads (
  lead_id TEXT PRIMARY KEY,
  created_at TEXT,
  retention_until TEXT,
  card TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ui_bookings (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  slot_start TEXT,
  card TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ui_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

class SqliteStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  one(sql, params = []) {
    return this.db.prepare(sql).get(...params) || null;
  }

  all(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }

  close() {
    this.db.close();
  }

  async claimMessage({ messageIdHash, contentHash, now = new Date() }) {
    if (!messageIdHash) return false;
    const existing = this.one(
      'SELECT * FROM processed_messages WHERE message_id_hash = ?',
      [messageIdHash],
    );
    if (existing) {
      const seen = Date.parse(existing.first_seen_at || 0);
      const stale = existing.status === 'processing' && now.getTime() - seen > 15 * 60 * 1000;
      if (existing.status !== 'error' && !stale) return false;
      this.run(
        `UPDATE processed_messages
            SET status = 'processing', content_hash = ?, first_seen_at = ?, finished_at = NULL, outcome = NULL, lead_id = NULL
          WHERE message_id_hash = ?`,
        [contentHash, now.toISOString(), messageIdHash],
      );
      return true;
    }
    this.run(
      `INSERT INTO processed_messages (message_id_hash, content_hash, status, first_seen_at)
       VALUES (?, ?, 'processing', ?)`,
      [messageIdHash, contentHash, now.toISOString()],
    );
    return true;
  }

  async finishMessage({ messageIdHash, leadId, outcome, status }) {
    const res = this.run(
      `UPDATE processed_messages
          SET lead_id = ?, outcome = ?, status = ?, finished_at = ?
        WHERE message_id_hash = ?`,
      [leadId || null, outcome || null, status || 'done', new Date().toISOString(), messageIdHash],
    );
    return res.changes > 0;
  }

  async failProcessing(messageIdHash) {
    if (!messageIdHash) return false;
    const res = this.run(
      `UPDATE processed_messages
          SET outcome = 'ERROR', status = 'error', finished_at = ?
        WHERE message_id_hash = ? AND status = 'processing'`,
      [new Date().toISOString(), messageIdHash],
    );
    return res.changes > 0;
  }

  async nextLeadId(day) {
    this.run(
      `INSERT INTO lead_counter (day, n) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET n = n + 1`,
      [day],
    );
    const row = this.one('SELECT n FROM lead_counter WHERE day = ?', [day]);
    const compact = String(day).replace(/-/g, '');
    return `L-${compact}-${String(row.n).padStart(4, '0')}`;
  }

  async isOptout(emailHashValue) {
    if (!emailHashValue) return false;
    return Boolean(this.one('SELECT 1 AS ok FROM optout WHERE email_hash = ?', [emailHashValue]));
  }

  async addOptout(emailHashValue) {
    if (!emailHashValue) return;
    this.run(
      'INSERT INTO optout (email_hash, created_at) VALUES (?, ?) ON CONFLICT(email_hash) DO NOTHING',
      [emailHashValue, new Date().toISOString()],
    );
  }

  async insertOutbound(row) {
    this.run(
      `INSERT INTO outbound (sent_message_id_hash, lead_id, kind, offered_slots, sent_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        row.sent_message_id_hash,
        row.lead_id,
        row.kind,
        JSON.stringify(row.offered_slots || null),
        row.sent_at,
      ],
    );
  }

  async findOutboundByHash(hash) {
    if (!hash) return null;
    const row = this.one('SELECT * FROM outbound WHERE sent_message_id_hash = ?', [hash]);
    return row ? coerceOutbound(row) : null;
  }

  async findLatestOutbound(leadId, kind) {
    const row = kind
      ? this.one(
        'SELECT * FROM outbound WHERE lead_id = ? AND kind = ? ORDER BY sent_at DESC LIMIT 1',
        [leadId, kind],
      )
      : this.one(
        'SELECT * FROM outbound WHERE lead_id = ? ORDER BY sent_at DESC LIMIT 1',
        [leadId],
      );
    return row ? coerceOutbound(row) : null;
  }

  async countSentSince(iso) {
    const row = this.one('SELECT count(*) AS n FROM outbound WHERE sent_at >= ?', [iso]);
    return Number(row?.n || 0);
  }

  async upsertBooking(row) {
    this.run(
      `INSERT INTO bookings (lead_id, slot_start, slot_end, event_id, status, booking_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(lead_id) DO UPDATE SET
         slot_start = excluded.slot_start,
         slot_end = excluded.slot_end,
         event_id = excluded.event_id,
         status = excluded.status,
         booking_version = excluded.booking_version`,
      [row.lead_id, row.slot_start, row.slot_end, row.event_id, row.status, row.booking_version || 1],
    );
  }

  async getBooking(leadId) {
    return this.one('SELECT * FROM bookings WHERE lead_id = ?', [leadId]);
  }

  async addClaim({ emailHashValue, portalListingId, leadId }) {
    const res = this.run(
      `INSERT INTO lead_claims (email_hash, portal_listing_id, lead_id)
       VALUES (?, ?, ?)
       ON CONFLICT(email_hash, portal_listing_id) DO NOTHING`,
      [emailHashValue, portalListingId || '', leadId],
    );
    return res.changes > 0;
  }

  async logEvent(event) {
    const row = {
      ts: new Date().toISOString(),
      workflow: event.workflow || '',
      step: event.step || '',
      lead_id: event.lead_id || null,
      message_id_hash: event.message_id_hash || null,
      status: event.status || '',
      event_code: event.event_code || '',
      grade: event.grade || null,
      meta: redactMeta(event.meta || {}, event.names || []),
    };
    this.run('INSERT INTO events (payload) VALUES (?)', [JSON.stringify(row)]);
    return row;
  }

  async enqueueCrm(row) {
    this.run(
      'INSERT INTO crm_outbox (idempotency_key, payload) VALUES (?, ?) ON CONFLICT(idempotency_key) DO NOTHING',
      [row.idempotency_key, JSON.stringify(row.payload || {})],
    );
  }

  async deleteLeadOps(leadId) {
    if (!leadId) return;
    this.run('DELETE FROM outbound WHERE lead_id = ?', [leadId]);
    this.run('DELETE FROM bookings WHERE lead_id = ?', [leadId]);
    this.run('DELETE FROM lead_claims WHERE lead_id = ?', [leadId]);
    this.run('DELETE FROM processed_messages WHERE lead_id = ?', [leadId]);
    this.run('DELETE FROM ui_bookings WHERE lead_id = ?', [leadId]);
  }

  async reset() {
    this.db.exec(`
      DELETE FROM processed_messages;
      DELETE FROM outbound;
      DELETE FROM bookings;
      DELETE FROM optout;
      DELETE FROM lead_claims;
      DELETE FROM lead_counter;
      DELETE FROM events;
      DELETE FROM crm_outbox;
      DELETE FROM ui_leads;
      DELETE FROM ui_bookings;
      DELETE FROM ui_meta;
    `);
  }

  async upsertCard(card) {
    if (!card?.lead_id) return;
    this.run(
      `INSERT INTO ui_leads (lead_id, created_at, retention_until, card)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(lead_id) DO UPDATE SET
         created_at = excluded.created_at,
         retention_until = excluded.retention_until,
         card = excluded.card`,
      [card.lead_id, card.created_at || '', card.retention_until || '', JSON.stringify(card)],
    );
  }

  async getCard(leadId) {
    const row = this.one('SELECT card FROM ui_leads WHERE lead_id = ?', [leadId]);
    return row ? JSON.parse(row.card) : null;
  }

  async listCards() {
    return this.all('SELECT card FROM ui_leads ORDER BY created_at DESC').map((row) => JSON.parse(row.card));
  }

  async expiredCards(iso) {
    return this.all(
      `SELECT card FROM ui_leads
        WHERE retention_until IS NOT NULL AND retention_until != '' AND retention_until < ?`,
      [iso],
    ).map((row) => JSON.parse(row.card));
  }

  async deleteCard(leadId) {
    this.run('DELETE FROM ui_leads WHERE lead_id = ?', [leadId]);
    this.run('DELETE FROM ui_bookings WHERE lead_id = ?', [leadId]);
  }

  async upsertUiBooking(booking) {
    if (!booking?.id) return;
    this.run(
      `INSERT INTO ui_bookings (id, lead_id, slot_start, card)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET lead_id = excluded.lead_id, slot_start = excluded.slot_start, card = excluded.card`,
      [booking.id, booking.lead_id || '', booking.slot_start || '', JSON.stringify(booking)],
    );
  }

  async listUiBookings() {
    return this.all('SELECT card FROM ui_bookings ORDER BY slot_start').map((row) => JSON.parse(row.card));
  }

  async minutes(fallback) {
    const row = this.one('SELECT value FROM ui_meta WHERE key = ?', ['minutes']);
    if (!row) return fallback;
    try {
      return { ...fallback, ...JSON.parse(row.value) };
    } catch {
      return fallback;
    }
  }

  async setMinutes(minutes) {
    this.run(
      'INSERT INTO ui_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['minutes', JSON.stringify(minutes)],
    );
  }

  async countOptout() {
    return Number(this.one('SELECT count(*) AS n FROM optout')?.n || 0);
  }
}

function coerceOutbound(row) {
  let offered = row.offered_slots;
  if (typeof offered === 'string') {
    try {
      offered = JSON.parse(offered);
    } catch {
      offered = null;
    }
  }
  return { ...row, offered_slots: offered };
}

module.exports = { SqliteStore };
