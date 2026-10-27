'use strict';

const app = document.querySelector('#app');
const state = { boot: null, filter: 'alle', listing: '', week: '', error: '' };

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

function product() {
  return state.boot?.product || 'Erstantwort';
}

function route() {
  const raw = (location.hash || '#/anfragen').slice(1);
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  const parts = path.split('/').filter(Boolean);
  return { parts, params };
}

function currentInitData() {
  const sdk = window.Telegram && window.Telegram.WebApp;
  if (sdk && sdk.initData) return sdk.initData;
  return (state.launch && state.launch.initData) || '';
}

function captureLaunch() {
  const hash = location.hash || '';
  const sdk = window.Telegram && window.Telegram.WebApp;
  const launch = (window.tgLaunch || { resolveInitData: () => ({ initData: '', startParam: '' }) }).resolveInitData({
    sdkInitData: sdk && sdk.initData,
    hash,
  });
  state.launch = launch;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body.startsWith('tgWebApp')) return;
  const start = launch.startParam || '';
  state.openedStart = Boolean(start);
  const next = start ? `#/anfragen/${start}` : '#/objekte';
  if (location.hash !== next) {
    state.launchNavigated = true;
    location.replace(next);
  }
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  const initData = currentInitData();
  if (initData) headers.Authorization = `tma ${initData}`;
  if (options.body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { ...options, headers, cache: 'no-store' });
  } catch {
    const err = new Error('offline');
    err.code = 'offline';
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || json.error_code || 'Fehler');
    err.code = json.error_code || String(res.status);
    err.status = res.status;
    throw err;
  }
  return json;
}

function photo(badge) {
  return h('div', { class: 'photo' }, h('span', { class: 'badge' }, badge || 'Autopilot aktiv'));
}

function initials(name) {
  const parts = String(name || '').replace(/\./g, '').split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MK';
}

function toast(message) {
  document.querySelectorAll('.toast').forEach((node) => node.remove());
  const node = h('div', { class: 'toast' }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 2500);
}

function nav(active) {
  const item = (id, label) => h('button', {
    class: active === id ? 'active' : '',
    type: 'button',
    onclick: () => { location.hash = `#/${id}`; },
  }, label);
  return h('nav', { class: 'nav' }, item('objekte', 'Objekte'), item('anfragen', 'Anfragen'), item('besichtigungen', 'Besichtigungen'));
}

function shell(active, ...nodes) {
  app.replaceChildren(
    state.boot?.banner ? h('p', { class: 'banner' }, state.boot.banner) : '',
    ...nodes,
    nav(active),
  );
}

function skeleton() {
  app.replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
}

function fail(err) {
  const offline = err.code === 'offline';
  const denied = err.status === 401 || err.status === 403;
  app.replaceChildren(h('section', { class: 'card' },
    h('h1', {}, denied ? 'Kein Zugriff' : offline ? 'Offline' : 'Fehler'),
    h('p', {}, denied
      ? 'Diese App ist nur für das Maklerbüro freigeschaltet.'
      : offline
        ? 'Keine Verbindung. Änderungen werden nicht gespeichert.'
        : 'Daten konnten nicht geladen werden.'),
    denied ? '' : h('button', { class: 'btn', type: 'button', onclick: () => render() }, 'Erneut versuchen'),
  ));
}

async function showObjekte() {
  const data = await api('/v1/ui/objekte');
  if (!data.objekte.length) {
    shell('objekte', h('p', { class: 'card' }, 'Noch keine Objekte. Objektdaten pflegen Sie in Ihrer Tabelle „Objekte". Wir übernehmen sie automatisch.'));
    return;
  }
  const [first, ...rest] = data.objekte;
  shell('objekte',
    h('article', { class: 'card' },
      h('div', { class: 'top' }, h('div', { class: 'logo' }, product()), h('span', { class: 'muted' }, initials(state.boot?.makler_name))),
      h('h1', {}, 'Objekte'),
      h('p', { class: 'sub' }, state.boot?.city || 'Ihr Katalog'),
      photo(first.badge),
      h('div', { class: 'price' }, first.price_label),
      h('h2', {}, first.title),
      h('p', { class: 'muted' }, first.meta),
      h('p', {}, first.info),
      h('button', { class: 'btn-dark', type: 'button', onclick: () => { location.hash = `#/anfragen?listing=${first.portal_listing_id}`; } }, 'Anfragen ansehen'),
      h('button', { class: 'btn', type: 'button', onclick: () => { location.hash = `#/objekte/${first.portal_listing_id}`; } }, `${first.question_count} Fragen im Interessenten-Fragebogen`),
    ),
    ...rest.map((objekt) => h('article', { class: 'card' },
      photo('Demo'),
      h('h2', {}, objekt.title),
      h('p', { class: 'muted' }, `${objekt.meta} · ${objekt.price_label}`),
      h('button', { class: 'btn', type: 'button', onclick: () => { location.hash = `#/objekte/${objekt.portal_listing_id}`; } }, 'Objektdaten'),
    )),
  );
}

async function showObjekt(id) {
  const data = await api(`/v1/ui/objekte/${id}`);
  const objekt = data.objekt;
  const rows = [
    ['ImmoScout24-ID', objekt.portal_listing_id],
    ['Kaltmiete', objekt.kaltmiete_eur ? `${objekt.kaltmiete_eur} €` : ''],
    ['Warmmiete', objekt.warmmiete_eur ? `${objekt.warmmiete_eur} €` : ''],
    ['Kaufpreis', objekt.price_eur ? `${objekt.price_eur} €` : ''],
    ['Stellplatz', objekt.stellplatz_text],
    ['Provision', objekt.provision_text],
    ['Nebenkosten / Hausgeld', objekt.nebenkosten_hausgeld_text],
    ['Energieausweis', objekt.energieausweis_text],
    ['Verfügbar ab', objekt.verfuegbar_ab_text],
    ['Haustiere', objekt.haustiere_text],
    ['Zustand', objekt.zustand_text],
    ['Besichtigungen', objekt.booking_mode],
    ['Treffpunkt', objekt.viewing_location],
  ].filter(([, value]) => value);
  shell('objekte',
    h('button', { class: 'back', type: 'button', onclick: () => { location.hash = '#/objekte'; } }, '‹ Objekte'),
    h('article', { class: 'card' },
      h('span', { class: 'badge' }, 'Demo'),
      h('h1', {}, 'Objektdaten'),
      h('p', { class: 'muted' }, objekt.hint),
      ...rows.map(([label, value]) => h('p', {}, h('b', {}, `${label}: `), value)),
      h('h2', {}, 'Fragebogen für dieses Objekt'),
      h('p', {}, `${objekt.question_count} Fragen aktiv`),
      ...(objekt.schema?.steps || []).flatMap((step) => step.fields.map((field) => h('p', { class: 'muted' }, field.label))),
      h('button', { class: 'btn', type: 'button', onclick: () => { location.hash = `#/anfragen?listing=${objekt.portal_listing_id}`; } }, 'Vorschau für Interessenten'),
    ),
  );
}

function metricTile(label, value) {
  return h('div', { class: 'metric' }, h('span', { class: 'muted' }, label), h('b', {}, value));
}

async function showAnfragen() {
  const { params } = route();
  state.listing = params.get('listing') || '';
  const [list, numbers] = await Promise.all([
    api(`/v1/ui/leads?chip=${encodeURIComponent(state.filter)}&listing=${encodeURIComponent(state.listing)}`),
    api('/v1/ui/metrics?days=7'),
  ]);
  const chipLabel = {
    alle: 'Alle',
    hot: 'HOT',
    warm: 'WARM',
    cold: 'COLD',
    freigabe: 'Freigabe nötig',
    pruefung: 'Prüfung nötig',
    eigentuemer: 'Eigentümer',
    interessent: 'Interessent',
  };
  const chips = ['alle', 'HOT', 'WARM', 'COLD', 'eigentuemer', 'interessent', 'freigabe', 'pruefung'].map((id) => h('button', {
    type: 'button',
    class: state.filter === id.toLowerCase() ? 'on' : '',
    onclick: () => { state.filter = id.toLowerCase(); showAnfragen().catch(fail); },
  }, chipLabel[id.toLowerCase()] || id));
  const hours = numbers.eingesparte_stunden == null
    ? '—'
    : new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(numbers.eingesparte_stunden);
  const cards = list.leads.map((lead) => h('button', {
    class: 'card lead',
    type: 'button',
    onclick: () => { location.hash = `#/anfragen/${lead.lead_id}`; },
  },
    h('div', { class: 'row' }, h('span', { class: `grade ${lead.grade}` }, `${lead.grade} ${lead.score}`), h('span', { class: 'muted' }, lead.status_label)),
    h('strong', {}, lead.display_name),
    h('div', {}, lead.lead_kind === 'eigentuemer'
      ? `Eigentümer · ${lead.listing_title}`
      : `${lead.listing_title} · ${lead.inquiry_type === 'kauf' ? 'Kauf' : 'Miete'}`),
    h('p', { class: 'reasons' }, lead.reasons.join(' · ')),
    lead.fragebogen_status === 'submitted' ? h('span', { class: 'chip' }, 'Fragebogen ausgefüllt') : '',
    lead.injection_suspected ? h('span', { class: 'chip' }, '⚠ Prompt-Injection-Verdacht') : '',
  ));
  shell('anfragen',
    h('div', { class: 'top' }, h('div', { class: 'logo' }, product()), h('span', { class: 'muted' }, state.boot?.mode_label || '')),
    h('h1', {}, 'Anfragen'),
    h('div', { class: 'card metrics' },
      metricTile('Anfragen', String(numbers.anfragen)),
      metricTile('Antwort ≤ 5 Min.', numbers.sla_label || (numbers.sla_percent == null ? '—' : `${numbers.sla_percent} %`)),
      metricTile('Termine', String(numbers.termine)),
      metricTile('Eingesparte Stunden · Schätzung', hours),
    ),
    h('p', { class: 'muted' }, numbers.formula),
    h('div', { class: 'chips' }, chips),
    ...(cards.length ? cards : [h('p', { class: 'card' }, state.filter === 'alle' && !state.listing
      ? 'Noch keine Anfragen. Sobald eine ImmoScout24-Anfrage in Ihrem Postfach eingeht, erscheint sie hier.'
      : 'Keine Anfragen mit diesem Filter.')]),
    h('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/einstellungen'; } }, 'Minuten für die Schätzung'),
  );
}

function confirmBox(text, onYes) {
  const modal = h('div', { class: 'modal' }, h('div', { class: 'card' },
    h('p', {}, text),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onclick: () => modal.remove() }, 'Abbrechen'),
      h('button', { class: 'btn-dark', type: 'button', onclick: () => { modal.remove(); onYes(); } }, 'Senden'),
    ),
  ));
  document.body.append(modal);
}

async function showLead(id) {
  const data = await api(`/v1/ui/leads/${id}`);
  const lead = data.lead;
  async function post(action, extra) {
    const key = `${action}-${lead.lead_id}-${Date.now()}`;
    const result = await api(`/v1/ui/leads/${lead.lead_id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(extra || {}),
      headers: { 'Idempotency-Key': key },
    });
    toast(result.message || 'Gespeichert.');
    render();
  }
  const actions = [];
  if (!lead.optout && lead.reply_status === 'pending_approval') {
    actions.push(h('button', {
      class: 'btn-dark',
      type: 'button',
      onclick: () => confirmBox(`Antwort jetzt an ${lead.display_name} senden? Die Nachricht beginnt mit dem KI-Hinweis.`, () => post('approve').catch(fail)),
    }, 'Antwort freigeben'));
    actions.push(h('button', { class: 'btn', type: 'button', onclick: () => post('reject').catch(fail) }, 'Ablehnen'));
  }
  if (!lead.optout) {
    actions.push(h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => confirmBox(`Automatik für diesen ${lead.lead_kind === 'eigentuemer' ? 'Eigentümer' : 'Interessenten'} beenden? Es werden keine automatischen Nachrichten mehr gesendet. Sie können weiter persönlich schreiben.`, () => post('stop').catch(fail)),
    }, 'STOP'));
  }
  if (lead.reply_status === 'needs_human' && lead.email) {
    actions.push(h('a', { class: 'btn', href: `mailto:${lead.email}` }, 'Selbst antworten'));
  }
  const status = h('select', {
    onchange: (event) => post('status', { pipeline_status: event.target.value }).catch(fail),
  }, ...['neu', 'kontaktiert', 'termin', 'abgeschlossen', 'verworfen'].map((value) => {
    const option = h('option', { value }, value);
    if (value === lead.pipeline_status) option.selected = true;
    return option;
  }));
  shell('anfragen',
    h('button', { class: 'back', type: 'button', onclick: () => { location.hash = '#/anfragen'; } }, '‹ Anfragen'),
    h('article', { class: 'card' },
      h('span', { class: `grade ${lead.grade}` }, `${lead.grade} ${lead.score}`),
      h('h1', {}, lead.full_name),
      h('p', {}, lead.listing_title),
      h('p', { class: 'muted' }, `Eingang: ${lead.eingang_label}${lead.source_label ? ` · ${lead.source_label}` : ''}`),
      h('p', {}, lead.lead_kind === 'eigentuemer' ? lead.kind_label : (lead.inquiry_type === 'kauf' ? 'Kauf' : 'Miete')),
      lead.lead_kind === 'eigentuemer' ? h('p', {}, [lead.object_label, lead.area_label].filter(Boolean).join(' · ')) : '',
      lead.lead_kind === 'eigentuemer' && lead.source_label ? h('p', { class: 'muted' }, lead.source_label) : '',
      h('p', {}, lead.email),
      h('p', {}, lead.phone),
      lead.optout ? h('p', {}, 'Der Interessent hat widersprochen (STOP). Bitte nur noch persönlich antworten.') : '',
      lead.waiting_label ? h('p', {}, lead.waiting_label) : '',
      data.objekt_missing ? h('p', {}, `Objekt ${lead.portal_listing_id} fehlt in Ihren Objektdaten – Antworten enthalten keine Objektfakten.`) : '',
    ),
    h('article', { class: 'card' },
      h('h2', {}, 'Einstufung'),
      ...(lead.signals || []).filter((row) => row.reason).map((row) => h('p', {}, `${row.reason} ${row.points > 0 ? `+${row.points}` : row.points}`)),
      lead.missing_labels?.length ? h('p', {}, `Fehlende Angaben: ${lead.missing_labels.join(', ')}`) : '',
      lead.urgency_label ? h('p', {}, lead.urgency_label) : '',
      lead.valuation_label ? h('p', {}, lead.valuation_label) : '',
      lead.offered_slots?.length ? h('p', {}, `Terminvorschläge: ${lead.offered_slots.join(' · ')}`) : '',
      lead.fragebogen_status === 'submitted'
        ? h('p', {}, lead.grade_changed
          ? `Fragebogen: ausgefüllt · Änderung: ${lead.grade_before} ${lead.score_before} → ${lead.grade} ${lead.score}`
          : 'Fragebogen: ausgefüllt')
        : '',
      ...(lead.abweichungen || []).map((line) => h('p', {}, line)),
      h('p', { class: 'muted' }, lead.lead_kind === 'eigentuemer' ? (state.boot?.grade_hint_owner || '') : (state.boot?.grade_hint || '')),
    ),
    h('article', { class: 'card' },
      h('h2', {}, 'Verlauf'),
      h('h3', {}, 'Anfrage (ImmoScout24)'),
      h('p', {}, lead.excerpt),
      h('p', { class: 'muted' }, lead.excerpt_note),
      lead.draft_text ? h('h3', {}, lead.reply_status === 'pending_approval' ? 'Entwurf' : 'Gesendete Antwort') : '',
      lead.draft_text && lead.reply_status === 'pending_approval'
        ? draftEditor(lead, post)
        : (lead.draft_text ? h('pre', { class: 'pre' }, lead.draft_text) : ''),
      lead.lead_reply ? h('h3', {}, 'Antwort des Interessenten') : '',
      lead.lead_reply ? h('p', {}, `${lead.lead_reply}${lead.booked_slot ? ` → Termin gebucht: ${lead.booked_slot}` : ''}`) : '',
    ),
    h('article', { class: 'card' },
      h('h2', {}, 'Aktionen'),
      ...actions,
      h('label', {}, 'Status ändern'),
      status,
      state.boot?.sheet_url ? h('a', { href: state.boot.sheet_url }, 'Im CRM öffnen') : h('p', { class: 'muted' }, 'Ihr CRM (Demo)'),
    ),
  );
}

function draftEditor(lead, post) {
  const box = h('textarea', { class: 'draft' }, lead.draft_text);
  return h('div', {},
    box,
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => post('draft', { text: box.value }).catch(fail),
    }, 'Entwurf speichern'),
    h('p', { class: 'muted' }, 'KI-Hinweis und STOP bleiben im Text. Sonst lässt sich der Entwurf nicht speichern.'),
  );
}

async function showWeek() {
  const data = await api(`/v1/ui/bookings${state.week ? `?week=${state.week}` : ''}`);
  async function attend(id, attendance) {
    await api(`/v1/ui/bookings/${id}/attendance`, { method: 'POST', body: JSON.stringify({ attendance }) });
    showWeek().catch(fail);
  }
  shell('besichtigungen',
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => shiftWeek(data.week, -1) }, '‹'),
      h('h1', {}, data.title),
      h('button', { class: 'btn', type: 'button', onclick: () => shiftWeek(data.week, 1) }, '›'),
    ),
    data.empty ? h('p', { class: 'card' }, 'Diese Woche keine Besichtigungen.') : '',
    ...data.days.filter((day) => day.items.length).map((day) => h('section', {},
      h('h2', {}, day.label),
      ...day.items.map((item) => h('article', { class: 'card' },
        h('span', { class: 'chip' }, item.kind_label || 'Besichtigung'),
        h('strong', {}, `${item.time} · ${item.title}`),
        h('p', {}, `${item.name} · ${item.status}`),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', type: 'button', onclick: () => attend(item.id, 'erschienen').catch(fail) }, 'Erschienen'),
          h('button', { class: 'btn', type: 'button', onclick: () => attend(item.id, 'nicht_erschienen').catch(fail) }, 'Nicht erschienen'),
          h('button', { class: 'btn', type: 'button', onclick: () => offerMove(item).catch(fail) }, 'Verschieben'),
        ),
        h('div', { id: `move-${item.id}` }),
        item.attendance ? h('p', {}, item.attendance) : '',
        h('p', { class: 'muted' }, 'Nur Statistik. Fließt nicht in die Einstufung ein.'),
      )),
    )),
    h('p', { class: 'muted' }, data.note),
  );
}

async function offerMove(item) {
  const host = document.getElementById(`move-${item.id}`);
  if (!host) return;
  const data = await api(`/v1/ui/bookings/${encodeURIComponent(item.id)}/options`);
  const slots = data.slots || [];
  host.replaceChildren(
    h('p', { class: 'muted' }, 'Neuen Termin wählen. Es wird keine E-Mail gesendet.'),
    slots.length ? '' : h('p', {}, 'Diese Woche ist kein anderes Fenster frei.'),
    ...slots.map((slot) => h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => api(`/v1/ui/bookings/${encodeURIComponent(item.id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ start: slot.start }),
      }).then((result) => {
        toast(result.message || 'Termin verschoben.');
        showWeek().catch(fail);
      }).catch(fail),
    }, slot.label)),
  );
}

function shiftWeek(week, delta) {
  const match = /^(\d{4})-W(\d{2})$/.exec(week || '');
  if (!match) return;
  const date = new Date(Date.UTC(Number(match[1]), 0, 1 + (Number(match[2]) - 1) * 7));
  date.setUTCDate(date.getUTCDate() + delta * 7);
  const oneJan = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - oneJan) / 86400000) + oneJan.getUTCDay() + 1) / 7);
  state.week = `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  showWeek().catch(fail);
}

async function showSettings() {
  const data = await api('/v1/ui/settings');
  const reply = h('input', { type: 'number', min: '1', max: '120', value: String(data.minutes_per_reply) });
  const booking = h('input', { type: 'number', min: '1', max: '120', value: String(data.minutes_per_booking) });
  shell('anfragen',
    h('h1', {}, 'Einstellungen'),
    h('article', { class: 'card' },
      h('p', {}, data.send_mode === 'auto' ? 'Modus: Automatik' : 'Modus: Freigabe'),
      h('p', {}, `Löschfrist: ${data.retention_days} Tage`),
      h('p', { class: 'muted' }, 'Der Modus wird nur in der Umgebung geändert, nicht hier.'),
      h('label', {}, 'Minuten pro manueller Erstantwort (Schätzung)'),
      reply,
      h('label', {}, 'Minuten pro Terminabstimmung (Schätzung)'),
      booking,
      h('button', {
        class: 'btn-dark',
        type: 'button',
        onclick: () => api('/v1/ui/settings', {
          method: 'POST',
          body: JSON.stringify({ minutes_per_reply: Number(reply.value), minutes_per_booking: Number(booking.value) }),
        }).then(() => { location.hash = '#/anfragen'; }).catch(fail),
      }, 'Speichern'),
    ),
  );
}

async function render() {
  skeleton();
  try {
    if (!state.boot) state.boot = await api('/v1/ui/bootstrap');
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.ready) {
      tg.ready();
      if (tg.expand) tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor('#FFFFFF');
    }
    const start = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param)
      || (state.launch && state.launch.startParam)
      || '';
    if (start && !state.openedStart) {
      state.openedStart = true;
      location.hash = `#/anfragen/${start}`;
    }
    const { parts } = route();
    if (parts[0] === 'objekte' && parts[1]) return showObjekt(parts[1]);
    if (parts[0] === 'objekte') return showObjekte();
    if (parts[0] === 'anfragen' && parts[1]) return showLead(parts[1]);
    if (parts[0] === 'besichtigungen') return showWeek();
    if (parts[0] === 'einstellungen') return showSettings();
    return showAnfragen();
  } catch (err) {
    fail(err);
  }
}

captureLaunch();
window.addEventListener('hashchange', () => { render(); });
if (!location.hash) location.hash = '#/objekte';
if (!state.launchNavigated) render();
