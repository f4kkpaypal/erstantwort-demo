'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyReply, leadIdFromSubject } = require('../core/reply');

test('Nr. 2 and the other slot phrasings select a slot', () => {
  assert.deepEqual(classifyReply('Nr. 2 passt mir, danke!'), { action: 'book', slot_index: 2, reason: 'slot' });
  assert.equal(classifyReply('nr 1').slot_index, 1);
  assert.equal(classifyReply('Termin 3 bitte').slot_index, 3);
  assert.equal(classifyReply('Option 2').slot_index, 2);
  assert.equal(classifyReply('  2').slot_index, 2);
  assert.equal(classifyReply('Ich nehme gern Nr. 2').slot_index, 2);
  assert.equal(classifyReply('Zimmer 2 bitte').action, 'needs_human');
});

test('STOP words disable automation before a slot number would', () => {
  for (const text of ['STOP', 'stopp bitte', 'Bitte abmelden', 'kein Interesse', 'Keine weiteren Nachrichten', 'Abmeldung', 'Bitte stoppen', 'Danke, passt. STOP', 'Bitte melden Sie mich ab', 'Unsubscribe', 'Bitte keine weiteren E-Mails.', 'Ich habe kein Interesse mehr', 'Abbestellen', 'Austragen', 'Ich widerspreche', 'Widerspruch', 'Nicht mehr anschreiben', 'Keine weiteren Mitteilungen']) {
    assert.equal(classifyReply(text).action, 'stop', text);
  }
  assert.equal(classifyReply('Ich nehme gern Nr. 2. STOP').reason, 'stop_and_slot');
});

test('quoted footers and lookalike words do not turn a slot reply into STOP', () => {
  const footer = 'Sie können der weiteren automatischen Bearbeitung Ihrer Anfrage jederzeit widersprechen: Antworten Sie einfach mit „STOP“.';
  const gmx = ['Nr. 2 passt mir.', '', 'Gesendet: Mittwoch, 21. Oktober 2026 um 12:04', 'Von: Alex Berger <makler@lead.testdomain.de>', footer].join('\n');
  const outlook = ['Nr. 2 passt mir.', '', '-----Ursprüngliche Nachricht-----', 'From: Alex Berger', footer].join('\n');
  assert.equal(classifyReply(gmx).action, 'book');
  assert.equal(classifyReply(gmx).slot_index, 2);
  assert.equal(classifyReply(outlook).action, 'book');
  assert.equal(classifyReply(`Nr. 2 passt mir.\n${footer}`).action, 'book');
  assert.equal(classifyReply('Stopp-Schild an der Einfahrt?').action, 'needs_human');
  assert.equal(classifyReply('Widerspruch gegen die Nebenkosten, Nr. 2 passt').action, 'book');
  assert.equal(classifyReply('Stop & Go Verkehr, Nr. 1 passt').action, 'book');
  assert.equal(classifyReply('Stop & Go Verkehr, Nr. 1 passt').slot_index, 1);
  assert.deepEqual(classifyReply('Nr. 2, kein Interesse an Finanzierungsberatung'), { action: 'book', slot_index: 2, reason: 'slot' });
  assert.equal(classifyReply('Nr. 2\nSTOP').reason, 'stop_and_slot');
});

test('a qualified ja is not an automatic confirmation', () => {
  const long = classifyReply('Ja, aber ich komme 10 Minuten später', { inReplyToKind: 'reminder' });
  assert.equal(long.action, 'needs_human');
  assert.notEqual(long.reason, 'confirm_not_in_loom_slice');
  const bare = classifyReply('JA', { inReplyToKind: 'reminder' });
  assert.equal(bare.action, 'needs_human');
  assert.equal(bare.reason, 'confirm_not_in_loom_slice');
});

test('lead id is read from the subject token', () => {
  assert.equal(leadIdFromSubject('Re: Ihre Anfrage: Wohnung [L-20261021-0007]'), 'L-20261021-0007');
  assert.equal(leadIdFromSubject('ohne token'), null);
});
