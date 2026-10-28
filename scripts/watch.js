'use strict';

const fs = require('fs');
const path = require('path');

const SAFE_DETAIL = /^(health|unreachable|imap_silent|web|http_\d{3})$/;

function safeDetail(detail) {
  const text = String(detail || '');
  return SAFE_DETAIL.test(text) ? text : 'health';
}

function alertText(detail, env = process.env) {
  const slug = String(env.OFFICE_SLUG || '');
  const office = /^[a-z0-9-]{1,32}$/.test(slug) ? ` Büro ${slug}.` : '';
  return `Störung · Gesundheitsprüfung fehlgeschlagen.${office} ${safeDetail(detail)}. Keine Personendaten in dieser Meldung.`;
}

function shouldNotifyTelegram(env) {
  const token = env.TELEGRAM_BOT_TOKEN || '';
  const chat = env.OPS_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '';
  if (env.TELEGRAM_MODE !== 'telegram') return false;
  if (!token || !chat) return false;
  if (/change-me|replace_me/i.test(token)) return false;
  return true;
}

async function checkOnce(env = process.env, fetchImpl = fetch) {
  const url = env.HEALTH_URL || 'http://127.0.0.1:8787/v1/health';
  const silenceMin = Number(env.IMAP_SILENCE_MINUTES || 15);
  let failed = false;
  let detail = 'health';
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      failed = true;
      detail = `http_${res.status}`;
    } else {
      const body = await res.json();
      if (body.imap_mode === 'imap') {
        const last = Date.parse(body.imap_last_ok || '');
        if (!Number.isFinite(last) || Date.now() - last > silenceMin * 60 * 1000) {
          failed = true;
          detail = 'imap_silent';
        }
      }
    }
  } catch {
    failed = true;
    detail = 'unreachable';
  }
  if (env.WEB_HEALTH_URL && !failed) {
    try {
      const web = await fetchImpl(env.WEB_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      if (!web.ok) {
        failed = true;
        detail = 'web';
      }
    } catch {
      failed = true;
      detail = 'web';
    }
  }
  if (!failed) return { ok: true, detail: 'health' };
  const text = alertText(detail, env);
  const dir = env.DATA_DIR || 'var';
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'health-alert.log'), `${new Date().toISOString()} ${text}\n`);
  if (shouldNotifyTelegram(env)) {
    const chat = env.OPS_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
    await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
  return { ok: false, detail: safeDetail(detail), text };
}

async function main() {
  const result = await checkOnce();
  if (result.ok) console.log('health_ok');
  else console.error(`health_alert ${result.detail}`);
  if (process.env.WATCH_LOOP === '1') {
    const wait = Math.max(30, Number(process.env.WATCH_INTERVAL_SECONDS || 300)) * 1000;
    setTimeout(main, wait);
    return;
  }
  if (!result.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { alertText, safeDetail, shouldNotifyTelegram, checkOnce };
