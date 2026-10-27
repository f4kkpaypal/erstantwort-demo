'use strict';
// Single-container launcher for free-hosting demo tests (Render/Railway/etc.).
// Starts engine on loopback and web on the public $PORT. Demo only: fictional data,
// mail goes to files, LLM is a mock, auth stays ON. No secrets are logged.
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const engineUrl = 'http://127.0.0.1:18788';
const publicPort = process.env.PORT || '10000';
const publicBase = (process.env.UI_PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${publicPort}`).replace(/\/$/, '');
const token = process.env.TELEGRAM_BOT_TOKEN || '';
const allowed = process.env.TELEGRAM_ALLOWED_USER_IDS || '5031998736';
const rand = () => crypto.randomBytes(24).toString('hex');

const base = {
  PATH: process.env.PATH,
  HOME: process.env.HOME || os.tmpdir(),
  TZ: 'Europe/Berlin',
  NODE_ENV: 'production',
  DEMO_UI_NO_AUTH: 'false',
  TELEGRAM_ALLOWED_USER_IDS: allowed,
  MAIL_MODE: 'file',
  LLM_MODE: 'mock',
  CRM_MODE: 'file',
  CALENDAR_MODE: 'mock',
  OFFICE_MODE: 'demo',
  IMAP_MODE: 'off',
  UI_PUBLIC_BASE: publicBase,
  ENGINE_TOKEN: rand(),
  HASH_SALT: rand(),
  ENGINE_PORT: '18788',
  DATA_DIR: path.join(os.tmpdir(), 'erstantwort-demo'),
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_MODE: token ? 'telegram' : 'log',
  BOT_POLLING: token ? 'true' : 'false',
};

const kids = [];
function run(name, file, env) {
  const child = spawn(process.execPath, [file], { cwd: root, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.error(`${name}_exited code=${code}`);
    kids.forEach((k) => k.kill());
    process.exit(code || 1);
  });
  kids.push(child);
}

run('engine', 'engine/server.js', { ...base, HOST: '127.0.0.1' });
setTimeout(() => {
  run('web', 'web/server.js', { ...base, HOST: '0.0.0.0', ENGINE_URL: engineUrl, WEB_PORT: publicPort });
}, 1500);
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => { kids.forEach((k) => k.kill()); process.exit(0); }));
