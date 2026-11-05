'use strict';

const app = document.getElementById('app');
const query = new URLSearchParams(location.search);
const state = {
  lang: query.get('lang') === 'ru' || query.get('lang') === 'en' ? query.get('lang') : (localStorage.getItem('intl-lang') || 'en'),
  screen: 'inbox',
  leadId: '',
  dict: {},
  settings: {},
  tma: '',
  filter: 'ALL',
  sheet: query.get('sheet') === '1',
  draftText: '',
  option: null,
  manual: false,
  slotIds: [],
  ephemeral: false,
  propertyId: '',
  dayKey: '',
  addProperty: false,
  ask: null,
  notice: '',
  serverSettings: null,
  loadedLead: '',
  loadedStatus: '',
  picker: false,
  attachments: [],
  editProperty: null,
};
if (query.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

const ICO = {
  wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.3 14.8l-.3-.2-2.7.7.7-2.6-.2-.3A8 8 0 0 1 12 4zm-3 3.5c-.3 0-.6.2-.8.5-.3.4-.8 1-.8 2.1s.8 2.3.9 2.4c.1.2 1.6 2.6 4 3.5 2 .8 2.4.6 2.8.6.5 0 1.4-.6 1.6-1.2.2-.6.2-1.1.1-1.2-.1-.1-.3-.2-.6-.3l-1.6-.8c-.2-.1-.4-.1-.6.1l-.7.9c-.1.2-.3.2-.6.1-.9-.4-1.7-1-2.4-2-.1-.2 0-.3.1-.4l.4-.5.2-.4c0-.1 0-.3 0-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.5 3.2 2.8 10.4c-.8.3-.8 1.4 0 1.7l4.6 1.5 1.8 5.6c.2.7 1 .9 1.5.4l2.6-2.4 4.8 3.5c.6.4 1.4.1 1.6-.6l3.1-15.3c.2-.9-.7-1.6-1.4-1.3zM9.8 14 17.5 8l-6.1 6.7-.3 3.2z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9H3z"/><path d="M9 20v-6h6v6"/></svg>',
  start: '<svg viewBox="0 0 24 24"><path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.6-4.9-2.6-4.9 2.6.9-5.6-4-3.9 5.6-.8z"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M3 7h18v12H3z"/><path d="M3 7l2.5-3h13L21 7"/><path d="M10 12h4"/></svg>',
};

function captureLaunch() {
  const hash = location.hash || '';
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get('tma') || '';
  const match = hash.match(/tgWebAppData=([^&]+)/);
  const raw = fromQuery || (match ? decodeURIComponent(match[1]) : '');
  if (raw) {
    state.tma = raw;
    sessionStorage.setItem('intl-tma', raw);
  } else {
    state.tma = sessionStorage.getItem('intl-tma') || '';
  }
  const path = hash.replace(/^#\/?/, '').split('?')[0];
  const [screen, id] = path.split('/');
  if (screen === 'lead' && id) {
    const nextId = decodeURIComponent(id);
    if (state.leadId !== nextId) {
      state.loadedLead = '';
      state.loadedStatus = '';
    }
    state.screen = 'lead';
    state.leadId = nextId;
  } else if (['inbox', 'viewings', 'properties', 'setup', 'simulator', 'digest', 'archive'].includes(screen)) {
    state.screen = screen;
    state.loadedLead = '';
    state.loadedStatus = '';
  }
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function t(key) { return state.dict[key] || key; }
function fill(key, vars) {
  const bag = vars && typeof vars === 'object' ? vars : { n: vars };
  return t(key).replace(/\{(\w+)\}/g, (all, name) => (bag[name] == null ? all : String(bag[name])));
}

const NOTE = {
  en: {
    ai: 'AI-assisted message. Reply STOP to opt out.',
    stop: 'Reply STOP to opt out.',
  },
  ru: {
    ai: 'Сообщение подготовлено с помощью ИИ. Напишите STOP, чтобы отписаться.',
    stop: 'Напишите STOP, чтобы отписаться.',
  },
};

const TIMING_RU = {
  today: 'сегодня',
  tomorrow: 'завтра',
  weekend: 'на выходных',
  'this week': 'на этой неделе',
  Monday: 'понедельник',
  Tuesday: 'вторник',
  Wednesday: 'среда',
  Thursday: 'четверг',
  Friday: 'пятница',
  Saturday: 'суббота',
  Sunday: 'воскресенье',
  'long stay': 'длительное проживание',
  'stay length': 'срок аренды',
};

const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD_RU = { Sun: 'вс', Mon: 'пн', Tue: 'вт', Wed: 'ср', Thu: 'чт', Fri: 'пт', Sat: 'сб' };

function intentLabel(intent) {
  const map = {
    viewing: 'intentViewing', price: 'intentPrice', finance: 'intentFinance', docs: 'intentDocs',
    area: 'intentArea', avail: 'intentAvail', details: 'intentDetails', unclear: 'intentUnclear', stop: 'intentStop',
  };
  return t(map[intent] || 'notStated');
}

function periodLabel(period) {
  if (period === 'year') return t('perYear');
  if (period === 'month') return t('perMonth');
  if (period === 'total') return t('perTotal');
  return period || '';
}

function kindLabel(kind) { return kind === 'sale' ? t('sale') : t('rent'); }

function budgetText(lead) {
  if (lead.budget_amount == null) return t('notStated');
  const money = `${lead.budget_amount} ${lead.budget_currency || ''}`.trim();
  if (!lead.budget_period) return `${money} · ${t('periodUnclear')}`;
  return `${money} / ${periodLabel(lead.budget_period)}`;
}

async function report(err) {
  const el = document.getElementById('formError');
  const message = err.body?.error_code || err.message || 'failed';
  if (el) el.textContent = message;
  else fail(err);
}

function moneyLine(row) {
  return `${kindLabel(row.kind)}, ${row.currency} / ${periodLabel(row.period)}: ${row.sum}`;
}

async function api(pathname, options = {}) {
  const res = await fetch(pathname, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: state.tma ? `tma ${state.tma}` : '',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error_code || 'failed'), { status: res.status, body });
  return body;
}

function go(hash) {
  if (location.hash === hash) {
    boot().catch(fail);
    return;
  }
  location.hash = hash;
}

function draftPayload() {
  return {
    text: state.draftText,
    option_id: state.manual ? null : (state.option?.id || null),
    edited: true,
    slot_ids: state.slotIds || [],
    attachments: state.attachments || [],
  };
}

function errText(err) {
  return err.body?.error_code || err.message || 'failed';
}

function tabs(waiting) {
  const items = [
    { id: 'inbox', href: '#/inbox', icon: ICO.inbox, key: 'inbox' },
    { id: 'properties', href: '#/properties', icon: ICO.home, key: 'properties' },
    { id: 'viewings', href: '#/viewings', icon: ICO.cal, key: 'viewings' },
    { id: 'setup', href: '#/setup', icon: ICO.start, key: 'setup' },
  ];
  return `<nav class="tabs" aria-label="tabs">${items.map((item) => `<a href="${item.href}" class="${state.screen === item.id || (item.id === 'inbox' && state.screen === 'lead') ? 'on' : ''}">${item.icon}${esc(t(item.key))}${item.id === 'inbox' && waiting ? `<span class="bd">${waiting}</span>` : ''}</a>`).join('')}</nav>`;
}

function bar() {
  return `<div class="brandbar"><div class="brand"><i></i>Erstantwort</div><div class="tools"><div class="langsw"><button type="button" data-lang="en" class="${state.lang === 'en' ? 'on' : ''}">EN</button><button type="button" data-lang="ru" class="${state.lang === 'ru' ? 'on' : ''}">RU</button></div></div></div>`;
}

function shell(inner, waiting) {
  document.documentElement.lang = state.lang;
  app.classList.toggle('has-act', inner.includes('class="actbar"'));
  const reset = state.ephemeral ? `<p class="reset-banner">${esc(t('resets'))}</p>` : '';
  const demo = `<div class="demo" id="demoBanner">${esc(t('demoBar'))}</div>`;
  const note = state.notice ? `<p class="toast" role="status">${esc(state.notice)}</p>` : '';
  state.notice = '';
  const ask = state.ask ? `<div class="backdrop top" id="askBg"></div><div class="sheet confirm" role="dialog"><p>${esc(state.ask.message)}</p><div class="btnrow"><button class="btn sec" id="askNo" type="button">${esc(t('cancelView'))}</button><button class="btn" id="askYes" type="button">${esc(state.ask.yes || t('confirmView'))}</button></div></div>` : '';
  inner += ask;
  app.innerHTML = `${reset}${demo}${note}${inner}${tabs(waiting)}`;
  app.querySelectorAll('[data-lang]').forEach((button) => {
    button.onclick = () => {
      state.lang = button.dataset.lang;
      localStorage.setItem('intl-lang', state.lang);
      boot().catch(fail);
    };
  });
  const no = document.getElementById('askNo');
  if (no) no.onclick = () => { state.ask = null; boot().catch(fail); };
  const yes = document.getElementById('askYes');
  if (yes) yes.onclick = () => {
    const run = state.ask && state.ask.run;
    state.ask = null;
    Promise.resolve(run && run()).catch((err) => { state.notice = errText(err); boot().catch(fail); });
  };
  const askBg = document.getElementById('askBg');
  if (askBg) askBg.onclick = () => { state.ask = null; boot().catch(fail); };
}

function fail(err) {
  shell(`${bar()}<div class="card pad"><p>${esc(err.body?.message || err.message || 'Error')}</p></div>`, 0);
}

function channelChip(channel, iconOnly) {
  const wa = channel === 'wa_sim';
  const name = iconOnly ? '' : esc(wa ? t('whatsapp') : t('telegram'));
  return `<span class="ch ${wa ? 'wa' : 'tg'}">${wa ? ICO.wa : ICO.tg}${name}</span>`;
}

function mark(lead) {
  return lead.readiness || lead.grade || 'COLD';
}

function statusLabel(lead) {
  if (lead.status === 'archived') return t('archiveTitle');
  if (lead.status === 'pending_approval') return t('needsOk');
  if (lead.status === 'review') return t('needsReview');
  if (lead.status === 'stopped') return t('optedOut');
  if (lead.pipeline === 'viewing') return t('viewingBooked');
  return t('replied');
}

function timingText(lead) {
  const label = lead.timing_label || '';
  if (!lead.timing_class && !label) return t('notStated');
  if (state.lang === 'ru') {
    if (TIMING_RU[label]) return TIMING_RU[label];
    const within = String(label).match(/within (\d+) months?/);
    if (within) return `в течение ${within[1]} мес.`;
    const words = { concrete: 'конкретный срок', months_le3: 'в течение 3 месяцев', other: 'другой срок' };
    return words[lead.timing_class] || t('notStated');
  }
  if (label) return label;
  const words = { concrete: 'a specific time', months_le3: 'within 3 months', other: 'another time' };
  return words[lead.timing_class] || t('notStated');
}

function clock(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(state.lang === 'ru' ? 'ru-RU' : 'en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Dubai',
  }).format(new Date(iso));
}

function headDate() {
  return new Intl.DateTimeFormat(state.lang === 'ru' ? 'ru-RU' : 'en-GB', {
    timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date()).replace(/[.,]/g, '');
}

function place(title) {
  const text = String(title || '');
  const cut = text.split(',').slice(1).join(',').trim();
  return cut || text;
}

function propertyTitle(properties, id) {
  return place((properties.find((row) => row.id === id) || {}).title || id || '');
}

function zoned(iso, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'Asia/Dubai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { ...parts, key: `${parts.year}-${parts.month}-${parts.day}` };
}

function utcDate(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoWeek(key) {
  const date = utcDate(key);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

async function refreshBadge() {
  const list = await api('/v1/intl/leads');
  state.leadRows = list.leads || [];
  state.badge = state.leadRows.filter((lead) => lead.status === 'pending_approval' || lead.status === 'review').length;
  return state.badge;
}

async function showInbox() {
  const [list, digest, props] = await Promise.all([api('/v1/intl/leads'), api('/v1/intl/digest'), api('/v1/intl/properties')]);
  const leads = list.leads || [];
  const waiting = leads.filter((lead) => lead.status === 'pending_approval' || lead.status === 'review');
  const rest = leads.filter((lead) => lead.status !== 'pending_approval' && lead.status !== 'review');
  const match = (lead) => (state.filter === 'ALL' || mark(lead) === state.filter) && (!state.propertyId || lead.property_id === state.propertyId);
  const shownWait = waiting.filter(match);
  const shownDone = rest.filter(match);
  const pending = leads.filter((lead) => lead.status === 'pending_approval');
  state.badge = waiting.length;
  state.leadRows = leads;
  const value = (digest.listed_value || []).map(moneyLine).join(' · ');
  const row = (lead) => `<a class="item chev" href="#/lead/${esc(lead.id)}"><span class="dot ${esc(mark(lead))}"></span>
    <div class="main"><div class="t"><bdi dir="auto">${esc(lead.clean_name || lead.sender_name || lead.id)}</bdi> <span class="g ${esc(mark(lead))}">${esc(mark(lead))}</span></div>
    <div class="s">${channelChip(lead.channel, true)} · ${esc(propertyTitle(props.properties, lead.property_id))}</div></div>
    <div class="r"><b class="${lead.status === 'pending_approval' || lead.status === 'review' ? 'need' : ''}">${esc(statusLabel(lead))}</b>${esc(clock(lead.first_msg_at))}</div></a>`;
  const propName = state.propertyId ? propertyTitle(props.properties, state.propertyId) : '';
  shell(`${bar()}
    <div class="hd"><div class="hd-row"><h1>${esc(t('inbox'))}</h1><a class="archive-btn" id="openArchive" href="#/archive">${ICO.box}<span>${esc(t('archive'))}</span></a></div><p>${esc(headDate())} · ${esc(fill('leadsLine', leads.length))} <span class="demotag">${esc(t('demoTag'))}</span></p></div>
    <div class="stats"><div><b>${leads.length}</b>${esc(t('leadsTile'))}</div><div><b>${pending.length}</b>${esc(t('toApprove'))}</div></div>
    ${pending.length ? `<a class="btn queuebtn" href="#/lead/${esc(pending[0].id)}">${esc(fill('reviewN', pending.length))}</a>` : ''}
    <button class="btn sec queuebtn" id="openDigest" type="button">${esc(t('digestOpen'))}</button>
    <div class="seg">${['ALL', 'HOT', 'WARM', 'COLD'].map((grade) => `<button type="button" data-f="${grade}" class="${state.filter === grade ? 'on' : ''}">${grade === 'ALL' ? esc(t('all')) : grade}</button>`).join('')}</div>
    ${propName ? `<p class="foot">${esc(t('filterProperty'))}: ${esc(propName)} <button class="link inline" id="clearProp" type="button">${esc(t('clearFilter'))}</button></p>` : ''}
    ${shownWait.length ? `<div class="sh"><span>${esc(t('waiting'))} · ${shownWait.length}</span></div><div class="card">${shownWait.map(row).join('')}</div>` : ''}
    ${shownDone.length ? `<div class="sh"><span>${esc(t('done'))} · ${shownDone.length}</span></div><div class="card">${shownDone.map(row).join('')}</div>` : ''}
    ${!shownWait.length && !shownDone.length ? `<p class="foot">${esc(t('filterEmpty'))}</p>` : ''}
    ${value ? `<p class="foot">${esc(t('listed'))}: ${esc(value)}. ${esc(t('notRevenue'))}</p>` : ''}
    <p class="foot">${esc(t('scoreNote'))}</p>`, waiting.length);
  app.querySelectorAll('[data-f]').forEach((button) => {
    button.onclick = () => { state.filter = button.dataset.f; showInbox().catch(fail); };
  });
  const openDigest = document.getElementById('openDigest');
  if (openDigest) openDigest.onclick = () => go('#/digest');
  const clearProp = document.getElementById('clearProp');
  if (clearProp) clearProp.onclick = () => { state.propertyId = ''; showInbox().catch(fail); };
}

function hydrateLead(lead) {
  const options = lead.options || [];
  const draft = lead.draft;
  let slotIds = [];
  if (draft && draft.slot_ids) {
    try {
      const parsed = JSON.parse(draft.slot_ids);
      slotIds = Array.isArray(parsed) ? parsed : [];
    } catch { slotIds = []; }
  }
  if (draft && String(draft.text || '').trim()) {
    state.draftText = draft.text;
    state.slotIds = slotIds;
    state.manual = draft.option_id == null;
    state.option = options.find((row) => row.id === draft.option_id) || (draft.option_id == null ? { id: null, text: draft.text } : null);
  } else {
    state.option = options[0] || null;
    state.draftText = state.option ? state.option.text : '';
    state.slotIds = [...(state.option?.slot_ids || [])];
    state.manual = lead.status === 'review';
  }
  state.attachments = attachmentList(draft, state.option);
  state.sheet = query.get('sheet') === '1';
}

async function showLead() {
  const [data, badge] = await Promise.all([
    api(`/v1/intl/leads/${encodeURIComponent(state.leadId)}`),
    refreshBadge(),
  ]);
  const lead = data.lead;
  if (state.loadedLead !== lead.id || state.loadedStatus !== lead.status) {
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    state.fileUrl = '';
    hydrateLead(lead);
    state.loadedLead = lead.id;
    state.loadedStatus = lead.status;
  }
  const stopped = lead.status === 'stopped';
  const review = lead.status === 'review';
  const editable = lead.status === 'pending_approval' || lead.status === 'review';
  const options = editable ? (lead.options || []) : [];
  const slots = editable ? (lead.slots || []) : [];
  const replyLang = lead.language === 'ru' ? 'ru' : 'en';
  const inbound = (lead.messages || []).filter((row) => row.direction === 'in').slice(-1)[0];
  const outbound = (lead.messages || []).filter((row) => row.direction === 'out' && row.text).slice(-1)[0];
  const shownOut = editable ? state.draftText : (outbound?.text || '');
  const note = NOTE[replyLang];
  const slotButtons = (attr) => slots.map((slot) => `<button class="tslot ${(state.slotIds || []).includes(slot.id) ? 'on' : ''}" type="button" ${attr}="${esc(slot.id)}">${esc(replyLang === 'ru' ? slot.label_ru : slot.label_en)}</button>`).join('');
  const sheet = state.sheet ? `<div class="backdrop" id="sheetBg"></div><div class="sheet" role="dialog"><div class="grab"></div>
    <div class="sheethd"><b>${esc(t('editReply'))}</b><button class="link" id="sheetDone" type="button">${esc(t('doneBtn'))}</button></div>
    <textarea id="ta" lang="${replyLang}">${esc(state.draftText || '')}</textarea>
    <p class="sheetsub">${esc(t('insertSlot'))}</p>
    <div class="chips">${slotButtons('data-slot')}</div>
    <p class="sheetai">${esc(t('sheetAi'))}</p>
    <p class="sheetai"><i>${esc(note.ai)}</i></p>
    <p class="sheetai">${esc(t('stopLineLabel'))}: <i>${esc(note.stop)}</i></p>
    <button class="btn sec sm" id="reset" type="button">${esc(t('returnOriginal'))}</button></div>` : '';
  const picker = state.picker ? pickerSheet(slots, replyLang, lead.property?.tz) : '';
  const proposedNote = lead.proposed
    ? `<p class="foot">${esc(lead.proposed.free ? t('clientTimeFree') : t('clientTimeBusy'))}: ${esc(replyLang === 'ru' ? lead.proposed.label_ru : lead.proposed.label_en)}</p>`
    : '';
  const attachName = { brochure: t('brochure'), plan: t('floorPlan'), link: t('linkPh') };
  const attachRow = (state.attachments || []).length
    ? `<div class="attach" id="attachList">${state.attachments.map((item) => `<button type="button" class="tslot" data-attach="${esc(item.kind)}" data-url="${esc(item.url)}">${esc(t('attached'))}: ${esc(attachName[item.kind] || item.name)}</button>`).join('')}</div>${state.fileUrl ? `<iframe id="filePreview" class="fileview" title="${esc(t('brochure'))}" src="${esc(state.fileUrl)}"></iframe>` : ''}`
    : '';
  const outBubble = shownOut
    ? `<div class="msg out${editable ? ' edit' : ''}" id="replyText"${editable ? ' contenteditable="true" role="textbox" spellcheck="true"' : ''}><bdi dir="auto">${esc(shownOut)}</bdi></div>${editable ? `<div class="msgcap"><button class="link" id="edit" type="button">${esc(t('editText'))}</button> <span>${esc(t('editInline'))}</span></div>` : ''}`
    : (editable ? `<button class="btn sec" id="edit" type="button">${esc(t('editText'))}</button>` : '');
  shell(`<a class="back" href="${lead.status === 'archived' ? '#/archive' : '#/inbox'}">‹ ${esc(lead.status === 'archived' ? t('archiveTitle') : t('inbox'))}</a>
    ${bar()}
    <div class="actbar"><div class="btnrow">
      <button class="btn sec" id="archive" type="button">${esc(t('archiveBtn'))}</button>
      <button class="btn go w2" id="send" type="button" ${stopped ? 'disabled' : ''}>${esc(t('send'))}</button>
    </div></div>
    <div class="card lh2 ${esc(mark(lead))}"><div><h1><bdi dir="auto">${esc(lead.clean_name || lead.sender_name || '')}</bdi> <span class="g ${esc(mark(lead))}">${esc(mark(lead))}</span></h1>
      <p>${channelChip(lead.channel)}<span>${esc(place(lead.property?.title || ''))}</span></p></div></div>
    <div class="thread"><div class="msg in"><bdi dir="auto">${esc(inbound?.text || '')}</bdi></div>
      ${outBubble}
      ${attachRow}
    </div>
    ${propertyBlurb(lead)}
    <div class="card smart">
      <div><span>${esc(t('wants'))}</span><b>${esc(intentLabel(lead.intent))}</b></div>
      <div><span>${esc(t('budget'))}</span><b>${esc(budgetText(lead))}</b>${(lead.flags || []).includes('budget_currency_assumed') ? `<small>${esc(t('budgetAssumed'))}</small>` : ''}</div>
      <div><span>${esc(t('timing'))}</span><b>${esc(timingText(lead))}</b></div>
      <div><span>${esc(t('language'))}</span><b>${esc(lead.language === 'ru' ? 'RU' : lead.language === 'en' ? 'EN' : t('intentUnclear'))}</b></div>
    </div>
    <div class="card pad"><div class="btnrow">
      <button class="btn sec" id="stop" type="button" ${stopped ? 'disabled' : ''}>${esc(t('stopBtn'))}</button>
      <button class="btn danger" id="erase" type="button">${esc(t('eraseBtn'))}</button>
    </div></div>
    ${stopped ? `<p class="foot">${esc(t('optedOut'))}</p>` : ''}
    ${lead.status === 'sent' ? `<p class="foot">${esc(t('sentSim'))}</p>` : ''}
    ${review ? `<p class="foot">${esc(t('notUnderstood'))}</p><button class="btn" id="manual" type="button">${esc(t('replyManually'))}</button>` : ''}
    ${lead.stale_sending ? `<p class="foot">${esc(t('stale'))}</p>` : ''}
    ${proposedNote}
    ${options.length ? `<div class="sh"><span>${esc(t('optsTitle'))}</span></div><div class="card opts">${options.map((row) => `<button class="opt ${state.option && state.option.id === row.id ? 'on' : ''}" type="button" data-opt="${esc(row.id)}"><b>${esc(state.lang === 'ru' ? row.label_ru : row.label_en)}</b><span>${esc(row.text)}</span></button>`).join('')}</div>` : ''}
    ${lead.calendar_error ? `<p class="foot" id="calendarError">${esc(t('calendarUnavailable'))}</p>` : ''}
    ${slots.length ? `<div class="sh"><span>${esc(t('slotsTitle'))}</span></div><div class="card slotcard"><p class="slothd">${esc(place(lead.property?.title || ''))}</p><div class="chips">${slotButtons('data-insert')}</div><button class="btn sec sm" id="openPicker" type="button">${esc(t('pickTime'))}</button></div><p class="foot">${esc(lead.calendar_mode === 'google' ? t('calendarGoogle') : t('calendarMock'))}</p><p class="foot">${esc(t('notReserved'))}</p>` : ''}
    ${picker}
    ${sheet}
    <p class="foot" id="formError" role="alert"></p>
    <p class="foot">${esc(t('scoreNote'))}</p>`, badge);
  const send = document.getElementById('send');
  if (send) send.disabled = !editable || !String(state.draftText || '').trim();
  app.querySelectorAll('[data-opt]').forEach((button) => {
    button.onclick = async () => {
      state.option = options.find((row) => row.id === button.dataset.opt);
      if (!state.option) return;
      state.draftText = state.option.text;
      state.slotIds = [...(state.option.slot_ids || [])];
      state.attachments = state.option.attachments || [];
      state.manual = false;
      state.sheet = false;
      if (state.option.id === 'other') state.picker = true;
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, { method: 'PUT', body: JSON.stringify(draftPayload()) });
      } catch (err) {
        state.notice = errText(err);
      }
      showLead().catch(fail);
    };
  });
  const edit = document.getElementById('edit');
  if (edit) edit.onclick = () => { state.sheet = true; showLead().catch(fail); };
  app.querySelectorAll('[data-insert]').forEach((button) => {
    button.onclick = async () => {
      insertProposal(lead, replyLang, button.dataset.insert);
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, { method: 'PUT', body: JSON.stringify(draftPayload()) });
      } catch (err) {
        state.notice = errText(err);
      }
      showLead().catch(fail);
    };
  });
  const manual = document.getElementById('manual');
  if (manual) manual.onclick = () => { state.option = { id: null, text: '' }; state.draftText = ''; state.slotIds = []; state.manual = true; state.sheet = true; showLead().catch(report); };
  const archive = document.getElementById('archive');
  if (archive) archive.onclick = async () => {
    try {
      await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/archive`, { method: 'POST', body: '{}' });
      state.sheet = false;
      state.picker = false;
      state.loadedLead = '';
      state.notice = t('archivedSim');
      go('#/inbox');
    } catch (err) {
      report(err);
    }
  };
  app.querySelectorAll('[data-attach]').forEach((button) => {
    button.onclick = () => showAttached(button.dataset.url, button.dataset.attach).catch((err) => { state.notice = errText(err); showLead().catch(fail); });
  });
  const openPicker = document.getElementById('openPicker');
  if (openPicker) openPicker.onclick = () => { state.picker = true; showLead().catch(fail); };
  app.querySelectorAll('[data-pick]').forEach((button) => {
    button.onclick = () => chooseSlot(lead, button.dataset.pick).catch((err) => { state.notice = errText(err); showLead().catch(fail); });
  });
  const pickerClose = document.getElementById('pickerClose');
  if (pickerClose) pickerClose.onclick = () => { state.picker = false; showLead().catch(fail); };
  const pickerBg = document.getElementById('pickerBg');
  if (pickerBg) pickerBg.onclick = () => { state.picker = false; showLead().catch(fail); };
  const stop = document.getElementById('stop');
  if (stop) stop.onclick = () => {
    if (stopped) return;
    state.sheet = false;
    state.ask = {
      message: t('stopHint'),
      yes: t('stopBtn'),
      run: async () => {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/stop`, { method: 'POST', body: '{}' });
        state.loadedLead = '';
        state.loadedStatus = '';
        state.notice = t('stopDone');
        showLead().catch(fail);
      },
    };
    showLead().catch(fail);
  };
  const erase = document.getElementById('erase');
  if (erase) erase.onclick = () => {
    state.sheet = false;
    state.ask = {
      message: t('eraseHint'),
      yes: t('eraseBtn'),
      run: async () => {
        const result = await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/erase`, { method: 'POST', body: '{}' });
        state.loadedLead = '';
        state.notice = result.optout_kept ? `${t('eraseDone')} ${t('eraseKept')}` : t('eraseDone');
        go('#/inbox');
      },
    };
    showLead().catch(fail);
  };
  wireSheet(lead, replyLang);
  wireInline(lead);
  if (send) send.onclick = () => {
    const bubble = document.getElementById('replyText');
    if (bubble && bubble.isContentEditable) state.draftText = bubble.innerText.trim();
    send.disabled = true;
    saveAndSend(lead).catch((err) => {
      state.notice = errText(err);
      showLead().catch(fail);
    });
  };
}

function attachmentList(draft, option) {
  if (draft && draft.attachments) {
    try {
      const parsed = JSON.parse(draft.attachments);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* use the selected option */ }
  }
  return (option && option.attachments) || [];
}

function propertyBlurb(lead) {
  const property = lead.property;
  if (!property || property.id === 'general') return '';
  const facts = property.facts || {};
  const rooms = property.bedrooms != null && property.bedrooms !== '' ? property.bedrooms : facts.bedrooms;
  const bits = [
    property.district,
    property.address,
    rooms != null && rooms !== '' ? `${rooms} ${state.lang === 'ru' ? 'комн.' : 'bd'}` : '',
    property.area_value ? `${property.area_value} ${property.area_unit || ''}`.trim() : '',
    state.lang === 'ru' ? (property.price_ru || '') : (property.price_en || ''),
  ].filter(Boolean);
  const why = ((lead.match && lead.match.reasons) || []).map((reason) => t(`match_${reason}`)).filter((label) => label && !label.startsWith('match_')).join(', ');
  return `<div class="card pad" id="propertyMatch"><b>${esc(property.title || '')}</b><p>${esc(bits.join(' · '))}</p>${why ? `<small>${esc(t('matchedBy'))}: ${esc(why)}</small>` : ''}</div>`;
}

async function showAttached(url, kind) {
  const headers = {};
  if (String(url || '').startsWith('/v1/') && !String(url).includes('/public/')) {
    headers.Authorization = state.tma ? `tma ${state.tma}` : '';
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw Object.assign(new Error('not_found'), { body: { error_code: 'not_found' } });
  const buf = await res.arrayBuffer();
  const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = URL.createObjectURL(new Blob([buf], { type }));
  state.notice = type === 'application/pdf' ? `${t('brochure')} PDF · ${buf.byteLength}` : `${t('attached')}: ${kind || 'file'}`;
  showLead().catch(fail);
}

function pickerSheet(slots, replyLang, tz) {
  const groups = new Map();
  for (const slot of slots) {
    const zone = zoned(slot.start_utc, tz || 'Asia/Dubai');
    if (!groups.has(zone.key)) groups.set(zone.key, { zone, list: [] });
    groups.get(zone.key).list.push(slot);
  }
  const days = [...groups.values()].sort((a, b) => a.zone.key.localeCompare(b.zone.key)).map(({ zone, list }) => {
    list.sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
    const times = list.map((slot) => {
      const time = zoned(slot.start_utc, tz || 'Asia/Dubai');
      return `<button class="tslot" type="button" data-pick="${esc(slot.id)}">${esc(`${time.hour}:${time.minute}`)}</button>`;
    }).join('');
    return `<div class="picker-day"><b>${esc(dayHeading(zone))}</b><div class="chips">${times}</div></div>`;
  }).join('');
  return `<div class="backdrop top" id="pickerBg"></div><div class="sheet picker" id="timePicker" role="dialog"><div class="grab"></div><div class="sheethd"><b>${esc(t('pickTime'))}</b><button class="link" id="pickerClose" type="button">${esc(t('doneBtn'))}</button></div>${days}</div>`;
}

async function chooseSlot(lead, slotId) {
  const result = await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/apply-slot`, {
    method: 'POST',
    body: JSON.stringify({ slot_id: slotId }),
  });
  state.draftText = result.text;
  state.slotIds = result.slot_ids || [slotId];
  state.picker = false;
  state.loadedLead = '';
  state.notice = t('pickedTime');
  await showLead();
}

function wireInline(lead) {
  const bubble = document.getElementById('replyText');
  if (!bubble || !bubble.isContentEditable) return;
  bubble.addEventListener('input', () => { state.draftText = bubble.innerText; });
  bubble.addEventListener('blur', () => {
    state.draftText = bubble.innerText.trim();
    api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, {
      method: 'PUT',
      body: JSON.stringify(draftPayload()),
    }).catch((err) => { state.notice = errText(err); });
  });
}

function insertProposal(lead, replyLang, slotId) {
  const slot = (lead.slots || []).find((row) => row.id === slotId);
  if (!slot) return;
  const line = replyLang === 'ru' ? slot.proposal_ru : slot.proposal_en;
  if (!line || state.draftText.includes(line)) return;
  state.draftText = `${state.draftText.trim()} ${line}`.trim();
  if (slot.id && !(state.slotIds || []).includes(slot.id)) state.slotIds = [...(state.slotIds || []), slot.id];
}

function wireSheet(lead, replyLang) {
  const ta = document.getElementById('ta');
  if (!ta) return;
  ta.oninput = () => { state.draftText = ta.value; };
  document.getElementById('reset').onclick = () => {
    state.draftText = state.option?.text || '';
    state.slotIds = [...(state.option?.slot_ids || [])];
    ta.value = state.draftText;
  };
  app.querySelectorAll('[data-slot]').forEach((button) => {
    button.onclick = () => {
      insertProposal(lead, replyLang, button.dataset.slot);
      ta.value = state.draftText;
    };
  });
  document.getElementById('sheetDone').onclick = async () => {
    state.draftText = ta.value;
    try {
      await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, {
        method: 'PUT',
        body: JSON.stringify(draftPayload()),
      });
      state.sheet = false;
      state.notice = t('saved');
      showLead().catch(report);
    } catch (err) {
      report(err);
    }
  };
  document.getElementById('sheetBg').onclick = () => { state.sheet = false; showLead().catch(fail); };
}

async function saveAndSend(lead) {
  const saved = await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, {
    method: 'PUT',
    body: JSON.stringify(draftPayload()),
  });
  const result = await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/send`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `ui-${lead.id}-${saved.version}-${Date.now()}` },
    body: JSON.stringify({ draft_version: saved.version, manual: state.manual }),
  });
  state.sheet = false;
  state.loadedLead = '';
  state.notice = result.simulated === false ? t('sendDone') : t('sentSim');
  go('#/inbox');
}

function dayHeading(zone) {
  const month = state.lang === 'ru' ? MON_RU[Number(zone.month) - 1] : MON_EN[Number(zone.month) - 1];
  const weekday = state.lang === 'ru' ? (WD_RU[zone.weekday] || zone.weekday) : zone.weekday;
  return `${weekday} ${Number(zone.day)} ${month}`;
}

function weekStrip(items) {
  const days = state.lang === 'ru' ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const anchor = items[0] ? zoned(items[0].start_utc, items[0].tz) : zoned(new Date().toISOString(), 'Asia/Dubai');
  const start = utcDate(anchor.key);
  const weekday = (start.getUTCDay() + 6) % 7;
  return `<div class="week">${days.map((label, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + (index - weekday));
    const key = day.toISOString().slice(0, 10);
    const on = items.some((row) => zoned(row.start_utc, row.tz).key === key);
    const selected = state.dayKey ? state.dayKey === key : index === weekday;
    return `<button class="day ${selected ? 'on' : ''}" type="button" data-day="${key}">${label}<b>${day.getUTCDate()}</b><i class="${on ? '' : 'no'}"></i></button>`;
  }).join('')}</div>`;
}

function viewingLabel(status) {
  if (status === 'confirmed') return t('confirmed');
  if (status === 'cancelled') return t('cancelled');
  return t('awaiting');
}

async function showArchive() {
  const [list, badge] = await Promise.all([
    api('/v1/intl/leads?archived=1'),
    refreshBadge(),
  ]);
  const leads = list.leads || [];
  const row = (lead) => `<a class="item chev" href="#/lead/${esc(lead.id)}"><span class="dot ${esc(mark(lead))}"></span>
    <div class="main"><div class="t"><bdi dir="auto">${esc(lead.clean_name || lead.sender_name || lead.id)}</bdi> <span class="g ${esc(mark(lead))}">${esc(mark(lead))}</span></div>
    <div class="s">${channelChip(lead.channel, true)}</div></div>
    <div class="r">${esc(clock(lead.first_msg_at))}</div></a>`;
  shell(`<a class="back" href="#/inbox">‹ ${esc(t('inbox'))}</a>
    ${bar()}
    <div class="hd"><h1>${esc(t('archiveTitle'))}</h1><p>${esc(fill('leadsLine', leads.length))}</p></div>
    ${leads.length ? `<div class="card">${leads.map(row).join('')}</div>` : `<p class="foot">${esc(t('archiveEmpty'))}</p>`}`, badge);
}

async function showViewings() {
  const [data, badge] = await Promise.all([api('/v1/intl/viewings'), refreshBadge()]);
  const rows = data.viewings || [];
  const shown = state.dayKey ? rows.filter((row) => zoned(row.start_utc, row.tz).key === state.dayKey) : rows;
  const groups = new Map();
  for (const row of shown) {
    const zone = zoned(row.start_utc, row.tz);
    if (!groups.has(zone.key)) groups.set(zone.key, { zone, list: [] });
    groups.get(zone.key).list.push(row);
  }
  const cards = [...groups.values()].map(({ zone, list }) => `<div class="sh"><span>${esc(dayHeading(zone))}</span></div>${list.map((row) => {
    const time = zoned(row.start_utc, row.tz);
    const ok = row.status === 'confirmed';
    const actions = [];
    if (row.status !== 'confirmed' && row.status !== 'cancelled') {
      actions.push(`<button class="btn sm" type="button" data-view="${esc(row.id)}" data-act="confirm">${esc(t('confirmView'))}</button>`);
    }
    if (row.status !== 'cancelled') {
      actions.push(`<button class="btn sec sm" type="button" data-view="${esc(row.id)}" data-act="cancel">${esc(t('cancelView'))}</button>`);
    }
    return `<div class="ev"><div class="tm">${esc(`${time.hour}:${time.minute}`)}<small>${esc(t('minutes'))}</small></div><div class="card"><a href="#/lead/${esc(row.lead_id)}"><div class="kind">${esc(t('viewingWord'))}</div><h3>${esc(place(row.title || ''))}</h3><p><bdi dir="auto">${esc(row.clean_name || row.sender_name || '')}</bdi> · <span class="${ok ? 'state-ok' : ''}">${esc(viewingLabel(row.status))}</span></p>${channelChip(row.channel)}</a>${actions.length ? `<div class="btnrow">${actions.join('')}</div>` : ''}</div></div>`;
  }).join('')}`).join('');
  const anchor = rows[0] ? zoned(rows[0].start_utc, rows[0].tz) : zoned(new Date().toISOString(), 'Asia/Dubai');
  shell(`${bar()}
    <div class="hd"><h1>${esc(t('viewings'))}</h1><p>${esc(fill('viewingsLine', { w: isoWeek(anchor.key), n: rows.length }))} <span class="demotag">${esc(t('demoTag'))}</span></p></div>
    ${weekStrip(rows)}
    ${state.dayKey ? `<p class="foot"><button class="link inline" id="clearDay" type="button">${esc(t('clearFilter'))}</button></p>` : ''}
    ${cards || `<p class="foot">${esc(t('filterEmpty'))}</p>`}
    <p class="foot" id="formError" role="alert"></p>
    <p class="foot">${esc(t('viewingsFoot'))}</p>`, badge);
  app.querySelectorAll('[data-day]').forEach((button) => {
    button.onclick = () => {
      state.dayKey = state.dayKey === button.dataset.day ? '' : button.dataset.day;
      showViewings().catch(fail);
    };
  });
  const clearDay = document.getElementById('clearDay');
  if (clearDay) clearDay.onclick = () => { state.dayKey = ''; showViewings().catch(fail); };
  app.querySelectorAll('[data-view]').forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.view;
      const act = button.dataset.act;
      const post = async () => {
        await api(`/v1/intl/viewings/${encodeURIComponent(id)}/${act}`, { method: 'POST', body: '{}' });
        state.notice = act === 'confirm' ? t('confirmed') : t('cancelled');
        showViewings().catch(fail);
      };
      if (act === 'cancel') {
        state.ask = { message: t('cancelHint'), yes: t('cancelView'), run: post };
        showViewings().catch(fail);
        return;
      }
      post().catch((err) => { state.notice = errText(err); showViewings().catch(fail); });
    };
  });
}

function roomsOf(row) {
  if (row.bedrooms != null && row.bedrooms !== '') return row.bedrooms;
  return row.facts && row.facts.bedrooms != null ? row.facts.bedrooms : '';
}

async function showProperties() {
  const [data, badge] = await Promise.all([api('/v1/intl/properties'), refreshBadge()]);
  const editing = state.editProperty;
  const cards = (data.properties || []).map((row) => {
    const price = state.lang === 'ru' ? (row.price_ru || '') : (row.price_en || '');
    const meta = row.price_period === 'total' ? kindLabel(row.kind) : `${kindLabel(row.kind)} · ${periodLabel(row.price_period)}`;
    const rooms = roomsOf(row);
    const bits = [
      row.address,
      row.district,
      rooms !== '' ? `${rooms} ${state.lang === 'ru' ? 'комн.' : 'bd'}` : '',
      row.area_value ? `${row.area_value} ${row.area_unit || ''}`.trim() : '',
    ].filter(Boolean);
    const files = [
      row.brochure_url ? t('brochure') : '',
      row.plan_url ? t('floorPlan') : '',
      row.listing_url ? t('linkPh') : '',
    ].filter(Boolean);
    return `<article class="propcard"><div class="oi">${ICO.home}</div><h3>${esc(row.title || '')}</h3><p>${esc(meta)}</p><div class="price">${esc(price)}</div>${bits.length ? `<p>${esc(bits.join(' · '))}</p>` : ''}${files.length ? `<p class="files">${esc(files.join(' · '))}</p>` : ''}<div class="btnrow"><button class="btn sec sm" type="button" data-prop="${esc(row.id)}">${esc(t('openLeads'))}</button><button class="btn sec sm" type="button" data-edit="${esc(row.id)}">${esc(t('editProperty'))}</button></div></article>`;
  }).join('');
  const form = state.addProperty ? `<form class="card form" id="propForm">
      <input id="ptitle" maxlength="120" placeholder="${esc(t('titlePh'))}" value="${esc(editing?.title || '')}">
      <input id="paddress" maxlength="160" placeholder="${esc(t('addressPh'))}" value="${esc(editing?.address || '')}">
      <input id="pdistrict" maxlength="80" placeholder="${esc(t('districtPh'))}" value="${esc(editing?.district || '')}">
      <select id="pkind"><option value="rent">${esc(t('rent'))}</option><option value="sale">${esc(t('sale'))}</option></select>
      <select id="pcurrency"><option>USD</option><option>AED</option></select>
      <select id="pperiod"></select>
      <input id="pprice" inputmode="decimal" placeholder="${esc(t('pricePh'))}" value="${editing?.price != null ? esc(editing.price) : ''}">
      <input id="prooms" inputmode="numeric" placeholder="${esc(t('roomsPh'))}" value="${esc(roomsOf(editing || {}))}">
      <input id="parea" inputmode="decimal" placeholder="${esc(t('areaPh'))}" value="${editing?.area_value != null ? esc(editing.area_value) : ''}">
      <select id="punit"><option value="sqft">sqft</option><option value="sqm">sqm</option></select>
      <input id="plink" maxlength="500" placeholder="${esc(t('linkPh'))}" value="${esc(editing?.listing_url || '')}">
      <input id="pplan" maxlength="500" placeholder="${esc(t('planPh'))}" value="${esc(String(editing?.plan_url || '').startsWith('data:') ? '' : (editing?.plan_url || ''))}">
      <input id="pplanfile" type="file" accept="image/png,image/jpeg,image/webp,application/pdf">
      <label class="check"><input id="pbrochure" type="checkbox" ${editing?.brochure_url ? 'checked' : ''}> ${esc(t('makeBrochure'))}</label>
      <button class="btn" id="saveProp" type="submit">${esc(t('saveProperty'))}</button>
      <button class="btn sec" id="cancelProp" type="button">${esc(t('cancelView'))}</button>
      <p id="formError" role="alert"></p>
    </form>` : `<button class="btn sec queuebtn" id="addProp" type="button">${esc(t('addProperty'))}</button>`;
  shell(`${bar()}
    <div class="hd"><h1>${esc(t('properties'))}</h1><p>${esc(t('propertiesSub'))} <span class="demotag">${esc(t('demoTag'))}</span></p></div>
    ${form}
    <div class="proplist">${cards}</div>
    <p class="foot">${esc(t('proposals'))}</p>`, badge);
  app.querySelectorAll('[data-prop]').forEach((button) => {
    button.onclick = () => { state.propertyId = button.dataset.prop; go('#/inbox'); };
  });
  app.querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = () => {
      state.editProperty = (data.properties || []).find((row) => row.id === button.dataset.edit) || null;
      state.addProperty = true;
      showProperties().catch(fail);
    };
  });
  const add = document.getElementById('addProp');
  if (add) add.onclick = () => { state.editProperty = null; state.addProperty = true; showProperties().catch(fail); };
  const cancel = document.getElementById('cancelProp');
  if (cancel) cancel.onclick = () => { state.addProperty = false; state.editProperty = null; showProperties().catch(fail); };
  const formEl = document.getElementById('propForm');
  if (formEl) {
    const fillPeriods = () => {
      const kind = document.getElementById('pkind').value;
      const options = kind === 'sale' ? [['total', t('perTotal')]] : [['year', t('perYear')], ['month', t('perMonth')]];
      document.getElementById('pperiod').innerHTML = options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    };
    fillPeriods();
    if (editing) {
      document.getElementById('pkind').value = editing.kind || 'rent';
      fillPeriods();
      document.getElementById('pcurrency').value = editing.currency || 'USD';
      document.getElementById('pperiod').value = editing.price_period || (editing.kind === 'sale' ? 'total' : 'year');
      if (editing.area_unit) document.getElementById('punit').value = editing.area_unit;
    }
    document.getElementById('pkind').onchange = fillPeriods;
    formEl.onsubmit = async (event) => {
      event.preventDefault();
      try {
        const file = document.getElementById('pplanfile').files && document.getElementById('pplanfile').files[0];
        const plan = file ? await readPlan(file) : document.getElementById('pplan').value.trim();
        const rooms = document.getElementById('prooms').value.trim();
        const area = document.getElementById('parea').value.trim();
        await api('/v1/intl/properties', {
          method: 'POST',
          body: JSON.stringify({
            id: editing?.id,
            title: document.getElementById('ptitle').value.trim(),
            address: document.getElementById('paddress').value.trim(),
            district: document.getElementById('pdistrict').value.trim(),
            kind: document.getElementById('pkind').value,
            price: Number(document.getElementById('pprice').value),
            currency: document.getElementById('pcurrency').value,
            price_period: document.getElementById('pperiod').value,
            bedrooms: rooms === '' ? null : Number(rooms),
            area_value: area === '' ? null : Number(area),
            area_unit: area === '' ? '' : document.getElementById('punit').value,
            listing_url: document.getElementById('plink').value.trim(),
            plan_url: plan,
            make_brochure: document.getElementById('pbrochure').checked,
            tz: editing?.tz || 'Asia/Dubai',
            tz_label_en: editing?.tz_label_en || 'Dubai time',
            tz_label_ru: editing?.tz_label_ru || 'время Дубая',
          }),
        });
        state.addProperty = false;
        state.editProperty = null;
        state.notice = t('propertySaved');
        showProperties().catch(fail);
      } catch (err) {
        report(err);
      }
    };
  }
}

function readPlan(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 80000) {
      reject(Object.assign(new Error('invalid_property'), { body: { error_code: 'invalid_property' } }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(Object.assign(new Error('invalid_property'), { body: { error_code: 'invalid_property' } }));
    reader.readAsDataURL(file);
  });
}

async function pokeSetting(body, lockedText) {
  try {
    await api('/v1/intl/settings', { method: 'POST', body: JSON.stringify(body) });
    state.notice = t('saved');
  } catch (err) {
    state.notice = err.body?.error_code === 'locked' ? lockedText : errText(err);
  }
  showSetup().catch(fail);
}

async function showSetup() {
  const badge = await refreshBadge();
  try { state.serverSettings = await api('/v1/intl/settings'); } catch { /* keep the last settings */ }
  const manualOn = !state.serverSettings || state.serverSettings.manual_approval !== false;
  const autoOn = state.serverSettings?.auto_send_hot === true;
  shell(`${bar()}
    <div class="hd"><h1>${esc(t('setupTitle'))}</h1><p>${esc(t('setupSub'))}</p></div>
    <div class="card"><button class="step" id="step-connect" type="button"><span class="n">1</span><div><b>${esc(t('step1'))}</b><small>${esc(t('step1s'))}</small></div></button>
      <button class="step" id="step-property" type="button"><span class="n">2</span><div><b>${esc(t('step2'))}</b><small>${esc(t('step2s'))}</small></div></button>
      <button class="step" id="step-approve" type="button"><span class="n">3</span><div><b>${esc(t('step3'))}</b><small>${esc(t('step3s'))}</small></div></button></div>
    <div class="card spaced"><button class="toggle" id="toggle-manual" type="button" aria-pressed="${manualOn ? 'true' : 'false'}"><div class="tx"><b>${esc(t('manualTitle'))}</b><small>${esc(t('manualLocked'))}</small></div><span class="sw ${manualOn ? 'on' : ''}"></span></button>
      <button class="toggle ${autoOn ? '' : 'off'}" id="toggle-auto" type="button" aria-pressed="${autoOn ? 'true' : 'false'}"><div class="tx"><b>${esc(t('autoTitle'))} <span class="plan">${esc(t('planned'))}</span></b><small>${esc(t('autoSub'))}</small></div><span class="sw ${autoOn ? 'on' : ''}"></span></button></div>
    <p class="foot">${esc(t('proposals'))}</p>
    <a class="link" href="#/simulator">${esc(t('simulator'))}</a>`, badge);
  document.getElementById('step-connect').onclick = () => { state.notice = t('simOnly'); go('#/simulator'); };
  document.getElementById('step-property').onclick = () => { state.addProperty = true; go('#/properties'); };
  document.getElementById('step-approve').onclick = () => go('#/inbox');
  document.getElementById('toggle-manual').onclick = () => pokeSetting({ manual_approval: !manualOn }, t('manualLocked'));
  document.getElementById('toggle-auto').onclick = () => pokeSetting({ auto_send_hot: !autoOn }, t('autoSub'));
}

async function showSimulator() {
  const [props, badge] = await Promise.all([api('/v1/intl/properties'), refreshBadge()]);
  shell(`<a class="back" href="#/setup">‹ ${esc(t('setup'))}</a>
    ${bar()}
    <div class="hd"><h1>${esc(t('simulator'))}</h1></div>
    <div class="card form">
      <select id="prop">${props.properties.map((row) => `<option value="${esc(row.id)}">${esc(row.title)}</option>`).join('')}</select>
      <input id="name" placeholder="Igor">
      <textarea id="msg"></textarea>
      <button class="btn" id="as-client" type="button">${esc(t('sendAsClient'))}</button>
      <button class="btn sec" id="seed-minus" type="button">${esc(t('seedMinus'))}</button>
      <button class="btn sec" id="seed-all" type="button">${esc(t('seedAll'))}</button>
      <p id="formError" role="alert"></p>
    </div>`, badge);
  document.getElementById('as-client').onclick = async () => {
    try {
      const result = await api('/v1/sim/wa/inbound', {
        method: 'POST',
        body: JSON.stringify({
          from_id: `sim:${Date.now()}`,
          name: document.getElementById('name').value,
          text: document.getElementById('msg').value,
          property_id: document.getElementById('prop').value,
          msg_id: String(Date.now()),
        }),
      });
      state.loadedLead = '';
      go(`#/lead/${result.lead_id}`);
    } catch (err) {
      report(err);
    }
  };
  const seed = (mode) => api('/v1/intl/seed', { method: 'POST', body: JSON.stringify({ mode }) })
    .then(() => { state.notice = t('saved'); go('#/inbox'); })
    .catch((err) => { state.notice = errText(err); showSimulator().catch(fail); });
  document.getElementById('seed-minus').onclick = () => seed('minus_t06');
  document.getElementById('seed-all').onclick = () => seed('all');
}

async function showDigest() {
  const [digest, props, badge] = await Promise.all([
    api('/v1/intl/digest'),
    api('/v1/intl/properties'),
    refreshBadge(),
  ]);
  const rows = digest.write_first || [];
  const list = rows.map((row) => `<a class="item chev" href="#/lead/${esc(row.id)}"><div class="main"><div class="t"><bdi dir="auto">${esc(row.name || row.id)}</bdi> <span class="g ${esc(row.grade)}">${esc(row.grade || '')}</span></div><div class="s">${esc(propertyTitle(props.properties || [], row.property_id))}</div></div></a>`).join('');
  const today = (digest.viewings_today || []).map((row) => `<a class="item chev" href="#/lead/${esc(row.lead_id)}"><div class="main"><div class="t">${esc(viewingLabel(row.status))}</div><div class="s">${esc(propertyTitle(props.properties || [], row.property_id))}</div></div></a>`).join('');
  const value = (digest.listed_value || []).map(moneyLine).join(' · ');
  shell(`<a class="back" href="#/inbox">‹ ${esc(t('inbox'))}</a>
    ${bar()}
    <div class="hd"><h1>${esc(t('digestTitle'))}</h1></div>
    <button class="btn queuebtn" id="digestSend" type="button">${esc(t('digestSend'))}</button>
    ${rows.length ? `<div class="sh"><span>${esc(t('writeFirst'))} · ${rows.length}</span></div><div class="card">${list}</div>` : `<p class="foot">${esc(t('digestEmpty'))}</p>`}
    ${today ? `<div class="sh"><span>${esc(t('todayWord'))}</span></div><div class="card">${today}</div>` : ''}
    ${value ? `<p class="foot">${esc(t('listed'))}: ${esc(value)}. ${esc(t('notRevenue'))}</p>` : ''}
    <p class="foot" id="formError" role="alert"></p>`, badge);
  document.getElementById('digestSend').onclick = async () => {
    try {
      const result = await api('/v1/intl/digest/send', { method: 'POST', body: '{}' });
      state.notice = result.digest_sent_on_demand === false
        ? t('digestDenied')
        : (result.telegram_delivery === false ? t('digestSim') : t('sendDone'));
    } catch (err) {
      state.notice = err.body?.digest_sent_on_demand === false ? t('digestDenied') : errText(err);
    }
    showDigest().catch(fail);
  };
}

async function boot() {
  captureLaunch();
  state.dict = await fetch(`i18n/${state.lang}.json`).then((res) => res.json());
  if (!state.tma) {
    shell(`${bar()}<div class="card pad"><p>${esc(t('signIn'))}</p></div>`, 0);
    return;
  }
  try {
    const settings = await api('/v1/intl/settings');
    state.serverSettings = settings;
    state.ephemeral = settings.ephemeral === true;
  } catch {
    state.ephemeral = false;
  }
  if (state.screen === 'lead' && state.leadId) return showLead();
  if (state.screen === 'viewings') return showViewings();
  if (state.screen === 'properties') return showProperties();
  if (state.screen === 'setup') return showSetup();
  if (state.screen === 'simulator') return showSimulator();
  if (state.screen === 'digest') return showDigest();
  if (state.screen === 'archive') return showArchive();
  return showInbox();
}

addEventListener('hashchange', () => { state.sheet = query.get('sheet') === '1'; boot().catch(fail); });
boot().catch(fail);
