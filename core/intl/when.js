'use strict';

const { DateTime } = require('luxon');

// Longer names first so "thursday" wins over "thu" and "четверг" over "чт".
const WEEKDAYS = [
  ['понедельник', 1],
  ['вторник', 2],
  ['воскресенье', 7],
  ['воскресенья', 7],
  ['субботу', 6],
  ['суббота', 6],
  ['пятницу', 5],
  ['пятница', 5],
  ['четверг', 4],
  ['среду', 3],
  ['среда', 3],
  ['wednesday', 3],
  ['thursday', 4],
  ['saturday', 6],
  ['tuesday', 2],
  ['monday', 1],
  ['friday', 5],
  ['sunday', 7],
  ['thurs', 4],
  ['thur', 4],
  ['tues', 2],
  ['пн', 1],
  ['вт', 2],
  ['ср', 3],
  ['чт', 4],
  ['пт', 5],
  ['сб', 6],
  ['вс', 7],
  ['mon', 1],
  ['tue', 2],
  ['wed', 3],
  ['thu', 4],
  ['fri', 5],
  ['sat', 6],
  ['sun', 7],
];

const ZONES = [
  [/london|лондон/i, 'Europe/London'],
  [/moscow|москв/i, 'Europe/Moscow'],
  [/dubai|дуба[йя]/i, 'Asia/Dubai'],
  [/istanbul|стамбул/i, 'Europe/Istanbul'],
  [/\b(?:gmt|utc)\b/i, 'UTC'],
];

function tokenAt(text, name) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}-])${name}(?![\\p{L}\\p{N}-])`, 'iu');
  return re.exec(text);
}

function findWeekday(text) {
  let best = null;
  for (const [name, weekday] of WEEKDAYS) {
    const match = tokenAt(text, name);
    if (!match) continue;
    if (!best || name.length > best.length) {
      best = { weekday, index: match.index, length: match[0].length, name };
    }
  }
  return best;
}

function findRelative(text) {
  const tomorrow = tokenAt(text, 'tomorrow') || tokenAt(text, 'завтра');
  if (tomorrow) return { kind: 'tomorrow', index: tomorrow.index, length: tomorrow[0].length };
  const today = tokenAt(text, 'today') || tokenAt(text, 'сегодня');
  if (today) return { kind: 'today', index: today.index, length: today[0].length };
  return null;
}

function findWeekend(text) {
  const match = text.match(/(?<![\p{L}\p{N}-])(this weekend|в эти выходные|на выходных|выходные)(?![\p{L}\p{N}-])/iu);
  if (!match) return null;
  return { index: match.index, length: match[0].length };
}

function hasNext(text, index) {
  const before = text.slice(Math.max(0, index - 16), index);
  return /(?<![\p{L}\p{N}-])(next|следующ\p{L}*)\s*$/iu.test(before);
}

function findZone(text) {
  const hinted = /(time|время|zeit|по\s+моск)/i.test(text);
  if (!hinted) return null;
  for (const [re, zone] of ZONES) {
    if (re.test(text)) return zone;
  }
  return null;
}

function maskNonTimes(text) {
  let out = text;
  const blank = (re) => {
    out = out.replace(re, (match) => ' '.repeat(match.length));
  };
  blank(/\+?\d[\d\s()-]{8,}\d/g);
  blank(/(?:(?:aed|usd|eur|dh|\$|€|дирхам\p{L}*|долл\p{L}*)\s*)?\d[\d\s]*[.,]\d+\s*(?:per\s+)?(?:sq\.?\s*ft|sqft|sq\.?\s*m|sqm|м²|м2)/giu);
  blank(/(?:aed|usd|eur|\$|€)\s*\d[\d\s.,]*/gi);
  blank(/\d[\d\s.,]*\s*(?:aed|usd|eur|дирхам\p{L}*|долл\p{L}*|dirhams?)/giu);
  out = out.replace(/(?<![\p{L}\p{N}])(\d{1,2})[.](\d{1,2})(?:[.](\d{2,4}))?(?![\p{L}\p{N}])/gu, (match, day, month) => {
    const d = Number(day);
    const m = Number(month);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return ' '.repeat(match.length);
    return match;
  });
  return out;
}

function to24(hour, minute, suffix) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59 || hour < 0) return null;
  if (suffix) {
    const mark = suffix.toLowerCase();
    if (hour < 1 || hour > 12) return null;
    if (mark === 'am') return { hour: hour === 12 ? 0 : hour, minute };
    return { hour: hour === 12 ? 12 : hour + 12, minute };
  }
  if (hour > 23) return null;
  return { hour, minute };
}

function interpret(hour, minute, suffix, explicitPeriod) {
  if (suffix) {
    const clock = to24(hour, minute, suffix);
    if (!clock || clock.hour < 7) return null;
    return { ...clock, ambiguous: false };
  }
  if (explicitPeriod === 'pm') {
    const clock = to24(hour, minute, 'pm');
    if (!clock || clock.hour < 7) return null;
    return { ...clock, ambiguous: false };
  }
  if (explicitPeriod === 'am') {
    const clock = to24(hour, minute, 'am');
    if (!clock || clock.hour < 7) return null;
    return { ...clock, ambiguous: false };
  }
  if (hour >= 8 && hour <= 23) return { hour, minute, ambiguous: false };
  if (hour >= 1 && hour <= 7) return { hour: hour + 12, minute, ambiguous: true };
  return null;
}

function pushClock(list, text, index, length, hour, minute, suffix, explicitPeriod) {
  const clock = interpret(hour, minute, suffix, explicitPeriod);
  if (!clock) return;
  list.push({ ...clock, index, length, raw: text.slice(index, index + length) });
}

function collectClocks(text) {
  const clocks = [];
  const noon = text.match(/(?<![\p{L}\p{N}-])(noon|midday|полдень)(?![\p{L}\p{N}-])/iu);
  if (noon) clocks.push({ hour: 12, minute: 0, ambiguous: false, index: noon.index, length: noon[0].length });

  const patterns = [
    /(?<![\p{L}\p{N}])(\d{1,2})[:.](\d{2})\s*(am|pm)?(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])(\d{1,2})\s*(am|pm)(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])(?:at|um)\s+(\d{1,2})(?![:.\d]|\s*(?:am|pm)\b)/giu,
    /(?<![\p{L}\p{N}])в\s+(\d{1,2})(?:\s*(дня|вечера|утра|час(?:а|ов)?))?(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])(\d{1,2})\s*h(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])(\d{1,2})\s*час(?:а|ов)?(?![\p{L}\p{N}])/giu,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      const token = match[0];
      if (/[:.]/.test(token) && !/(am|pm)/i.test(token)) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        const nearCue = /(?:^|[\s,(])(?:at|в|um)\s*$/i.test(text.slice(Math.max(0, match.index - 4), match.index))
          || /(?:at|в|um)\s+$/i.test(text.slice(Math.max(0, match.index - 4), match.index));
        const dotted = token.includes('.');
        const dayish = minute >= 1 && minute <= 12 && hour >= 1 && hour <= 31;
        if (dotted && !nearCue && dayish) continue;
        if (dotted && !nearCue && hour < 8 && minute !== 0 && minute !== 15 && minute !== 30 && minute !== 45) continue;
      }
      if (match[2] && /^(am|pm)$/i.test(match[2]) && match.length === 3 && !/[:.]/.test(token)) {
        pushClock(clocks, text, match.index, token.length, Number(match[1]), 0, match[2], null);
        continue;
      }
      if (/^(?:at|um)\s+/i.test(token)) {
        pushClock(clocks, text, match.index, token.length, Number(match[1]), 0, null, null);
        continue;
      }
      if (/^в\s+/i.test(token)) {
        const word = (match[2] || '').toLowerCase();
        const period = word === 'дня' || word === 'вечера' ? 'pm' : word === 'утра' ? 'am' : null;
        pushClock(clocks, text, match.index, token.length, Number(match[1]), 0, null, period);
        continue;
      }
      if (/h$/i.test(token) || /час/i.test(token)) {
        pushClock(clocks, text, match.index, token.length, Number(match[1]), 0, null, null);
        continue;
      }
      if (match[2] && /^\d{2}$/.test(match[2])) {
        pushClock(clocks, text, match.index, token.length, Number(match[1]), Number(match[2]), match[3] || null, null);
      }
    }
  }
  return clocks;
}

function closeEnough(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.index - b.index) <= 48;
}

function nextWeekday(base, weekday, hour, minute, plusWeek) {
  let day = base.set({ hour, minute, second: 0, millisecond: 0 });
  const delta = (weekday - day.weekday + 7) % 7;
  day = day.plus({ days: delta + (plusWeek ? 7 : 0) });
  if (!plusWeek && day <= base) day = day.plus({ days: 7 });
  return day;
}

function nextClock(base, hour, minute) {
  let start = base.set({ hour, minute, second: 0, millisecond: 0 });
  if (start <= base) start = start.plus({ days: 1 });
  return start;
}

function parseProposal(text, zone = 'Asia/Dubai', now = new Date()) {
  const original = String(text || '');
  if (!original.trim()) return null;
  const masked = maskNonTimes(original);
  const clocks = collectClocks(masked);
  const namedDay = findWeekday(masked);
  if (!clocks.length && namedDay && hasNext(masked, namedDay.index)) {
    clocks.push({ hour: 16, minute: 0, ambiguous: true, index: namedDay.index, length: namedDay.length, raw: 'next' });
  }
  if (!clocks.length && !findWeekend(masked)) return null;
  const relative = findRelative(masked);
  const weekday = findWeekday(masked);
  const weekend = findWeekend(masked);
  const clock = clocks.slice().sort((a, b) => {
    const aDay = (weekday && closeEnough(a, weekday)) || (relative && closeEnough(a, relative)) || (weekend && closeEnough(a, weekend));
    const bDay = (weekday && closeEnough(b, weekday)) || (relative && closeEnough(b, relative)) || (weekend && closeEnough(b, weekend));
    if (aDay !== bDay) return aDay ? -1 : 1;
    return a.index - b.index;
  })[0] || null;
  const anchor = clock || weekend;
  if (!anchor) return null;
  const relNear = clock ? closeEnough(relative, clock) : Boolean(relative && weekend && closeEnough(relative, weekend));
  const weekNear = clock ? closeEnough(weekday, clock) : false;
  const weekEndNear = weekend && (!clock || closeEnough(weekend, clock));
  const bare = !relNear && !weekNear && !weekEndNear;
  if (bare && clock) {
    const cue = /(?:at|в|um|час|h\b|am|pm|noon|полдень)/i.test(clock.raw || masked.slice(clock.index, clock.index + clock.length));
    if (!cue) return null;
  }
  if (!clock && !weekEndNear) return null;
  const namedZone = findZone(original);
  const useZone = namedZone || zone;
  const instant = now instanceof Date ? now : new Date(now);
  const base = DateTime.fromJSDate(instant, { zone: useZone });
  if (!base.isValid) return null;
  const hour = clock ? clock.hour : 12;
  const minute = clock ? clock.minute : 0;
  let start;
  if (weekEndNear && !weekNear) {
    const plus = hasNext(masked, weekend.index);
    start = nextWeekday(base, 6, hour, minute, plus);
  } else if (relNear && (!weekNear || Math.abs(relative.index - (clock ? clock.index : weekend.index)) <= Math.abs(weekday.index - (clock ? clock.index : 0)))) {
    const day = relative.kind === 'tomorrow' ? base.plus({ days: 1 }) : base;
    start = day.set({ hour, minute, second: 0, millisecond: 0 });
  } else if (weekNear) {
    start = nextWeekday(base, weekday.weekday, hour, minute, hasNext(masked, weekday.index));
  } else {
    start = nextClock(base, hour, minute);
  }
  if (!start || !start.isValid || start <= base) return null;
  return {
    start_utc: start.toUTC().toISO(),
    zone: useZone,
    hour,
    minute,
    ambiguous: clock ? clock.ambiguous === true : true,
    zone_explicit: Boolean(namedZone),
    zone_unspecified: !namedZone,
    weekend: Boolean(weekEndNear && !weekNear),
  };
}

function parseClock(text) {
  const clocks = collectClocks(maskNonTimes(String(text || '')));
  return clocks[0] || null;
}

module.exports = { parseProposal, parseClock };
