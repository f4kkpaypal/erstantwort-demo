'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePortalPayload, parseGermanAmount } = require('../core/portals');
const { parseAnfrage, applyPortalFacts, horizonFromTarget } = require('../core/anfrage');
const { normalizeInbound } = require('../core/normalize');
const { loadFixtureEml } = require('../core/eml');
const { paragraphsOk, paragraphsConsistent } = require('../core/template');

const XML = `<openimmo_feedback><version>1.2.5</version><sender><name>IS24</name><regi_id>IS24</regi_id></sender>
 <objekt><portal_obj_id>63843270</portal_obj_id><bezeichnung>3-Zi.-Eigentumswohnung mit Balkon</bezeichnung>
  <preis>450.000,00 €</preis>
  <interessent><anrede>Frau</anrede><vorname>Anna</vorname><nachname>Schmidt</nachname>
   <tel>+49 30 0000001</tel><email>anna.schmidt@lead.testdomain.de</email>
   <anfrage>Gewünschter Einzugstermin: 01.02.2027; Eigenkapital: 100.000 - 125.000€; Finanzrahmen geprüft: Ja; SCHUFA-Bonitätscheck: Nein</anfrage>
  </interessent></objekt></openimmo_feedback>`;

test('ImmoScout24 OpenImmo is parsed and Immowelt stays unimplemented', () => {
  const parsed = parsePortalPayload({ xml: XML });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.portal, 'immoscout24');
  assert.equal(parsed.fields.portal_listing_id, '63843270');
  assert.equal(parsed.fields.email, 'anna.schmidt@lead.testdomain.de');
  assert.equal(parsed.fields.price_eur, 450000);
  assert.equal(parsed.fields.salutation, 'Frau');
  const immowelt = parsePortalPayload({
    xml: '<openimmo_feedback><sender><name>Immowelt</name><regi_id>immowelt</regi_id></sender></openimmo_feedback>',
  });
  assert.equal(immowelt.ok, false);
  assert.equal(immowelt.code, 'NOT_IMPLEMENTED');
  assert.equal(parsePortalPayload({ portal: 'immowelt', xml: XML }).code, 'NOT_IMPLEMENTED');
});

test('portal anfrage phrases override vague model output', () => {
  const facts = parseAnfrage(XML, new Date('2026-10-21T10:00:00.000Z'));
  assert.equal(facts.financing_status, 'finanzierungszusage');
  assert.equal(facts.equity_eur, 100000);
  assert.equal(facts.target_date, '2027-02-01');
  assert.equal(facts.timeline_horizon, '3_bis_6_monate');
  assert.equal(facts.schufa_available, 'nein');
  assert.equal(parseAnfrage('Einzug zum 01.02.2027', new Date('2026-10-21T10:00:00.000Z')).target_date, '2027-02-01');
  assert.equal(parseAnfrage('Einzugsdatum: 01.02.2027', new Date('2026-10-21T10:00:00.000Z')).timeline_horizon, '3_bis_6_monate');
  const merged = applyPortalFacts({
    timeline: { target_date: null, horizon: 'unbekannt' },
    financing_status: 'unbekannt',
    budget: { amount_max_eur: null },
    contact: { phone: null },
    missing_fields: ['timeline', 'financing', 'budget', 'phone'],
  }, {
    phone: '+49 30 0000001',
  }, facts);
  assert.equal(merged.timeline.target_date, '2027-02-01');
  assert.equal(merged.financing_status, 'finanzierungszusage');
  assert.deepEqual(merged.missing_fields, ['budget']);
  assert.equal(horizonFromTarget('2027-03-28', new Date('2026-10-21T00:00:00.000Z')), '3_bis_6_monate');
  assert.equal(parseGermanAmount('1.200,50 €'), 1200.5);
});

test('normalize drops quotes, control tags and keeps at most 8000 characters', () => {
  const mail = loadFixtureEml('E01');
  const normalized = normalizeInbound(mail, { ownAddresses: ['makler@lead.testdomain.de'] });
  assert.match(normalized.text_clean, /Stellplatz/);
  assert.doesNotMatch(normalized.text_clean, /openimmo_feedback/);
  assert.equal(normalized.skip_auto, false);
  assert.equal(normalized.message_id, '<e01.portal.001@immobilienscout24.de>');
  const quoted = normalizeInbound({
    messageId: '<q@lead.testdomain.de>',
    from: 'a@lead.testdomain.de',
    subject: 'Re: Test',
    textPlain: 'Nr. 2\n> altes Zitat\nAm 21.10.2026 schrieb Alex:\nbitte ignorieren <email>hack</email>',
    headers: {},
  });
  assert.equal(quoted.text_clean.startsWith('Nr. 2'), true);
  assert.equal(quoted.text_clean.includes('altes Zitat'), false);
  assert.equal(quoted.text_clean.includes('<email>'), false);
  const long = normalizeInbound({
    messageId: '<long@lead.testdomain.de>',
    from: 'a@lead.testdomain.de',
    subject: 'Lang',
    textPlain: 'A'.repeat(9000),
    headers: {},
  });
  assert.equal(long.text_clean.length, 8000);
});

test('paragraph guard rejects urls, amounts and invented availability', () => {
  assert.equal(paragraphsOk(['Vielen Dank für Ihr Interesse.']), true);
  assert.equal(paragraphsOk(['Siehe https://evil.example/pay']), false);
  assert.equal(paragraphsOk(['Die Wohnung ist noch frei und provisionsfrei.']), false);
  assert.equal(paragraphsOk(['Der Preis beträgt 450000 EUR.']), false);
  const objekt = {
    stellplatz_text: 'Ein Tiefgaragenstellplatz ist vorhanden und kann separat angemietet werden.',
    provision_text: 'Die Käuferprovision beträgt 3,57 Prozent einschließlich MwSt.',
  };
  const clash = ['Der Tiefgaragenstellplatz ist direkt mit der Wohnung verbunden.'];
  assert.equal(paragraphsOk(clash), true);
  assert.equal(paragraphsConsistent(clash, objekt), false);
  assert.equal(paragraphsConsistent(['Die Antwort zum Stellplatz steht unten.'], objekt), true);
  assert.equal(paragraphsConsistent(['Der Stellplatz kann separat angemietet werden.'], objekt), true);
  assert.equal(paragraphsConsistent(['Die Wohnung ist provisionsfrei.'], objekt), false);
});
