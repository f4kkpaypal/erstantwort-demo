'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../core/config');
const { SqliteStore } = require('../core/sqliteStore');
const { MemoryCrm, sheetProjection } = require('../core/crm');
const { runRetention } = require('../core/retention');
const { formSchema } = require('../core/fragebogen');
const { gradeChanged, bookingWord } = require('../core/uiModel');
const { renderDatenschutz, renderImpressum } = require('../core/legal');
const { ALERT } = require('../engine/loops');

test('sheet rows drop email and phone unless the office turns that on', () => {
  const row = { lead_id: 'L1', email: 'a@b.de', phone: '+49123', email_hash: 'abc', first_name: 'Ann' };
  const hidden = sheetProjection(row, false);
  assert.equal(hidden.email, '');
  assert.equal(hidden.phone, '');
  assert.equal(hidden.email_hash, 'abc');
  assert.equal(hidden.first_name, 'Ann');
  assert.equal(sheetProjection(row, true).email, 'a@b.de');
});

test('retention deletes the lead and keeps the STOP hash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erstantwort-'));
  const store = new SqliteStore(path.join(dir, 'autopilot.sqlite'));
  const crm = new MemoryCrm();
  try {
    await store.addOptout('hash-stop');
    await store.upsertCard({
      lead_id: 'L-old',
      created_at: '2020-01-01T00:00:00.000Z',
      retention_until: '2020-06-01T00:00:00.000Z',
      email: 'old@lead.testdomain.de',
    });
    await store.insertOutbound({
      sent_message_id_hash: 'out-old',
      lead_id: 'L-old',
      kind: 'first_reply',
      offered_slots: [],
      sent_at: '2020-01-02T00:00:00.000Z',
    });
    await crm.upsertLead({
      lead_id: 'L-old',
      email: 'old@lead.testdomain.de',
      retention_until: '2020-06-01T00:00:00.000Z',
    });
    await store.upsertCard({
      lead_id: 'L-new',
      created_at: '2026-10-01T00:00:00.000Z',
      retention_until: '2099-01-01T00:00:00.000Z',
      email: 'new@lead.testdomain.de',
    });
    const result = await runRetention({ board: store, db: store, crm }, new Date('2026-10-26T00:00:00.000Z'));
    assert.equal(result.deleted, 1);
    assert.equal(result.optout_kept, true);
    assert.equal(await store.isOptout('hash-stop'), true);
    assert.equal(await store.getCard('L-old'), null);
    assert.equal(await store.findOutboundByHash('out-old'), null);
    assert.equal((await crm.findByLeadId('L-old')).lead, null);
    assert.equal((await store.getCard('L-new')).email, 'new@lead.testdomain.de');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owner area labels follow the object and a unchanged score is not a change', () => {
  const haus = formSchema({
    lead: { lead_kind: 'eigentuemer', object_type: 'haus', listing_title: 'Haus am Stadtpark' },
    makler: { name: 'Maria K.', buero: 'Büro', adresse: 'Weg 1' },
    config: {},
  });
  const area = haus.steps[0].fields.find((field) => field.name === 'area_sqm');
  assert.equal(area.label, 'Ungefähre Wohnfläche des Hauses in m²');
  assert.doesNotMatch(area.label, /Wohnung/);
  assert.equal(area.area_labels.grundstueck, 'Ungefähre Grundstücksfläche in m²');
  assert.doesNotMatch(haus.prompt_line, /Wohnung/);
  assert.equal(gradeChanged({
    fragebogen_status: 'submitted', grade_before: 'HOT', grade: 'HOT', score_before: 85, score: 85,
  }), false);
  assert.equal(gradeChanged({
    fragebogen_status: 'submitted', grade_before: 'WARM', grade: 'HOT', score_before: 40, score: 70,
  }), true);
  assert.equal(bookingWord('booked'), 'gebucht');
  assert.equal(bookingWord('confirmed'), 'bestätigt');
  assert.equal(bookingWord(''), 'unbestätigt');
});

test('live legal pages do not invent an office, demo pages stay labelled', () => {
  const live = loadConfig({ OFFICE_MODE: 'live', PRODUCT_NAME: 'Erstantwort' });
  assert.equal(live.MAKLER_PROFILE.name, '');
  assert.equal(live.MAKLER_PROFILE.adresse, '');
  const impressum = renderImpressum(live);
  const datenschutz = renderDatenschutz(live);
  assert.doesNotMatch(impressum, /Johannisstraße|Nürnberg|Maria K/);
  assert.doesNotMatch(datenschutz, /Johannisstraße|Nürnberg/);
  assert.match(impressum, /Angaben fehlen/);
  const demo = loadConfig({});
  assert.match(renderDatenschutz(demo), /Nürnberg/);
  assert.match(renderDatenschutz(demo), /Erstantwort/);
  assert.match(renderImpressum(demo), /fiktive Daten/);
  assert.equal(loadConfig({}).PRODUCT_NAME, 'Erstantwort');
  assert.equal(loadConfig({}).UI_STORE, 'fixture');
  assert.equal(loadConfig({}).IMAP_MODE, 'off');
  assert.equal(loadConfig({}).OWNER_LEADS_ENABLED, false);
  assert.equal(loadConfig({}).SHEET_INCLUDE_CONTACT, false);
  assert.equal(loadConfig({}).LLM_MODE, 'mock');
  assert.doesNotMatch(ALERT, /@|Anna|Schmidt/);
});
