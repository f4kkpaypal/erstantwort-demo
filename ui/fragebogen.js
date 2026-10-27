'use strict';

const root = document.querySelector('#form');
const token = location.pathname.split('/').filter(Boolean).pop();
let schema = null;
let step = 0;
const answers = { datenschutz_gelesen: false };

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function formatSummaryLine(label, value) {
  const name = String(label || '').trim();
  const shown = String(value ?? '').trim();
  if (!name) return shown;
  if (name.endsWith('?')) return `${name} — ${shown}`;
  if (name.endsWith(':')) return `${name} ${shown}`;
  return `${name}: ${shown}`;
}

function fieldNode(field) {
  if (field.when === 'anmieten' && answers.intent !== 'anmieten') return null;
  const input = field.type === 'select' || field.type === 'radio'
    ? h('select', {
      onchange: (event) => { answers[field.name] = event.target.value; if (field.name === 'intent' || field.name === 'object_type') draw(); },
    }, h('option', { value: '' }, 'Keine Angabe'), ...field.options.map((option) => h('option', { value: option.value }, option.label)))
    : h('input', {
      type: field.type === 'number' ? 'number' : 'text',
      maxlength: field.maxLength ? String(field.maxLength) : null,
      oninput: (event) => { answers[field.name] = event.target.value; },
    });
  if (answers[field.name]) input.value = answers[field.name];
  const label = field.area_labels ? (field.area_labels[answers.object_type] || field.label) : field.label;
  return h('div', {}, h('label', {}, label), input, field.note ? h('p', { class: 'muted' }, field.note) : '');
}

function draw() {
  const current = schema.steps[step];
  const progress = h('div', { class: 'steps' }, h('span', { class: `s${step + 1}` }));
  const body = [
    schema.demo ? h('p', { class: 'muted' }, 'Demo · fiktive Daten · kein Versand an Telegram') : '',
    h('div', { class: 'row' }, h('h1', {}, current.title), h('span', {}, `Schritt ${step + 1} von 3`)),
    progress,
    h('p', {}, schema.prompt_line || `${schema.makler_name} hat ein paar Fragen zu dieser Immobilie vorbereitet.`),
    h('p', { class: 'muted' }, schema.transparency),
  ];
  if (step < 2) body.push(...current.fields.map(fieldNode).filter(Boolean));
  if (step === 2) {
    body.push(h('p', {}, 'Zusammenfassung'));
    for (const stepDef of schema.steps) {
      for (const field of stepDef.fields) {
        if (field.name === 'persons' || field.name === 'pets') continue;
        const value = answers[field.name];
        if (value == null || value === '') continue;
        const option = (field.options || []).find((row) => row.value === value);
        body.push(h('p', {}, formatSummaryLine(field.label, option ? option.label : value)));
      }
    }
    body.push(h('p', {}, schema.datenschutz));
    body.push(h('label', { class: 'check' },
      h('input', { type: 'checkbox', onchange: (event) => { answers.datenschutz_gelesen = event.target.checked; } }),
      'Ich habe die Datenschutzhinweise gelesen.',
    ));
    body.push(h('p', { class: 'muted' }, 'Alle Angaben sind freiwillig.'));
  }
  const buttons = h('div', { class: 'btn-row' });
  if (step > 0) buttons.append(h('button', { class: 'btn', type: 'button', onclick: () => { step -= 1; draw(); } }, 'Zurück'));
  buttons.append(h('button', {
    class: 'btn-dark',
    type: 'button',
    onclick: () => (step < 2 ? (step += 1, draw()) : submit()),
  }, step < 2 ? 'Weiter' : 'Angaben senden'));
  body.push(buttons);
  root.replaceChildren(h('section', { class: 'sheet' }, body));
}

async function submit() {
  if (!answers.datenschutz_gelesen) {
    root.querySelector('.sheet').append(h('p', {}, 'Bitte bestätigen Sie, dass Sie die Datenschutzhinweise gelesen haben.'));
    return;
  }
  const payload = { ...answers, datenschutz_gelesen: true };
  if (payload.budget_eur) payload.budget_eur = Number(payload.budget_eur);
  delete payload.persons;
  delete payload.pets;
  const res = await fetch(`/f/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  const message = json.message || 'Senden fehlgeschlagen. Bitte versuchen Sie es erneut.';
  root.replaceChildren(h('section', { class: 'sheet' },
    h('p', {}, message),
  ));
}

async function load() {
  root.replaceChildren(h('section', { class: 'sheet' }, h('p', {}, 'Laden …')));
  try {
    const res = await fetch(`/f/${token}`, { headers: { Accept: 'application/json' } });
    const json = await res.json();
    if (!json.ok) {
      root.replaceChildren(h('section', { class: 'sheet' }, h('h1', {}, 'Hinweis'), h('p', {}, json.message)));
      return;
    }
    schema = json;
    draw();
  } catch {
    root.replaceChildren(h('section', { class: 'sheet' }, h('p', {}, 'Senden fehlgeschlagen. Bitte versuchen Sie es erneut.')));
  }
}

load();
