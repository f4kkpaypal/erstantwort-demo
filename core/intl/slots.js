'use strict';

const { DateTime } = require('luxon');
const { slotPhrase } = require('./options');

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function listFreeSlots(store, property, now) {
  const rows = store.all(
    `SELECT * FROM i_slot WHERE property_id = ? AND status = 'free' ORDER BY start_utc`,
    [property.id],
  );
  const confirmed = new Set(store.all(
    `SELECT slot_id FROM i_viewing WHERE property_id = ? AND status = 'confirmed'`,
    [property.id],
  ).map((row) => row.slot_id));
  return rows.filter((row) => {
    if (confirmed.has(row.id)) return false;
    return Date.parse(row.start_utc) > now.getTime();
  }).slice(0, 5).map((row) => ({
    ...row,
    label_en: slotPhrase(row, property, 'en').when,
    label_ru: slotPhrase(row, property, 'ru').when,
    proposal_en: `${slotPhrase(row, property, 'en').when}. ${slotPhrase(row, property, 'en').note}`,
    proposal_ru: `${slotPhrase(row, property, 'ru').when}. ${slotPhrase(row, property, 'ru').note}`,
  }));
}

function assertSlot(store, property, startUtc, durationMin, now) {
  const start = DateTime.fromISO(startUtc, { setZone: true });
  if (!start.isValid || start.toMillis() <= now.getTime()) {
    return { ok: false, error_code: 'slot_in_past' };
  }
  const count = store.one(
    `SELECT COUNT(*) AS n FROM i_slot WHERE property_id = ? AND status = 'free'`,
    [property.id],
  ).n;
  if (count >= 5) return { ok: false, error_code: 'slot_limit' };
  const end = start.plus({ minutes: durationMin || 45 });
  const rows = store.all(`SELECT * FROM i_slot WHERE property_id = ? AND status != 'removed'`, [property.id]);
  for (const row of rows) {
    const otherStart = DateTime.fromISO(row.start_utc, { setZone: true });
    const otherEnd = otherStart.plus({ minutes: row.duration_min || 45 });
    if (overlaps(start, end, otherStart, otherEnd)) return { ok: false, error_code: 'slot_overlap' };
  }
  return { ok: true, start: start.toUTC().toISO(), end: end.toUTC().toISO() };
}

module.exports = { listFreeSlots, assertSlot };
