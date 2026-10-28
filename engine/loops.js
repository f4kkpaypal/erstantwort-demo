'use strict';

const { pollOnce } = require('./imap');
const { runRetention } = require('../core/retention');
const { startBotPolling } = require('./telegramPoll');

const ALERT = 'Störung · IMAP ohne erfolgreiche Prüfung. Keine Personendaten in dieser Meldung.';

function opsAlert(config) {
  const slug = String(config?.OFFICE_SLUG || '');
  const office = /^[a-z0-9-]{1,32}$/.test(slug) ? ` Büro ${slug}.` : '';
  return `Störung · IMAP ohne erfolgreiche Prüfung.${office} Keine Personendaten in dieser Meldung.`;
}

function silenceDue({ imapLastOk, imapStartedAt, silenceMs, now }) {
  const stamp = imapLastOk || imapStartedAt;
  if (!stamp) return false;
  const age = now - Date.parse(stamp);
  return Number.isFinite(age) && age > silenceMs;
}

function startLoops(deps) {
  const hours = Number(deps.config.RETENTION_INTERVAL_HOURS) || 6;
  const retain = () => {
    runRetention(deps).catch(() => {});
  };
  retain();
  const retentionTimer = setInterval(retain, hours * 60 * 60 * 1000);
  retentionTimer.unref?.();
  startBotPolling(deps);
  if (deps.config.IMAP_MODE !== 'imap') return;
  deps.imapStartedAt = new Date().toISOString();
  let alerted = false;
  const silenceMs = (Number(deps.config.IMAP_SILENCE_MINUTES) || 15) * 60 * 1000;
  const tick = async () => {
    try {
      await pollOnce(deps);
      alerted = false;
    } catch (err) {
      deps.imapLastError = err?.code || 'imap_failed';
    }
    if (silenceDue({
      imapLastOk: deps.imapLastOk,
      imapStartedAt: deps.imapStartedAt,
      silenceMs,
      now: Date.now(),
    }) && !alerted) {
      alerted = true;
      const text = opsAlert(deps.config);
      const send = deps.telegram?.sendOps || deps.telegram?.send;
      if (send) send.call(deps.telegram, text).catch(() => {});
    }
  };
  tick().catch(() => {});
  const imapTimer = setInterval(() => {
    tick().catch(() => {});
  }, Math.max(15, Number(deps.config.IMAP_POLL_SECONDS) || 60) * 1000);
  imapTimer.unref?.();
}

module.exports = { startLoops, ALERT, opsAlert, silenceDue };
