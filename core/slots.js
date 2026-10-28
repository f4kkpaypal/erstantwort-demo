'use strict';

const { DateTime } = require('luxon');

const WEEKDAY_SHORT = { 1: 'Mo.', 2: 'Di.', 3: 'Mi.', 4: 'Do.', 5: 'Fr.', 6: 'Sa.', 7: 'So.' };
const WEEKDAY_LONG = {
  1: 'Montag', 2: 'Dienstag', 3: 'Mittwoch', 4: 'Donnerstag', 5: 'Freitag', 6: 'Samstag', 7: 'Sonntag',
};
const PREFERRED_HOURS = [16, 11, 14, 10, 15, 12, 13, 17];

function inZone(value, zone) {
  if (DateTime.isDateTime(value)) return value.setZone(zone);
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  return DateTime.fromISO(String(value), { zone });
}

function formatSlotShort(value, zone = 'Europe/Berlin') {
  const dt = inZone(value, zone);
  return `${WEEKDAY_SHORT[dt.weekday]}, ${dt.toFormat('dd.MM.')}, ${dt.toFormat('HH:mm')} Uhr`;
}

function formatSlotLong(value, zone = 'Europe/Berlin') {
  const dt = inZone(value, zone);
  return `${WEEKDAY_LONG[dt.weekday]}, ${dt.toFormat('dd.MM.yyyy')}, ${dt.toFormat('HH:mm')} Uhr`;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function slotConflicts(start, end, busy, bufferMin, zone) {
  for (const block of busy || []) {
    const bs = inZone(block.start, zone).minus({ minutes: bufferMin });
    const be = inZone(block.end, zone).plus({ minutes: bufferMin });
    if (!bs.isValid || !be.isValid) continue;
    if (intervalsOverlap(start, end, bs, be)) return true;
  }
  return false;
}

function toSlot(start, end, zone) {
  return {
    start: start.toISO(),
    end: end.toISO(),
    label: formatSlotShort(start, zone),
    label_long: formatSlotLong(start, zone),
  };
}

function pickSlots({ now, busy = [], rules, count = 3 }) {
  const zone = rules.tz || 'Europe/Berlin';
  const len = rules.len_min || 45;
  const buffer = rules.buffer_min ?? 15;
  const [dayFrom, dayTo] = rules.days || [1, 7];
  const [hourFrom, hourTo] = rules.hours || [10, 18];
  const base = inZone(now, zone).startOf('day');
  const first = base.plus({ days: dayFrom });
  const last = base.plus({ days: dayTo });
  const slots = [];
  const used = [];

  function consider(day, hour, allowSameDayExtra) {
    if (day.weekday > 5) return false;
    if (!allowSameDayExtra && used.some((u) => u.hasSame(day, 'day'))) return false;
    if (hour < hourFrom) return false;
    const start = day.set({ hour, minute: 0, second: 0, millisecond: 0 });
    const end = start.plus({ minutes: len });
    const close = day.set({ hour: hourTo, minute: 0, second: 0, millisecond: 0 });
    if (end > close) return false;
    if (slotConflicts(start, end, busy, buffer, zone)) return false;
    if (slotConflicts(start, end, used.map((u) => ({ start: u.toISO(), end: u.plus({ minutes: len }).toISO() })), buffer, zone)) {
      return false;
    }
    slots.push(toSlot(start, end, zone));
    used.push(start);
    return true;
  }

  for (let day = first; day <= last && slots.length < count; day = day.plus({ days: 1 })) {
    for (const hour of PREFERRED_HOURS) {
      if (consider(day, hour, false)) break;
    }
  }
  if (slots.length < count) {
    for (let day = first; day <= last && slots.length < count; day = day.plus({ days: 1 })) {
      for (const hour of PREFERRED_HOURS) {
        if (slots.length >= count) break;
        consider(day, hour, true);
      }
    }
  }
  return slots.slice(0, count);
}

module.exports = {
  pickSlots,
  formatSlotShort,
  formatSlotLong,
  slotConflicts,
  WEEKDAY_SHORT,
};
