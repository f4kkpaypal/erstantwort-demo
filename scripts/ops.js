'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function copyIf(src, destDir) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  return true;
}

function pgPlan(env) {
  const password = String(env.POSTGRES_PASSWORD || '');
  const placeholder = !password || /change-me|replace_me|changeme/i.test(password);
  return {
    user: env.POSTGRES_USER || 'n8n',
    databases: ['n8n', 'makler'],
    ready: !placeholder,
  };
}

function dumpPostgres(dest, env, run = execFileSync) {
  const plan = pgPlan(env);
  if (!plan.ready) return { status: 'skipped', files: [] };
  const files = [];
  try {
    for (const db of plan.databases) {
      const out = run('docker', [
        'compose', 'exec', '-T', 'postgres',
        'pg_dump', '-U', plan.user, '--no-password', db,
      ], { encoding: 'utf8', timeout: 120000 });
      if (!out || !/PostgreSQL database dump|CREATE /.test(out)) return { status: 'failed', files };
      if (String(env.POSTGRES_PASSWORD || '').length > 6 && out.includes(env.POSTGRES_PASSWORD)) {
        return { status: 'failed', files };
      }
      fs.writeFileSync(path.join(dest, `${db}.sql`), out);
      files.push(`${db}.sql`);
    }
    return { status: 'ok', files };
  } catch {
    return { status: 'skipped', files };
  }
}

function backup(env = process.env) {
  const dataDir = env.DATA_DIR || 'var';
  const backupRoot = path.join(dataDir, 'backups');
  const dest = path.join(backupRoot, stamp());
  fs.mkdirSync(dest, { recursive: true });
  const names = ['autopilot.sqlite', 'fragebogen.json', 'calendar.json', 'objekte.json'];
  const copied = [];
  for (const name of names) {
    if (copyIf(path.join(dataDir, name), dest)) copied.push(name);
  }
  const leads = path.join(dataDir, 'crm', 'leads.json');
  if (fs.existsSync(leads)) {
    fs.mkdirSync(path.join(dest, 'crm'), { recursive: true });
    fs.copyFileSync(leads, path.join(dest, 'crm', 'leads.json'));
    copied.push('crm/leads.json');
  }
  const postgres = dumpPostgres(dest, env);
  for (const file of postgres.files) copied.push(file);
  if (!copied.length) return { ok: false, code: 'backup_empty' };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({
    created_at: new Date().toISOString(),
    files: copied,
    postgres: postgres.status,
  }, null, 2));
  return { ok: true, dest, postgres: postgres.status, files: copied };
}

function latestBackup(env = process.env) {
  const backupRoot = path.join(env.DATA_DIR || 'var', 'backups');
  if (!fs.existsSync(backupRoot)) return '';
  const dirs = fs.readdirSync(backupRoot)
    .map((name) => path.join(backupRoot, name))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .sort();
  return dirs.at(-1) || '';
}

function sqlLooksSafe(file, env) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return false;
  const password = String(env.POSTGRES_PASSWORD || '');
  if (password.length > 6 && text.includes(password)) return false;
  return /PostgreSQL database dump|CREATE |COPY /.test(text);
}

function restoreCheck(env = process.env) {
  const src = latestBackup(env);
  if (!src) return { ok: false, code: 'backup_missing' };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'erstantwort-restore-'));
  try {
    const dbSrc = path.join(src, 'autopilot.sqlite');
    if (!fs.existsSync(dbSrc)) return { ok: false, code: 'backup_without_sqlite' };
    const dbFile = path.join(temp, 'autopilot.sqlite');
    fs.copyFileSync(dbSrc, dbFile);
    const db = new DatabaseSync(dbFile);
    const check = db.prepare('PRAGMA integrity_check').get();
    const leads = db.prepare('SELECT count(*) AS n FROM ui_leads').get();
    const optouts = db.prepare('SELECT count(*) AS n FROM optout').get();
    db.close();
    const integrity = String(check.integrity_check || check['integrity_check'] || '');
    if (integrity !== 'ok') return { ok: false, code: 'restore_check_failed' };
    let crm = 0;
    const leadsFile = path.join(src, 'crm', 'leads.json');
    if (fs.existsSync(leadsFile)) {
      const rows = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
      if (!Array.isArray(rows)) return { ok: false, code: 'restore_check_failed' };
      crm = rows.length;
    }
    let postgres = 'absent';
    const dumps = ['n8n.sql', 'makler.sql'].filter((name) => fs.existsSync(path.join(src, name)));
    if (dumps.length) {
      const safe = dumps.every((name) => sqlLooksSafe(path.join(src, name), env));
      if (!safe || dumps.length !== 2) return { ok: false, code: 'restore_check_failed' };
      postgres = 'ok';
    }
    return {
      ok: true,
      line: `restore_check_ok leads=${leads.n} optout=${optouts.n} crm_rows=${crm} postgres=${postgres}`,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'backup') {
    const result = backup();
    if (!result.ok) {
      console.error(result.code);
      process.exit(1);
    }
    console.log(`backup_ok ${result.dest} postgres=${result.postgres}`);
    return;
  }
  if (cmd === 'restore-check') {
    const result = restoreCheck();
    if (!result.ok) {
      console.error(result.code);
      process.exit(1);
    }
    console.log(result.line);
    return;
  }
  console.error('usage: node scripts/ops.js backup|restore-check');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { backup, restoreCheck, pgPlan, dumpPostgres };
