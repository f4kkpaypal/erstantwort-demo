'use strict';

const { DateTime } = require('luxon');
const { ownerLeadSources } = require('./ownerLead');

const PLACEHOLDER = /^(REPLACE_ME|change-me|changeme)?$/i;

const DEFAULT_SLOT_RULES = Object.freeze({
  days: [1, 7],
  hours: [10, 18],
  len_min: 45,
  buffer_min: 15,
  tz: 'Europe/Berlin',
});

const DEFAULT_MAKLER = Object.freeze({
  name: 'Maria K.',
  buero: 'Erstantwort Demo',
  adresse: 'Johannisstraße 1, 90419 Nürnberg',
  telefon: '+49 911 0000000',
  email: '',
  impressum_url: 'http://127.0.0.1:18791/impressum',
  datenschutz_url: 'http://127.0.0.1:18791/datenschutz',
  telegram_user_id: '',
  digest_email: '',
  from_email: '',
  from_name: 'Maria K.',
  sheet_url: '',
  city: 'Nürnberg',
});

const LIVE_MAKLER = Object.freeze({
  name: '',
  buero: '',
  adresse: '',
  telefon: '',
  email: '',
  impressum_url: '',
  datenschutz_url: '',
  telegram_user_id: '',
  digest_email: '',
  from_email: '',
  from_name: '',
  sheet_url: '',
  city: '',
});

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function int(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function json(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function csv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function senderDomains(value) {
  const list = csv(value);
  return list.length ? list : ['immobilienscout24.de'];
}

const LLM_MODEL_FALLBACKS = Object.freeze([
  'mistral-small-latest',
  'ministral-8b-latest',
]);

function llmModel(env, specificKey) {
  const specific = String(env[specificKey] || '').trim();
  if (specific) return specific;
  const shared = String(env.LLM_MODEL || '').trim();
  if (shared) return shared;
  return LLM_MODEL_FALLBACKS[0];
}

function secretConfigured(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/change-me|replace_me|changeme|dev-only/i.test(text)) return false;
  return true;
}

function officeModeOf(env) {
  return String(env.OFFICE_MODE || '').trim().toLowerCase() === 'live' ? 'live' : 'demo';
}

function productNameOf(env) {
  const name = String(env.PRODUCT_NAME || 'Erstantwort').trim();
  return name || 'Erstantwort';
}

function maklerProfile(env) {
  const live = officeModeOf(env) === 'live';
  const parsed = json(env.MAKLER_PROFILE, {});
  const fromEnv = {};
  if (env.OPERATOR_NAME) {
    fromEnv.name = env.OPERATOR_NAME;
    if (!parsed.from_name) fromEnv.from_name = env.OPERATOR_NAME;
  }
  if (env.OPERATOR_BUERO) fromEnv.buero = env.OPERATOR_BUERO;
  if (env.OPERATOR_ADDRESS) fromEnv.adresse = env.OPERATOR_ADDRESS;
  if (env.OPERATOR_PHONE) fromEnv.telefon = env.OPERATOR_PHONE;
  if (env.OPERATOR_EMAIL) {
    fromEnv.email = env.OPERATOR_EMAIL;
    if (!parsed.from_email) fromEnv.from_email = env.OPERATOR_EMAIL;
  }
  if (env.OPERATOR_CITY) fromEnv.city = env.OPERATOR_CITY;
  return { ...(live ? LIVE_MAKLER : DEFAULT_MAKLER), ...fromEnv, ...parsed };
}

function loadConfig(env = process.env) {
  const slotRules = { ...DEFAULT_SLOT_RULES, ...json(env.SLOT_RULES, {}) };
  if (!slotRules.tz) slotRules.tz = 'Europe/Berlin';
  const makler = maklerProfile(env);
  const sendMode = sendModeOf(env);
  const approvalTimeout = String(env.APPROVAL_TIMEOUT_ACTION || 'remind').trim().toLowerCase();

  return Object.freeze({
    GENERIC_TIMEZONE: env.GENERIC_TIMEZONE || 'Europe/Berlin',
    SEND_MODE: sendMode === 'auto' ? 'auto' : 'approve',
    APPROVAL_TIMEOUT_ACTION: approvalTimeout === 'send_fallback' ? 'send_fallback' : 'remind',
    IMAP_FOLDER: env.IMAP_FOLDER || 'INBOX',
    ALLOWED_SENDER_DOMAINS: senderDomains(env.ALLOWED_SENDER_DOMAINS),
    OWNER_LEAD_SOURCES: Object.freeze(ownerLeadSources(env.OWNER_LEAD_SENDER_DOMAINS)),
    OWNER_LEADS_ENABLED: bool(env.OWNER_LEADS_ENABLED, false),
    PRODUCT_NAME: productNameOf(env),
    OFFICE_SLUG: String(env.OFFICE_SLUG || '').trim().toLowerCase(),
    OFFICE_MODE: officeModeOf(env),
    UI_STORE: String(env.UI_STORE || 'fixture').trim().toLowerCase() === 'sqlite' ? 'sqlite' : 'fixture',
    IMAP_MODE: String(env.IMAP_MODE || 'off').trim().toLowerCase() === 'imap' ? 'imap' : 'off',
    IMAP_POLL_SECONDS: int(env.IMAP_POLL_SECONDS, 60),
    IMAP_SILENCE_MINUTES: int(env.IMAP_SILENCE_MINUTES, 15),
    SHEET_INCLUDE_CONTACT: bool(env.SHEET_INCLUDE_CONTACT, false),
    RETENTION_INTERVAL_HOURS: int(env.RETENTION_INTERVAL_HOURS, 6),
    REQUIRE_DKIM_PASS: bool(env.REQUIRE_DKIM_PASS, false),
    ALLOWED_RECIPIENT_RELAY_DOMAINS: csv(env.ALLOWED_RECIPIENT_RELAY_DOMAINS),
    LLM_BASE_URL: (env.LLM_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, ''),
    LLM_MODEL_EXTRACT: llmModel(env, 'LLM_MODEL_EXTRACT'),
    LLM_MODEL_WRITE: llmModel(env, 'LLM_MODEL_WRITE'),
    LLM_MODEL_FALLBACKS,
    OFFER_ENGLISH_REPLY: bool(env.OFFER_ENGLISH_REPLY, false),
    DEMO_UI_NO_AUTH: bool(env.DEMO_UI_NO_AUTH, false),
    UI_INITDATA_MAX_AGE_S: int(env.UI_INITDATA_MAX_AGE_S, 3600),
    UI_PUBLIC_BASE: (env.UI_PUBLIC_BASE || 'http://127.0.0.1:18791').replace(/\/$/, ''),
    UI_MINUTES_PER_REPLY: int(env.UI_MINUTES_PER_REPLY, 5),
    UI_MINUTES_PER_BOOKING: int(env.UI_MINUTES_PER_BOOKING, 10),
    FRAGEBOGEN_ENABLED: bool(env.FRAGEBOGEN_ENABLED, true),
    FRAGEBOGEN_BUDGET_ENABLED: bool(env.FRAGEBOGEN_BUDGET_ENABLED, false),
    FRAGEBOGEN_INCOME_ENABLED: bool(env.FRAGEBOGEN_INCOME_ENABLED, false),
    FRAGEBOGEN_PERSONS_ENABLED: bool(env.FRAGEBOGEN_PERSONS_ENABLED, false),
    FRAGEBOGEN_SCHUFA_ENABLED: bool(env.FRAGEBOGEN_SCHUFA_ENABLED, false),
    FRAGEBOGEN_EMPLOYMENT_ENABLED: bool(env.FRAGEBOGEN_EMPLOYMENT_ENABLED, false),
    FRAGEBOGEN_LINK_DAYS: int(env.FRAGEBOGEN_LINK_DAYS, 14),
    TELEGRAM_ALLOWED_USER_IDS: String(env.TELEGRAM_ALLOWED_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    LLM_API_KEY: env.MISTRAL_API_KEY || env.LLM_API_KEY || '',
    LLM_MODE: (env.LLM_MODE || 'mock').trim().toLowerCase(),
    LLM_SCHEMA_MODE: (env.LLM_SCHEMA_MODE || 'spec').trim().toLowerCase(),
    SLOT_RULES: Object.freeze(slotRules),
    MAKLER_PROFILE: Object.freeze(makler),
    MAX_REPLIES_PER_HOUR: int(env.MAX_REPLIES_PER_HOUR, 30),
    LLM_DAILY_TOKEN_BUDGET: int(env.LLM_DAILY_TOKEN_BUDGET, 200000),
    FOLLOWUP_AFTER_H: int(env.FOLLOWUP_AFTER_H, 48),
    FOLLOWUP_EMAIL_ENABLED: bool(env.FOLLOWUP_EMAIL_ENABLED, false),
    NOSHOW_REOFFER_ENABLED: bool(env.NOSHOW_REOFFER_ENABLED, false),
    INTERESSE_FOLLOWUP_ENABLED: bool(env.INTERESSE_FOLLOWUP_ENABLED, false),
    MAX_UNSOLICITED_PER_LEAD: int(env.MAX_UNSOLICITED_PER_LEAD, 1),
    REMINDER_BEFORE_H: int(env.REMINDER_BEFORE_H, 24),
    REMINDER_MIN_LEAD_H: int(env.REMINDER_MIN_LEAD_H, 30),
    RETENTION_DAYS_LEAD: int(env.RETENTION_DAYS_LEAD, 180),
    HASH_SALT: env.HASH_SALT || 'dev-only-change-me',
    FIRST_RESPONSE_SLA_SECONDS: int(env.FIRST_RESPONSE_SLA_SECONDS, 300),
    SLA_APPLIES_TO: 'auto',
    PORTAL: 'immoscout24',
    CRM_TARGET: (env.CRM_TARGET || 'sheets').trim().toLowerCase(),
    CRM_MODE: (env.CRM_MODE || 'file').trim().toLowerCase(),
    CALENDAR_MODE: (env.CALENDAR_MODE || 'mock').trim().toLowerCase(),
    MAIL_MODE: (env.MAIL_MODE || 'file').trim().toLowerCase(),
    TELEGRAM_MODE: (env.TELEGRAM_MODE || 'log').trim().toLowerCase(),
    BOT_POLLING: bool(env.BOT_POLLING, false),
    GOOGLE_OAUTH_CLIENT_ID: env.GOOGLE_OAUTH_CLIENT_ID || '',
    GOOGLE_OAUTH_CLIENT_SECRET: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    GOOGLE_OAUTH_REFRESH_TOKEN: env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
    GOOGLE_CALENDAR_ID: env.GOOGLE_CALENDAR_ID || 'primary',
    GOOGLE_SHEET_ID: env.GOOGLE_SHEET_ID || '',
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: String(env.TELEGRAM_CHAT_ID || '').trim(),
    OPS_TELEGRAM_CHAT_ID: String(env.OPS_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '').trim(),
    SMTP_HOST: env.SMTP_HOST || '',
    SMTP_PORT: int(env.SMTP_PORT, 587),
    SMTP_SECURE: (env.SMTP_SECURE || 'starttls').trim().toLowerCase(),
    SMTP_USER: env.SMTP_USER || '',
    SMTP_PASSWORD: env.SMTP_PASSWORD || '',
    IMAP_HOST: env.IMAP_HOST || '',
    IMAP_PORT: int(env.IMAP_PORT, 993),
    IMAP_USER: env.IMAP_USER || '',
    IMAP_PASSWORD: env.IMAP_PASSWORD || '',
    IMAP_SECURE: bool(env.IMAP_SECURE, true),
    LEAD_DOMAIN: (env.LEAD_DOMAIN || '').trim().toLowerCase(),
    MAIL_DOMAIN: (env.MAIL_DOMAIN || '').trim().toLowerCase(),
    ADMIN_TOKEN: env.ADMIN_TOKEN || '',
    ENGINE_TOKEN: env.ENGINE_TOKEN || '',
    DATA_DIR: env.DATA_DIR || 'var',
    DATABASE_URL: env.DATABASE_URL || '',
    ENGINE_PORT: int(env.ENGINE_PORT, 8787),
  });
}

function sendModeOf(env) {
  const raw = env.SEND_MODE;
  const empty = raw === undefined || String(raw).trim() === '';
  const fallback = empty && bool(env.DEMO_UI_NO_AUTH, false) ? 'auto' : 'approve';
  const value = String(empty ? fallback : raw).trim().toLowerCase();
  return value === 'auto' ? 'auto' : 'approve';
}

function listenHost(env = process.env) {
  const value = String(env.HOST ?? '').trim();
  return value || '127.0.0.1';
}

function isPlaceholder(value) {
  return !value || PLACEHOLDER.test(String(value).trim());
}

function berlinNow(clock = () => new Date(), zone = 'Europe/Berlin') {
  return DateTime.fromJSDate(clock(), { zone });
}

module.exports = {
  DEFAULT_SLOT_RULES,
  DEFAULT_MAKLER,
  LIVE_MAKLER,
  loadConfig,
  sendModeOf,
  listenHost,
  isPlaceholder,
  berlinNow,
  bool,
  secretConfigured,
  senderDomains,
  LLM_MODEL_FALLBACKS,
};
