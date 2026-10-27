-- Operational store for Anfragen-Autopilot. No message bodies.
-- lead_counter is the helper that issues L-YYYYMMDD-NNNN. It is not a spec table.

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.processed_messages (
  message_id_hash CHAR(64) PRIMARY KEY,
  content_hash CHAR(64) NOT NULL,
  lead_id TEXT,
  outcome TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ops.lead_claims (
  email_hash CHAR(64),
  portal_listing_id TEXT,
  lead_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (email_hash, portal_listing_id)
);

CREATE TABLE IF NOT EXISTS ops.outbound (
  sent_message_id_hash CHAR(64) PRIMARY KEY,
  lead_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  offered_slots JSONB,
  sent_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.bookings (
  lead_id TEXT PRIMARY KEY,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  booking_version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.jobs (
  lead_id TEXT,
  kind TEXT,
  booking_version INT,
  status TEXT NOT NULL DEFAULT 'claimed',
  claimed_at TIMESTAMPTZ DEFAULT now(),
  done_at TIMESTAMPTZ,
  PRIMARY KEY (lead_id, kind, booking_version)
);

CREATE TABLE IF NOT EXISTS ops.optout (
  email_hash CHAR(64) PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.funnel_daily (
  day DATE,
  portal_listing_id TEXT,
  metric TEXT,
  value NUMERIC,
  PRIMARY KEY (day, portal_listing_id, metric)
);

CREATE TABLE IF NOT EXISTS ops.event_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  execution_id TEXT,
  workflow TEXT,
  step TEXT,
  lead_id TEXT,
  message_id_hash CHAR(64),
  status TEXT,
  event_code TEXT,
  duration_ms INT,
  llm_model TEXT,
  tokens_in INT,
  tokens_out INT,
  grade TEXT,
  meta JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS ops.crm_outbox (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  payload JSONB,
  attempts INT DEFAULT 0,
  next_try_at TIMESTAMPTZ,
  status TEXT
);

CREATE TABLE IF NOT EXISTS ops.lead_counter (
  day DATE PRIMARY KEY,
  n INT NOT NULL
);
