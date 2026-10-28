'use strict';

const { DateTime } = require('luxon');

function dayStartIso(now, zone) {
  const date = now instanceof Date ? now : new Date(now);
  return DateTime.fromJSDate(date, { zone: zone || 'Europe/Berlin' }).startOf('day').toUTC().toISO();
}

async function withinTokenBudget(deps) {
  const raw = Number(deps.config?.LLM_DAILY_TOKEN_BUDGET);
  if (!Number.isFinite(raw)) return { ok: true, budget: null, used: 0 };
  const budget = Math.max(0, raw);
  const zone = deps.config?.GENERIC_TIMEZONE || 'Europe/Berlin';
  const now = deps.clock ? deps.clock() : new Date();
  const since = dayStartIso(now, zone);
  const used = deps.db?.sumTokensSince ? Number(await deps.db.sumTokensSince(since)) || 0 : 0;
  return { ok: used < budget, budget, used, since };
}

module.exports = { dayStartIso, withinTokenBudget };
