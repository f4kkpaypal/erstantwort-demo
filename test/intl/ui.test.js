'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'ui-intl');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'ru.json'), 'utf8'));

test('the tab bar is fixed on every screen and the send bar sits above it', () => {
  assert.match(appJs, /<nav class="tabs"/);
  const tabs = appJs.slice(appJs.indexOf('function tabs'), appJs.indexOf('function bar'));
  const at = (id) => tabs.indexOf(`id: '${id}'`);
  assert.ok(at('inbox') < at('properties') && at('properties') < at('viewings') && at('viewings') < at('setup'));
  for (const id of ['inbox', 'viewings', 'properties', 'setup']) {
    assert.match(appJs, new RegExp(`#/${id}`));
  }
  assert.equal(appJs.includes('style="'), false);
  assert.match(appJs, /\$\{inner\}\$\{tabs\(waiting\)\}/);
  assert.ok((appJs.match(/\bshell\(/g) || []).length >= 8);
  assert.match(css, /\.tabs\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.tabs\s*\{[^}]*safe-area-inset-bottom/s);
  assert.match(css, /\.actbar\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.actbar\s*\{[^}]*safe-area-inset-bottom/s);
  assert.equal(/\.actbar\s*\{[^}]*position:\s*sticky/s.test(css), false);
  assert.match(appJs, /class="bd"/);
  assert.match(appJs, /id="ta"/);
  assert.match(appJs, /id="reset"/);
  assert.match(appJs, /data-slot/);
  assert.match(appJs, /proposal_en/);
  assert.match(appJs, /proposal_ru/);
  assert.doesNotMatch(appJs, /I can also offer|Могу также предложить/);
  assert.match(appJs, /t\('returnOriginal'\)/);
  assert.match(appJs, /send\.onclick/);
  assert.match(appJs, /id="formError"/);
  assert.match(appJs, /slot_ids: state\.slotIds/);
  assert.match(appJs, /function budgetText/);
  assert.match(appJs, /periodUnclear/);
  assert.match(appJs, /t\('resets'\)/);
  assert.match(appJs, /state\.ephemeral/);
});

test('the Russian dictionary covers the chrome and does not leave English field labels', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  assert.equal(ru.inbox, 'Заявки');
  assert.equal(ru.viewings, 'Просмотры');
  assert.equal(ru.properties, 'Объекты');
  assert.equal(ru.setup, 'Настройки');
  assert.equal(ru.wants, 'Хочет');
  assert.equal(ru.budget, 'Бюджет');
  assert.equal(ru.timing, 'Срок');
  assert.equal(ru.language, 'Язык');
  assert.equal(ru.notStated, 'не указано');
  assert.equal(ru.intentViewing, 'Просмотр');
  assert.equal(ru.intentUnclear, 'Непонятное сообщение');
  assert.equal(ru.perYear, 'год');
  assert.equal(ru.rent, 'Аренда');
  assert.equal(en.wants, 'Wants');
  assert.equal(en.budget, 'Budget');
  assert.equal(en.timing, 'Timing');
  assert.equal(en.language, 'Language');
  assert.equal(en.notStated, 'not stated');
  assert.match(en.intentViewing, /viewing/i);
  assert.match(en.intentUnclear, /unclear/i);
  assert.equal(en.perYear, 'year');
  assert.equal(en.rent, 'Rent');
  assert.equal(en.viewings, 'Viewings');
  const brands = new Set(['whatsapp', 'telegram']);
  for (const [key, value] of Object.entries(ru)) {
    if (brands.has(key)) continue;
    const low = String(value).toLowerCase();
    assert.equal(low.includes('wants'), false, key);
    assert.equal(low.includes('budget'), false, key);
    assert.equal(low.includes('timing'), false, key);
    assert.equal(low.includes('not stated'), false, key);
    assert.equal(low.includes('unclear'), false, key);
    assert.equal(low.includes('rent aed'), false, key);
    assert.equal(low.includes('/ year'), false, key);
    assert.equal(/\bviewing\b/.test(low), false, key);
    assert.equal(/\blanguage\b/.test(low), false, key);
    assert.equal(/\brent\b/.test(low), false, key);
    assert.equal(/\byear\b/.test(low), false, key);
  }
});
