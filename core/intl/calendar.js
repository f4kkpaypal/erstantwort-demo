'use strict';

const { DateTime } = require('luxon');

// Broker working grid for the intl test mode. Sunday is off. 13:00–14:00 is lunch.
// Suggested buttons use this grid. A time the client named can still be free
// when it sits inside 10:00–18:00 and does not overlap a busy block.
const WORK_HOURS = [10, 11, 12, 15, 16, 17];
const DURATION_MIN = 45;

function asDateTime(value, zone) {
  if (DateTime.isDateTime(value)) return value.setZone(zone);
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  return DateTime.fromISO(String(value), { setZone: true }).setZone(zone);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function slotId(start) {
  return `cal-${start.toUTC().toISO().replace(/[^0-9]/g, '').slice(0, 14)}`;
}

function toSlot(start, durationMin) {
  return {
    id: slotId(start),
    start_utc: start.toUTC().toISO(),
    duration_min: durationMin,
    source: 'calendar',
  };
}

class MockBrokerCalendar {
  constructor(options = {}) {
    this.mode = 'mock';
    this.source = 'mock-schedule';
    this.zone = options.zone || 'Asia/Dubai';
    this.now = options.now || (() => new Date());
    this.extraBusy = Array.isArray(options.busy) ? options.busy : [];
    this.lunch = options.lunch !== false;
    // Real Google Calendar attaches here: createBrokerCalendar(config, { getBusy }).
    this.google_hook = 'createBrokerCalendar(config, { getBusy })';
    this.google_ready = false;
  }

  blocksCovering(start, end) {
    const blocks = [];
    if (this.lunch) {
      const lunchStart = start.set({ hour: 13, minute: 0, second: 0, millisecond: 0 });
      blocks.push({ start: lunchStart, end: lunchStart.plus({ hours: 1 }) });
    }
    for (const row of this.extraBusy) {
      const busyStart = asDateTime(row.start, this.zone);
      const busyEnd = asDateTime(row.end, this.zone);
      if (busyStart.isValid && busyEnd.isValid) blocks.push({ start: busyStart, end: busyEnd });
    }
    return blocks.filter((block) => overlaps(start, end, block.start, block.end));
  }

  isFree(startIso, durationMin = DURATION_MIN) {
    const start = asDateTime(startIso, this.zone);
    if (!start.isValid) return false;
    const now = asDateTime(this.now(), this.zone);
    if (start <= now) return false;
    if (start.weekday === 7) return false;
    const end = start.plus({ minutes: durationMin });
    const open = start.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const close = start.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
    if (start < open || end > close) return false;
    return this.blocksCovering(start, end).length === 0;
  }

  freeSlots({ now, count = 8, durationMin = DURATION_MIN, zone } = {}) {
    const z = zone || this.zone;
    const startNow = asDateTime(now || this.now(), z);
    const slots = [];
    for (let dayOffset = 0; dayOffset < 12 && slots.length < count; dayOffset += 1) {
      const day = startNow.startOf('day').plus({ days: dayOffset });
      if (day.weekday === 7) continue;
      for (const hour of WORK_HOURS) {
        if (slots.length >= count) break;
        const start = day.set({ hour, minute: 0, second: 0, millisecond: 0 });
        if (!this.isFree(start.toUTC().toISO(), durationMin)) continue;
        slots.push(toSlot(start, durationMin));
      }
    }
    return slots;
  }
}

class UnavailableCalendar {
  constructor(options = {}) {
    this.mode = 'google';
    this.source = 'google-calendar';
    this.zone = options.zone || 'Asia/Dubai';
    this.now = options.now || (() => new Date());
    this.error = 'calendar_unavailable';
    this.google_ready = false;
    this.async = false;
  }

  isFree() { return false; }

  freeSlots() { return []; }
}

class GoogleBrokerCalendar extends MockBrokerCalendar {
  constructor(driver, options = {}) {
    super({ ...options, lunch: false, busy: [] });
    this.mode = 'google';
    this.source = 'google-calendar';
    this.google_ready = true;
    this.async = true;
    this.driver = driver;
    this.timeoutMs = options.timeoutMs || 4000;
    this.error = null;
    this._cacheKey = '';
    this._cache = [];
  }

  async loadBusy(from, to) {
    const key = `${from}|${to}`;
    if (this._cacheKey === key && !this.error) return this._cache;
    let timer;
    try {
      const pending = Promise.resolve().then(() => this.driver.getBusy({ start: from, end: to, tz: this.zone }));
      const rows = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('calendar_timeout')), this.timeoutMs);
        }),
      ]);
      if (!Array.isArray(rows)) throw new Error('calendar_unavailable');
      this.error = null;
      this._cacheKey = key;
      this._cache = rows.map((row) => ({
        start: asDateTime(row.start, this.zone),
        end: asDateTime(row.end, this.zone),
      })).filter((row) => row.start.isValid && row.end.isValid);
      return this._cache;
    } catch {
      this.error = 'calendar_unavailable';
      this._cacheKey = '';
      this._cache = [];
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async blocksCovering(start, end) {
    const from = start.startOf('day').toUTC().toISO();
    const to = start.endOf('day').toUTC().toISO();
    const rows = await this.loadBusy(from, to);
    if (!rows) return null;
    return rows.filter((block) => overlaps(start, end, block.start, block.end));
  }

  async isFree(startIso, durationMin = DURATION_MIN) {
    if (this.error) return false;
    const start = asDateTime(startIso, this.zone);
    if (!start.isValid) return false;
    const now = asDateTime(this.now(), this.zone);
    if (start <= now) return false;
    if (start.weekday === 7) return false;
    const end = start.plus({ minutes: durationMin });
    const open = start.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const close = start.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
    if (start < open || end > close) return false;
    const blocks = await this.blocksCovering(start, end);
    if (!blocks || this.error) return false;
    return blocks.length === 0;
  }

  async freeSlots({ now, count = 8, durationMin = DURATION_MIN, zone } = {}) {
    if (this.error) return [];
    const z = zone || this.zone;
    const startNow = asDateTime(now || this.now(), z);
    const slots = [];
    for (let dayOffset = 0; dayOffset < 12 && slots.length < count; dayOffset += 1) {
      const day = startNow.startOf('day').plus({ days: dayOffset });
      if (day.weekday === 7) continue;
      for (const hour of WORK_HOURS) {
        if (slots.length >= count || this.error) break;
        const start = day.set({ hour, minute: 0, second: 0, millisecond: 0 });
        if (!(await this.isFree(start.toUTC().toISO(), durationMin))) continue;
        slots.push(toSlot(start, durationMin));
      }
    }
    return this.error ? [] : slots;
  }
}

function createBrokerCalendar(config = {}, deps = {}) {
  const zone = deps.zone || config.BROKER_TZ || 'Asia/Dubai';
  const now = deps.now || (() => new Date());
  const wantsGoogle = config.INTL_CALENDAR_MODE === 'google' || config.CALENDAR_MODE === 'google';
  if (wantsGoogle && typeof deps.getBusy === 'function') {
    return new GoogleBrokerCalendar({ getBusy: deps.getBusy }, { zone, now, timeoutMs: deps.timeoutMs });
  }
  if (wantsGoogle) return new UnavailableCalendar({ zone, now });
  return new MockBrokerCalendar({ zone, now, busy: deps.busy, lunch: deps.lunch });
}

module.exports = {
  MockBrokerCalendar,
  GoogleBrokerCalendar,
  UnavailableCalendar,
  createBrokerCalendar,
  WORK_HOURS,
  DURATION_MIN,
};
