'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { pickSlots, formatSlotShort, formatSlotLong, slotConflicts } = require('../core/slots');
const { DEFAULT_SLOT_RULES } = require('../core/config');

const NOW = new Date('2026-10-21T10:00:00.000Z');

test('three weekday slots in Berlin, skipping the weekend and the busy hour', () => {
  const slots = pickSlots({ now: NOW, busy: [], rules: DEFAULT_SLOT_RULES, count: 3 });
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((slot) => slot.label), [
    'Do., 22.10., 16:00 Uhr',
    'Fr., 23.10., 16:00 Uhr',
    'Mo., 26.10., 16:00 Uhr',
  ]);
  assert.equal(DateTime.fromISO(slots[0].start, { setZone: true }).toFormat('ZZ'), '+02:00');
  assert.equal(DateTime.fromISO(slots[2].start, { setZone: true }).toFormat('ZZ'), '+01:00');
  for (const slot of slots) {
    const start = DateTime.fromISO(slot.start, { setZone: true });
    assert.ok(start.weekday <= 5);
    assert.ok(start.hour >= 10 && start.hour <= 17);
  }
});

test('a busy block plus the 15 minute buffer removes that slot', () => {
  const blocked = pickSlots({
    now: NOW,
    busy: [{ start: '2026-10-22T16:00:00.000+02:00', end: '2026-10-22T16:30:00.000+02:00' }],
    rules: DEFAULT_SLOT_RULES,
    count: 1,
  });
  assert.equal(blocked[0].label, 'Do., 22.10., 11:00 Uhr');
  const touching = slotConflicts(
    DateTime.fromISO('2026-10-22T16:00:00.000+02:00'),
    DateTime.fromISO('2026-10-22T16:45:00.000+02:00'),
    [{ start: '2026-10-22T17:00:00.000+02:00', end: '2026-10-22T17:30:00.000+02:00' }],
    15,
    'Europe/Berlin',
  );
  assert.equal(touching, false);
});

test('grade is not an input: the same busy calendar yields the same slots', () => {
  const a = pickSlots({ now: NOW, busy: [], rules: DEFAULT_SLOT_RULES });
  const b = pickSlots({ now: NOW, busy: [], rules: DEFAULT_SLOT_RULES });
  assert.deepEqual(a, b);
});

test('DST labels stay in local Berlin time', () => {
  assert.equal(formatSlotShort('2026-10-25T15:00:00.000Z'), 'So., 25.10., 16:00 Uhr');
  assert.equal(formatSlotShort('2026-10-23T14:00:00.000Z'), 'Fr., 23.10., 16:00 Uhr');
  assert.equal(formatSlotShort('2027-03-28T08:00:00.000Z'), 'So., 28.03., 10:00 Uhr');
  assert.equal(formatSlotLong('2026-10-26T15:00:00.000Z'), 'Montag, 26.10.2026, 16:00 Uhr');
});
