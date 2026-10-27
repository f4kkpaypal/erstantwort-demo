'use strict';

const fs = require('fs');
const path = require('path');
const { redactMeta } = require('./redact');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '001_ops.sql'),
  'utf8',
);

class MemoryStore {
  constructor() {
    this.messages = new Map();
    this.outbound = new Map();
    this.outboundByLead = new Map();
    this.bookings = new Map();
    this.optouts = new Set();
    this.claims = new Map();
    this.counters = new Map();
    this.events = [];
    this.outbox = [];
    this.sentAt = [];
  }

  async claimMessage({ messageIdHash, contentHash, now = new Date() }) {
    if (!messageIdHash) return false;
    const existing = this.messages.get(messageIdHash);
    if (existing) {
      const seen = Date.parse(existing.first_seen_at || 0);
      const stale = existing.status === 'processing' && now.getTime() - seen > 15 * 60 * 1000;
      if (existing.status !== 'error' && !stale) return false;
      existing.status = 'processing';
      existing.content_hash = contentHash;
      existing.first_seen_at = now.toISOString();
      existing.finished_at = null;
      existing.outcome = null;
      existing.lead_id = null;
      return true;
    }
    this.messages.set(messageIdHash, {
      message_id_hash: messageIdHash,
      content_hash: contentHash,
      status: 'processing',
      first_seen_at: now.toISOString(),
      lead_id: null,
      outcome: null,
    });
    return true;
  }

  async finishMessage({ messageIdHash, leadId, outcome, status }) {
    const row = this.messages.get(messageIdHash);
    if (!row) return false;
    row.lead_id = leadId || null;
    row.outcome = outcome || null;
    row.status = status || 'done';
    row.finished_at = new Date().toISOString();
    return true;
  }

  async failProcessing(messageIdHash) {
    const row = this.messages.get(messageIdHash);
    if (!row || row.status !== 'processing') return false;
    row.outcome = 'ERROR';
    row.status = 'error';
    row.finished_at = new Date().toISOString();
    return true;
  }

  async nextLeadId(day) {
    const n = (this.counters.get(day) || 0) + 1;
    this.counters.set(day, n);
    const compact = String(day).replace(/-/g, '');
    return `L-${compact}-${String(n).padStart(4, '0')}`;
  }

  async isOptout(emailHashValue) {
    return this.optouts.has(emailHashValue);
  }

  async addOptout(emailHashValue) {
    if (emailHashValue) this.optouts.add(emailHashValue);
  }

  async insertOutbound(row) {
    this.outbound.set(row.sent_message_id_hash, row);
    const list = this.outboundByLead.get(row.lead_id) || [];
    list.push(row);
    this.outboundByLead.set(row.lead_id, list);
    this.sentAt.push(row.sent_at);
  }

  async findOutboundByHash(hash) {
    return this.outbound.get(hash) || null;
  }

  async findLatestOutbound(leadId, kind) {
    const list = this.outboundByLead.get(leadId) || [];
    const filtered = kind ? list.filter((row) => row.kind === kind) : list;
    return filtered.length ? filtered[filtered.length - 1] : null;
  }

  async countSentSince(iso) {
    return this.sentAt.filter((ts) => ts >= iso).length;
  }

  async upsertBooking(row) {
    this.bookings.set(row.lead_id, row);
  }

  async getBooking(leadId) {
    return this.bookings.get(leadId) || null;
  }

  async addClaim({ emailHashValue, portalListingId, leadId }) {
    const key = `${emailHashValue}|${portalListingId}`;
    if (this.claims.has(key)) return false;
    this.claims.set(key, leadId);
    return true;
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
    this.events.push(row);
    return row;
  }

  async enqueueCrm(row) {
    this.outbox.push(row);
  }

  async deleteLeadOps(leadId) {
    if (!leadId) return;
    for (const [hash, row] of [...this.outbound.entries()]) {
      if (row.lead_id === leadId) this.outbound.delete(hash);
    }
    for (const [id, list] of [...this.outboundByLead.entries()]) {
      if (id === leadId) this.outboundByLead.delete(id);
    }
    this.bookings.delete(leadId);
    for (const [key, value] of [...this.claims.entries()]) {
      if (value === leadId) this.claims.delete(key);
    }
    for (const [hash, row] of [...this.messages.entries()]) {
      if (row.lead_id === leadId) this.messages.delete(hash);
    }
  }

  async reset() {
    this.messages.clear();
    this.outbound.clear();
    this.outboundByLead.clear();
    this.bookings.clear();
    this.optouts.clear();
    this.claims.clear();
    this.counters.clear();
    this.events.length = 0;
    this.outbox.length = 0;
    this.sentAt.length = 0;
  }
}

class PgStore {
  constructor(pool) {
    this.pool = pool;
  }

  async migrate() {
    await this.pool.query(MIGRATION_SQL);
    await this.pool.query(
      `INSERT INTO ops.schema_migrations (filename) VALUES ('001_ops.sql') ON CONFLICT DO NOTHING`,
    );
  }

  async claimMessage({ messageIdHash, contentHash }) {
    const res = await this.pool.query(
      `INSERT INTO ops.processed_messages (message_id_hash, content_hash, status)
       VALUES ($1, $2, 'processing')
       ON CONFLICT (message_id_hash) DO UPDATE
         SET status = 'processing',
             content_hash = EXCLUDED.content_hash,
             first_seen_at = now(),
             finished_at = NULL,
             outcome = NULL,
             lead_id = NULL
       WHERE ops.processed_messages.status = 'error'
          OR (ops.processed_messages.status = 'processing'
              AND ops.processed_messages.first_seen_at < now() - interval '15 minutes')
       RETURNING message_id_hash`,
      [messageIdHash, contentHash],
    );
    return res.rowCount > 0;
  }

  async finishMessage({ messageIdHash, leadId, outcome, status }) {
    const res = await this.pool.query(
      `UPDATE ops.processed_messages
          SET lead_id = $2, outcome = $3, status = $4, finished_at = now()
        WHERE message_id_hash = $1`,
      [messageIdHash, leadId || null, outcome || null, status || 'done'],
    );
    return res.rowCount > 0;
  }

  async failProcessing(messageIdHash) {
    if (!messageIdHash) return false;
    const res = await this.pool.query(
      `UPDATE ops.processed_messages
          SET outcome = 'ERROR', status = 'error', finished_at = now()
        WHERE message_id_hash = $1 AND status = 'processing'
        RETURNING message_id_hash`,
      [messageIdHash],
    );
    return res.rowCount > 0;
  }

  async nextLeadId(day) {
    const res = await this.pool.query(
      `INSERT INTO ops.lead_counter (day, n) VALUES ($1::date, 1)
       ON CONFLICT (day) DO UPDATE SET n = ops.lead_counter.n + 1
       RETURNING n`,
      [day],
    );
    const n = res.rows[0].n;
    const compact = String(day).replace(/-/g, '');
    return `L-${compact}-${String(n).padStart(4, '0')}`;
  }

  async isOptout(emailHashValue) {
    if (!emailHashValue) return false;
    const res = await this.pool.query(`SELECT 1 FROM ops.optout WHERE email_hash = $1`, [emailHashValue]);
    return res.rowCount > 0;
  }

  async addOptout(emailHashValue) {
    if (!emailHashValue) return;
    await this.pool.query(
      `INSERT INTO ops.optout (email_hash) VALUES ($1) ON CONFLICT DO NOTHING`,
      [emailHashValue],
    );
  }

  async insertOutbound(row) {
    await this.pool.query(
      `INSERT INTO ops.outbound (sent_message_id_hash, lead_id, kind, offered_slots, sent_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
      [row.sent_message_id_hash, row.lead_id, row.kind, JSON.stringify(row.offered_slots || null), row.sent_at],
    );
  }

  async findOutboundByHash(hash) {
    if (!hash) return null;
    const res = await this.pool.query(`SELECT * FROM ops.outbound WHERE sent_message_id_hash = $1`, [hash]);
    return res.rows[0] ? coerceOutbound(res.rows[0]) : null;
  }

  async findLatestOutbound(leadId, kind) {
    const res = kind
      ? await this.pool.query(
        `SELECT * FROM ops.outbound WHERE lead_id = $1 AND kind = $2 ORDER BY sent_at DESC LIMIT 1`,
        [leadId, kind],
      )
      : await this.pool.query(
        `SELECT * FROM ops.outbound WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 1`,
        [leadId],
      );
    return res.rows[0] ? coerceOutbound(res.rows[0]) : null;
  }

  async countSentSince(iso) {
    const res = await this.pool.query(
      `SELECT count(*)::int AS n FROM ops.outbound WHERE sent_at >= $1::timestamptz`,
      [iso],
    );
    return res.rows[0].n;
  }

  async upsertBooking(row) {
    await this.pool.query(
      `INSERT INTO ops.bookings (lead_id, slot_start, slot_end, event_id, status, booking_version, updated_at)
       VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, now())
       ON CONFLICT (lead_id) DO UPDATE
         SET slot_start = EXCLUDED.slot_start,
             slot_end = EXCLUDED.slot_end,
             event_id = EXCLUDED.event_id,
             status = EXCLUDED.status,
             booking_version = EXCLUDED.booking_version,
             updated_at = now()`,
      [row.lead_id, row.slot_start, row.slot_end, row.event_id, row.status, row.booking_version || 1],
    );
  }

  async getBooking(leadId) {
    const res = await this.pool.query(`SELECT * FROM ops.bookings WHERE lead_id = $1`, [leadId]);
    return res.rows[0] || null;
  }

  async addClaim({ emailHashValue, portalListingId, leadId }) {
    const res = await this.pool.query(
      `INSERT INTO ops.lead_claims (email_hash, portal_listing_id, lead_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING lead_id`,
      [emailHashValue, portalListingId || '', leadId],
    );
    return res.rowCount > 0;
  }

  async logEvent(event) {
    const meta = redactMeta(event.meta || {}, event.names || []);
    await this.pool.query(
      `INSERT INTO ops.event_log
        (workflow, step, lead_id, message_id_hash, status, event_code, grade, meta, llm_model, tokens_in, tokens_out)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
      [
        event.workflow || '',
        event.step || '',
        event.lead_id || null,
        event.message_id_hash || null,
        event.status || '',
        event.event_code || '',
        event.grade || null,
        JSON.stringify(meta),
        event.llm_model || null,
        event.tokens_in || null,
        event.tokens_out || null,
      ],
    );
  }

  async enqueueCrm(row) {
    await this.pool.query(
      `INSERT INTO ops.crm_outbox (idempotency_key, payload, attempts, status)
       VALUES ($1, $2::jsonb, 1, 'pending')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [row.idempotency_key, JSON.stringify(row.payload || {})],
    );
  }

  async deleteLeadOps(leadId) {
    if (!leadId) return;
    await this.pool.query(`DELETE FROM ops.outbound WHERE lead_id = $1`, [leadId]);
    await this.pool.query(`DELETE FROM ops.bookings WHERE lead_id = $1`, [leadId]);
    await this.pool.query(`DELETE FROM ops.lead_claims WHERE lead_id = $1`, [leadId]);
    await this.pool.query(`DELETE FROM ops.processed_messages WHERE lead_id = $1`, [leadId]);
  }

  async reset() {
    await this.pool.query(`
      TRUNCATE
        ops.processed_messages,
        ops.lead_claims,
        ops.outbound,
        ops.bookings,
        ops.jobs,
        ops.optout,
        ops.event_log,
        ops.crm_outbox,
        ops.lead_counter
    `);
  }
}

function coerceOutbound(row) {
  return {
    ...row,
    offered_slots: typeof row.offered_slots === 'string' ? JSON.parse(row.offered_slots) : row.offered_slots,
    sent_message_id_hash: String(row.sent_message_id_hash || '').trim(),
  };
}

module.exports = { MemoryStore, PgStore, MIGRATION_SQL };
