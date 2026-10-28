'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS i_property (
  id TEXT PRIMARY KEY, title TEXT, kind TEXT, price INTEGER, currency TEXT, price_period TEXT,
  tz TEXT, tz_label_en TEXT, tz_label_ru TEXT, area_value INTEGER, area_unit TEXT,
  ref_en TEXT, ref_ru TEXT, price_en TEXT, price_ru TEXT, facts TEXT, active INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_slot (
  id TEXT PRIMARY KEY, property_id TEXT, start_utc TEXT, duration_min INTEGER, status TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_lead (
  id TEXT PRIMARY KEY, channel TEXT, sender_hash TEXT, sender_name TEXT, reply_target TEXT, property_id TEXT,
  language TEXT, intent TEXT, also_json TEXT, asks_discount INTEGER, budget_amount INTEGER, budget_currency TEXT,
  budget_period TEXT, timing_class TEXT, timing_label TEXT, cash INTEGER, flags TEXT, non_text_type TEXT,
  score INTEGER, grade TEXT, reasons TEXT, analysis_source TEXT, status TEXT, pipeline TEXT, optout INTEGER DEFAULT 0,
  first_msg_at TEXT, last_msg_at TEXT, last_inbound_message_id TEXT, retention_until TEXT, business_connection_id TEXT,
  clean_name TEXT, UNIQUE(channel, sender_hash, property_id)
);
CREATE TABLE IF NOT EXISTS i_message (
  id TEXT PRIMARY KEY, lead_id TEXT, direction TEXT, text TEXT, kind TEXT, channel_msg_id TEXT,
  dedup_key TEXT UNIQUE, option_id TEXT, edited INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_draft (
  lead_id TEXT PRIMARY KEY, option_id TEXT, text TEXT, slot_ids TEXT, edited INTEGER, version INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS i_send (
  send_id TEXT PRIMARY KEY, lead_id TEXT, reply_to_message_id TEXT, draft_hash TEXT, manual INTEGER,
  idempotency_key TEXT UNIQUE, status TEXT, fail_reason TEXT, channel TEXT, response TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(lead_id, reply_to_message_id, draft_hash)
);
CREATE TABLE IF NOT EXISTS i_idem (key TEXT PRIMARY KEY, route TEXT, response TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS i_viewing (
  id TEXT PRIMARY KEY, lead_id TEXT, property_id TEXT, slot_id TEXT, start_utc TEXT, status TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_optout (channel TEXT, sender_hash TEXT, created_at TEXT, PRIMARY KEY(channel, sender_hash));
CREATE TABLE IF NOT EXISTS i_tg_conn (
  business_connection_id TEXT PRIMARY KEY, can_reply INTEGER, is_enabled INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS i_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, lead_id TEXT, meta TEXT
);
CREATE TABLE IF NOT EXISTS i_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS i_tg_update (update_id INTEGER PRIMARY KEY);
`;

class IntlStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  run(sql, params = []) { return this.db.prepare(sql).run(...params); }
  one(sql, params = []) { return this.db.prepare(sql).get(...params) || null; }
  all(sql, params = []) { return this.db.prepare(sql).all(...params); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* the transaction is already closed */ }
      throw err;
    }
  }
  close() { this.db.close(); }
}

module.exports = { IntlStore, SCHEMA };
