'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, secretConfigured } = require('../core/config');

const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const SECRET_KEYS = [
  'IMAP_PASSWORD', 'SMTP_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'ENGINE_TOKEN', 'HASH_SALT',
  'MISTRAL_API_KEY', 'LLM_API_KEY', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN',
  'POSTGRES_PASSWORD', 'N8N_ENCRYPTION_KEY', 'ADMIN_TOKEN',
];

function bureausRoot() {
  return process.env.BUREAUS_DIR || path.join(process.cwd(), 'bureaus');
}

function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, eq).trim()] = value;
  }
  return env;
}

function officeDir(slug) {
  return path.join(bureausRoot(), slug);
}

function readOfficeEnv(slug) {
  const file = path.join(officeDir(slug), '.env');
  if (!fs.existsSync(file)) return null;
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

function nextPorts(root) {
  let engine = 18810;
  let web = 18910;
  if (!fs.existsSync(root)) return { engine, web };
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name, '.env');
    if (!fs.existsSync(file)) continue;
    const env = parseEnv(fs.readFileSync(file, 'utf8'));
    const enginePort = Number(env.ENGINE_PORT || 0);
    const webPort = Number(env.WEB_PORT || 0);
    if (enginePort >= engine) engine = enginePort + 1;
    if (webPort >= web) web = webPort + 1;
  }
  return { engine, web };
}

function template(slug, ports) {
  const dir = officeDir(slug);
  const token = crypto.randomBytes(24).toString('hex');
  const salt = crypto.randomBytes(24).toString('hex');
  return [
    '# Отдельное бюро. Секреты только в этом файле. Каталог data/ в git не входит.',
    `OFFICE_SLUG=${slug}`,
    'OFFICE_MODE=demo',
    'PRODUCT_NAME=Erstantwort',
    'UI_STORE=sqlite',
    `DATA_DIR=${path.join(dir, 'data')}`,
    `ENGINE_PORT=${ports.engine}`,
    `WEB_PORT=${ports.web}`,
    `ENGINE_PUBLISH_PORT=${ports.engine}`,
    `WEB_PUBLISH_PORT=${ports.web}`,
    `COMPOSE_PROJECT_NAME=erstantwort-${slug}`,
    'SEND_MODE=approve',
    'DEMO_UI_NO_AUTH=true',
    'MAIL_MODE=file',
    'IMAP_MODE=off',
    'LLM_MODE=mock',
    'CRM_MODE=file',
    'CALENDAR_MODE=mock',
    'TELEGRAM_MODE=log',
    'BOT_POLLING=false',
    'OWNER_LEADS_ENABLED=false',
    'SHEET_INCLUDE_CONTACT=false',
    `ENGINE_TOKEN=${token}`,
    `HASH_SALT=${salt}`,
    'OPERATOR_NAME=',
    'OPERATOR_BUERO=',
    'OPERATOR_ADDRESS=',
    'OPERATOR_EMAIL=',
    'OPERATOR_PHONE=',
    'OPERATOR_CITY=',
    'IMAP_HOST=',
    'IMAP_USER=',
    'IMAP_PASSWORD=',
    'SMTP_HOST=',
    'SMTP_USER=',
    'SMTP_PASSWORD=',
    'TELEGRAM_BOT_TOKEN=',
    'TELEGRAM_ALLOWED_USER_IDS=',
    'OPS_TELEGRAM_CHAT_ID=',
    '',
  ].join('\n');
}

function init(slug) {
  if (!SLUG.test(slug)) return { ok: false, code: 'bad_slug' };
  const dir = officeDir(slug);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) {
    const ports = nextPorts(bureausRoot());
    fs.writeFileSync(envFile, template(slug, ports), { mode: 0o600 });
  }
  return { ok: true, slug, env: envFile };
}

function takenPorts(slug) {
  const used = new Set();
  const root = bureausRoot();
  if (!fs.existsSync(root)) return used;
  for (const name of fs.readdirSync(root)) {
    if (name === slug) continue;
    const file = path.join(root, name, '.env');
    if (!fs.existsSync(file)) continue;
    const env = parseEnv(fs.readFileSync(file, 'utf8'));
    if (env.ENGINE_PORT) used.add(`engine:${env.ENGINE_PORT}`);
    if (env.WEB_PORT) used.add(`web:${env.WEB_PORT}`);
  }
  return used;
}

function check(slug) {
  if (!SLUG.test(slug || '')) return { ok: false, code: 'bad_slug', missing: [] };
  const raw = readOfficeEnv(slug);
  if (!raw) return { ok: false, code: 'env_missing', missing: ['.env'] };
  const config = loadConfig(raw);
  const missing = [];
  const dataDir = path.resolve(raw.DATA_DIR || '');
  const expected = path.join(officeDir(slug), 'data');
  if (dataDir !== expected) missing.push('DATA_DIR');
  if (config.UI_STORE !== 'sqlite') missing.push('UI_STORE');
  if (!secretConfigured(raw.ENGINE_TOKEN)) missing.push('ENGINE_TOKEN');
  if (!secretConfigured(raw.HASH_SALT)) missing.push('HASH_SALT');
  if (config.OFFICE_SLUG !== slug) missing.push('OFFICE_SLUG');
  const enginePort = Number(raw.ENGINE_PORT || 0);
  const webPort = Number(raw.WEB_PORT || 0);
  if (!enginePort || !webPort || enginePort === webPort) missing.push('PORTS');
  const used = takenPorts(slug);
  if (used.has(`engine:${enginePort}`) || used.has(`web:${webPort}`)) missing.push('PORTS');
  if (config.DEMO_UI_NO_AUTH && (config.MAIL_MODE === 'smtp' || config.TELEGRAM_MODE === 'telegram')) {
    missing.push('DEMO_UI_NO_AUTH');
  }
  if (config.OFFICE_MODE === 'live') {
    if (!config.MAKLER_PROFILE.name) missing.push('OPERATOR_NAME');
    if (!config.MAKLER_PROFILE.adresse) missing.push('OPERATOR_ADDRESS');
    if (!(config.MAKLER_PROFILE.email || config.MAKLER_PROFILE.from_email)) missing.push('OPERATOR_EMAIL');
  }
  if (config.IMAP_MODE === 'imap') {
    if (!raw.IMAP_HOST) missing.push('IMAP_HOST');
    if (!raw.IMAP_USER) missing.push('IMAP_USER');
    if (!raw.IMAP_PASSWORD) missing.push('IMAP_PASSWORD');
  }
  if (config.MAIL_MODE === 'smtp') {
    if (!raw.SMTP_HOST) missing.push('SMTP_HOST');
    if (!raw.SMTP_USER) missing.push('SMTP_USER');
    if (!raw.SMTP_PASSWORD) missing.push('SMTP_PASSWORD');
  }
  const unique = [...new Set(missing)];
  if (unique.length) return { ok: false, code: 'office_check_failed', missing: unique, slug };
  return {
    ok: true,
    code: 'office_check_ok',
    slug,
    enginePort,
    webPort,
    store: config.UI_STORE,
    officeMode: config.OFFICE_MODE,
    ownerLeads: config.OWNER_LEADS_ENABLED === true,
  };
}

function publicLine(result) {
  if (!result.ok) return `${result.code} missing=${(result.missing || []).join(',')}`;
  return `office_check_ok slug=${result.slug} ports=${result.enginePort},${result.webPort} store=${result.store} mode=${result.officeMode} owner_leads=${result.ownerLeads}`;
}

function composeCommand(slug) {
  const envFile = path.join('bureaus', slug, '.env');
  return `docker compose --project-name erstantwort-${slug} --env-file ${envFile} -f docker-compose.prod.yml up -d --build`;
}

function assertClean(text, raw) {
  if (!raw) return;
  for (const key of SECRET_KEYS) {
    const value = raw[key];
    if (value && value.length > 6 && text.includes(value)) {
      throw new Error('secret_in_output');
    }
  }
}

function run(slug, role) {
  const checked = check(slug);
  if (!checked.ok) return checked;
  const raw = readOfficeEnv(slug);
  const script = role === 'web' ? 'web/server.js' : 'engine/server.js';
  const env = { ...process.env, ...raw };
  if (role === 'web') env.ENGINE_URL = `http://127.0.0.1:${raw.ENGINE_PORT}`;
  const child = spawn(process.execPath, [path.join(process.cwd(), script)], {
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code || 0));
  return { ok: true, code: 'office_started', slug, role };
}

function main() {
  const [cmd, slug, extra] = process.argv.slice(2);
  if (cmd === 'init') {
    const result = init(slug);
    if (!result.ok) {
      console.error(result.code);
      process.exit(1);
    }
    console.log(`office_init_ok slug=${result.slug}`);
    return;
  }
  if (cmd === 'check') {
    const result = check(slug);
    const line = publicLine(result);
    assertClean(line, readOfficeEnv(slug));
    if (!result.ok) {
      console.error(line);
      process.exit(1);
    }
    console.log(line);
    return;
  }
  if (cmd === 'compose') {
    if (!SLUG.test(slug || '')) {
      console.error('bad_slug');
      process.exit(1);
    }
    const line = composeCommand(slug);
    assertClean(line, readOfficeEnv(slug));
    console.log(line);
    return;
  }
  if (cmd === 'run') {
    const result = run(slug, extra === 'web' ? 'web' : 'engine');
    if (!result.ok) {
      console.error(publicLine(result));
      process.exit(1);
    }
    return;
  }
  console.error('usage: node scripts/office.js init|check|compose|run <slug> [engine|web]');
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  parseEnv, init, check, publicLine, composeCommand, SLUG, SECRET_KEYS,
};
