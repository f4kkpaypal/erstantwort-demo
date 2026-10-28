'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');

const base = {
  PRODUCT_MODE: 'intl',
  CHANNEL_MODE: 'sim',
  REAL_DATA_ALLOWED: 'false',
  LLM_MODE: 'mock',
  TELEGRAM_MODE: 'log',
  MAIL_MODE: 'file',
  DEMO_UI_NO_AUTH: 'false',
  BROKER_TZ: 'Asia/Dubai',
  DIGEST_TIME: '08:30',
  TRUST_PROXY: '1',
  AED_PER_USD: '3.6725',
  LLM_DAILY_TOKEN_BUDGET: '200000',
  LLM_TIMEOUT_MS: '5000',
  EPHEMERAL_DISK: 'true',
  HOST: '0.0.0.0',
  INTL_PORT: process.env.PORT || '8791',
};

function secret(name) {
  return process.env[name] || crypto.randomBytes(24).toString('hex');
}

// HASH_SALT has to stay the same for this deployment. A fresh salt makes every
// saved opt-out hash unreadable after a restart. Set it in the host environment.
// Render Free also wipes the disk when the service sleeps, so the opt-out rows
// themselves disappear there even when the salt does not. That host is not a
// place to keep real opt-outs.
if (!process.env.HASH_SALT) {
  console.error('hash_salt_missing');
  process.exit(1);
}

const env = {
  ...process.env,
  ...base,
  TG_TEST_LEAD_IDS: process.env.TG_TEST_LEAD_IDS || '',
  TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  HASH_SALT: process.env.HASH_SALT,
  ENGINE_TOKEN: secret('ENGINE_TOKEN'),
};

if (String(env.REAL_DATA_ALLOWED).toLowerCase() === 'true') {
  console.error('real_data_blocked');
  process.exit(1);
}

const child = spawn(process.execPath, ['engine/intlServer.js'], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
