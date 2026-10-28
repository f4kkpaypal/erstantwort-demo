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
};
if (query.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

const ICO = {
  wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.3 14.8l-.3-.2-2.7.7.7-2.6-.2-.3A8 8 0 0 1 12 4zm-3 3.5c-.3 0-.6.2-.8.5-.3.4-.8 1-.8 2.1s.8 2.3.9 2.4c.1.2 1.6 2.6 4 3.5 2 .8 2.4.6 2.8.6.5 0 1.4-.6 1.6-1.2.2-.6.2-1.1.1-1.2-.1-.1-.3-.2-.6-.3l-1.6-.8c-.2-.1-.4-.1-.6.1l-.7.9c-.1.2-.3.2-.6.1-.9-.4-1.7-1-2.4-2-.1-.2 0-.3.1-.4l.4-.5.2-.4c0-.1 0-.3 0-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.5 3.2 2.8 10.4c-.8.3-.8 1.4 0 1.7l4.6 1.5 1.8 5.6c.2.7 1 .9 1.5.4l2.6-2.4 4.8 3.5c.6.4 1.4.1 1.6-.6l3.1-15.3c.2-.9-.7-1.6-1.4-1.3zM9.8 14 17.5 8l-6.1 6.7-.3 3.2z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9H3z"/><path d="M9 20v-6h6v6"/></svg>',
  start: '<svg viewBox="0 0 24 24"><path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.6-4.9-2.6-4.9 2.6.9-5.6-4-3.9 5.6-.8z"/></svg>',
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
    state.screen = 'lead';
    state.leadId = decodeURIComponent(id);
  } else if (['inbox', 'viewings', 'properties', 'setup', 'simulator'].includes(screen)) {
    state.screen = screen;
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
  app.innerHTML = `${reset}${inner}${tabs(waiting)}`;
  app.querySelectorAll('[data-lang]').forEach((button) => {
    button.onclick = () => {
      state.lang = button.dataset.lang;
      localStorage.setItem('intl-lang', state.lang);
      boot().catch(fail);
    };
  });
}

function fail(err) {
  shell(`<div class="demo">${esc(t('demoBar'))}</div>${bar()}<div class="card pad"><p>${esc(err.body?.message || err.message || 'Error')}</p></div>`, 0);
}

function channelChip(channel, iconOnly) {
  const wa = channel === 'wa_sim';
  const name = iconOnly ? '' : esc(wa ? t('whatsapp') : t('telegram'));
  return `<span class="ch ${wa ? 'wa' : 'tg'}">${wa ? ICO.wa : ICO.tg}${name}</span>`;
}

function statusLabel(lead) {
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
  const match = (lead) => state.filter === 'ALL' || lead.grade === state.filter;
  const shownWait = waiting.filter(match);
  const shownDone = rest.filter(match);
  const pending = leads.filter((lead) => lead.status === 'pending_approval');
  state.badge = waiting.length;
  state.leadRows = leads;
  const value = (digest.listed_value || []).map(moneyLine).join(' · ');
  const row = (lead) => `<a class="item chev" href="#/lead/${esc(lead.id)}"><span class="dot ${esc(lead.grade)}"></span>
    <div class="main"><div class="t"><bdi dir="auto">${esc(lead.clean_name || lead.sender_name || lead.id)}</bdi> <span class="g ${esc(lead.grade)}">${esc(lead.grade)} ${esc(lead.score)}</span></div>
    <div class="s">${channelChip(lead.channel, true)} · ${esc(propertyTitle(props.properties, lead.property_id))}</div></div>
    <div class="r"><b class="${lead.status === 'pending_approval' || lead.status === 'review' ? 'need' : ''}">${esc(statusLabel(lead))}</b>${esc(clock(lead.first_msg_at))}</div></a>`;
  shell(`<div class="demo">${esc(t('demoBar'))}</div>${bar()}
    <div class="hd"><h1>${esc(t('inbox'))}</h1><p>${esc(headDate())} · ${esc(fill('leadsLine', leads.length))} <span class="demotag">${esc(t('demoTag'))}</span></p></div>
    <div class="stats"><div><b>${leads.length}</b>${esc(t('leadsTile'))}</div><div><b>${pending.length}</b>${esc(t('toApprove'))}</div></div>
    ${pending.length ? `<a class="btn queuebtn" href="#/lead/${esc(pending[0].id)}">${esc(fill('reviewN', pending.length))}</a>` : ''}
    <div class="seg">${['ALL', 'HOT', 'WARM', 'COLD'].map((grade) => `<button type="button" data-f="${grade}" class="${state.filter === grade ? 'on' : ''}">${grade === 'ALL' ? esc(t('all')) : grade}</button>`).join('')}</div>
    ${shownWait.length ? `<div class="sh"><span>${esc(t('waiting'))} · ${shownWait.length}</span></div><div class="card">${shownWait.map(row).join('')}</div>` : ''}
    ${shownDone.length ? `<div class="sh"><span>${esc(t('done'))} · ${shownDone.length}</span></div><div class="card">${shownDone.map(row).join('')}</div>` : ''}
    ${value ? `<p class="foot">${esc(t('listed'))}: ${esc(value)}. ${esc(t('notRevenue'))}</p>` : ''}
    <p class="foot">${esc(t('scoreNote'))}</p>`, waiting.length);
  app.querySelectorAll('[data-f]').forEach((button) => {
    button.onclick = () => { state.filter = button.dataset.f; showInbox().catch(fail); };
  });
}

async function showLead() {
  const [data, badge] = await Promise.all([
    api(`/v1/intl/leads/${encodeURIComponent(state.leadId)}`),
    refreshBadge(),
  ]);
  const lead = data.lead;
  const stopped = lead.status === 'stopped';
  const review = lead.status === 'review';
  const options = lead.options || [];
  const slots = lead.slots || [];
  const replyLang = lead.language === 'ru' ? 'ru' : 'en';
  if (state.loadedLead !== lead.id) {
    state.loadedLead = lead.id;
    state.option = options[0] || null;
    state.draftText = state.option ? state.option.text : '';
    state.slotIds = [...(state.option?.slot_ids || [])];
    state.manual = false;
    state.sheet = query.get('sheet') === '1';
  }
  const inbound = (lead.messages || []).filter((row) => row.direction === 'in').slice(-1)[0];
  const note = NOTE[replyLang];
  const slotButtons = (attr) => slots.map((slot) => `<button class="tslot" type="button" ${attr}="${esc(slot.id)}">${esc(replyLang === 'ru' ? slot.label_ru : slot.label_en)}</button>`).join('');
  const sheet = state.sheet ? `<div class="backdrop" id="sheetBg"></div><div class="sheet" role="dialog"><div class="grab"></div>
    <div class="sheethd"><b>${esc(t('editReply'))}</b><button class="link" id="sheetDone" type="button">${esc(t('doneBtn'))}</button></div>
    <textarea id="ta" lang="${replyLang}">${esc(state.draftText || '')}</textarea>
    <p class="sheetsub">${esc(t('insertSlot'))}</p>
    <div class="chips">${slotButtons('data-slot')}</div>
    <p class="sheetai">${esc(t('sheetAi'))}</p>
    <p class="sheetai"><i>${esc(note.ai)}</i></p>
    <p class="sheetai">${esc(t('stopLineLabel'))}: <i>${esc(note.stop)}</i></p>
    <button class="btn sec sm" id="reset" type="button">${esc(t('returnOriginal'))}</button></div>` : '';
  shell(`<a class="back" href="#/inbox">‹ ${esc(t('inbox'))}</a>
    ${bar()}
    <div class="actbar"><div class="btnrow">
      <button class="btn sec" id="reject" type="button" ${stopped ? 'disabled' : ''}>${esc(t('dontSend'))}</button>
      <button class="btn go w2" id="send" type="button" ${stopped ? 'disabled' : ''}>${esc(t('send'))}</button>
    </div></div>
    <div class="card lh2 ${esc(lead.grade)}"><div><h1><bdi dir="auto">${esc(lead.clean_name || lead.sender_name || '')}</bdi> <span class="g ${esc(lead.grade)}">${esc(lead.grade)} ${esc(lead.score)}</span></h1>
      <p>${channelChip(lead.channel)}<span>${esc(place(lead.property?.title || ''))}</span></p></div></div>
    <div class="thread"><div class="msg in"><bdi dir="auto">${esc(inbound?.text || '')}</bdi></div>
      ${state.draftText ? `<div class="msg out"><bdi dir="auto">${esc(state.draftText)}</bdi></div><div class="msgcap"><button class="link" id="edit" type="button">${esc(t('editText'))}</button></div>` : `<button class="btn sec" id="edit" type="button">${esc(t('editText'))}</button>`}
    </div>
    <div class="card smart">
      <div><span>${esc(t('wants'))}</span><b>${esc(intentLabel(lead.intent))}</b></div>
      <div><span>${esc(t('budget'))}</span><b>${esc(budgetText(lead))}</b>${(lead.flags || []).includes('budget_currency_assumed') ? `<small>${esc(t('budgetAssumed'))}</small>` : ''}</div>
      <div><span>${esc(t('timing'))}</span><b>${esc(timingText(lead))}</b></div>
      <div><span>${esc(t('language'))}</span><b>${esc(lead.language === 'ru' ? 'RU' : lead.language === 'en' ? 'EN' : t('intentUnclear'))}</b></div>
    </div>
    ${stopped ? `<p class="foot">${esc(t('optedOut'))}</p>` : ''}
    ${review ? `<p class="foot">${esc(t('notUnderstood'))}</p><button class="btn" id="manual" type="button">${esc(t('replyManually'))}</button>` : ''}
    ${lead.stale_sending ? `<p class="foot">${esc(t('stale'))}</p>` : ''}
    ${options.length ? `<div class="sh"><span>${esc(t('optsTitle'))}</span></div><div class="card opts">${options.map((row) => `<button class="opt ${state.option && state.option.id === row.id ? 'on' : ''}" type="button" data-opt="${esc(row.id)}"><b>${esc(state.lang === 'ru' ? row.label_ru : row.label_en)}</b><span>${esc(row.text)}</span></button>`).join('')}</div>` : ''}
    ${slots.length ? `<div class="sh"><span>${esc(t('slotsTitle'))}</span></div><div class="card slotcard"><p class="slothd">${esc(place(lead.property?.title || ''))}</p><div class="chips">${slotButtons('data-insert')}</div></div><p class="foot">${esc(t('notReserved'))}</p>` : ''}
    ${sheet}
    <p class="foot" id="formError" role="alert"></p>
    <p class="foot">${esc(t('scoreNote'))}</p>`, badge);
  const send = document.getElementById('send');
  if (send) send.disabled = stopped || (!state.draftText && !review);
  app.querySelectorAll('[data-opt]').forEach((button) => {
    button.onclick = () => {
      state.option = options.find((row) => row.id === button.dataset.opt);
      state.draftText = state.option.text;
      state.slotIds = [...(state.option.slot_ids || [])];
      state.manual = false;
      state.sheet = true;
      showLead().catch(fail);
    };
  });
  const edit = document.getElementById('edit');
  if (edit) edit.onclick = () => { state.sheet = true; showLead().catch(fail); };
  app.querySelectorAll('[data-insert]').forEach((button) => {
    button.onclick = () => {
      insertProposal(lead, replyLang, button.dataset.insert);
      showLead().catch(report);
    };
  });
  const manual = document.getElementById('manual');
  if (manual) manual.onclick = () => { state.option = { id: null, text: '' }; state.draftText = ''; state.slotIds = []; state.manual = true; state.sheet = true; showLead().catch(report); };
  document.getElementById('reject').onclick = async () => {
    try {
      await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/reject`, { method: 'POST', body: '{}' });
      state.sheet = false;
      location.hash = '#/inbox';
    } catch (err) {
      report(err);
    }
  };
  wireSheet(lead, replyLang);
  if (send) send.onclick = () => saveAndSend(lead).catch(report);
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
        body: JSON.stringify({ text: state.draftText, option_id: state.manual ? null : state.option?.id, edited: true, slot_ids: state.slotIds || [] }),
      });
      state.sheet = false;
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
    body: JSON.stringify({ text: state.draftText, option_id: state.manual ? null : state.option?.id, edited: true, slot_ids: state.slotIds || [] }),
  });
  await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/send`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `ui-${lead.id}-${saved.version}-${Date.now()}` },
    body: JSON.stringify({ draft_version: saved.version, manual: state.manual }),
  });
  state.sheet = false;
  location.hash = '#/inbox';
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
    return `<div class="day ${index === weekday ? 'on' : ''}">${label}<b>${day.getUTCDate()}</b><i class="${on ? '' : 'no'}"></i></div>`;
  }).join('')}</div>`;
}

async function showViewings() {
  const [data, badge] = await Promise.all([api('/v1/intl/viewings'), refreshBadge()]);
  const rows = data.viewings || [];
  const groups = new Map();
  for (const row of rows) {
    const zone = zoned(row.start_utc, row.tz);
    if (!groups.has(zone.key)) groups.set(zone.key, { zone, list: [] });
    groups.get(zone.key).list.push(row);
  }
  const cards = [...groups.values()].map(({ zone, list }) => `<div class="sh"><span>${esc(dayHeading(zone))}</span></div>${list.map((row) => {
    const time = zoned(row.start_utc, row.tz);
    const ok = row.status === 'confirmed';
    return `<div class="ev"><div class="tm">${esc(`${time.hour}:${time.minute}`)}<small>${esc(t('minutes'))}</small></div><div class="card"><div class="kind">${esc(t('viewingWord'))}</div><h3>${esc(place(row.title || ''))}</h3><p><bdi dir="auto">${esc(row.clean_name || row.sender_name || '')}</bdi> · <span class="${ok ? 'state-ok' : ''}">${esc(ok ? t('confirmed') : t('awaiting'))}</span></p>${channelChip(row.channel)}</div></div>`;
  }).join('')}`).join('');
  const anchor = rows[0] ? zoned(rows[0].start_utc, rows[0].tz) : zoned(new Date().toISOString(), 'Asia/Dubai');
  shell(`<div class="demo">${esc(t('demoBar'))}</div>${bar()}
    <div class="hd"><h1>${esc(t('viewings'))}</h1><p>${esc(fill('viewingsLine', { w: isoWeek(anchor.key), n: rows.length }))} <span class="demotag">${esc(t('demoTag'))}</span></p></div>
    ${weekStrip(rows)}
    ${cards}
    <p class="foot">${esc(t('viewingsFoot'))}</p>`, badge);
}

async function showProperties() {
  const [data, badge] = await Promise.all([api('/v1/intl/properties'), refreshBadge()]);
  const cards = (data.properties || []).map((row) => {
    const price = state.lang === 'ru' ? (row.price_ru || '') : (row.price_en || '');
    const meta = row.price_period === 'total' ? kindLabel(row.kind) : `${kindLabel(row.kind)} · ${periodLabel(row.price_period)}`;
    const count = (state.leadRows || []).filter((lead) => lead.property_id === row.id).length;
    return `<div class="oc"><div class="oi">${ICO.home}</div><div class="tx"><h3>${esc(place(row.title))}</h3><p>${esc(meta)}</p><div class="price">${esc(price)}</div><span class="cnt2">${esc(fill('leadsCnt', count))}</span></div></div>`;
  }).join('');
  shell(`<div class="demo">${esc(t('demoBar'))}</div>${bar()}
    <div class="hd"><h1>${esc(t('properties'))}</h1><p>${esc(t('propertiesSub'))} <span class="demotag">${esc(t('demoTag'))}</span></p></div>
    <div class="grid2">${cards}</div>
    <p class="foot">${esc(t('proposals'))}</p>`, badge);
}

async function showSetup() {
  const badge = await refreshBadge();
  shell(`<div class="demo">${esc(t('demoBar'))}</div>${bar()}
    <div class="hd"><h1>${esc(t('setupTitle'))}</h1><p>${esc(t('setupSub'))}</p></div>
    <div class="card"><div class="step"><span class="n">1</span><div><b>${esc(t('step1'))}</b><small>${esc(t('step1s'))}</small></div></div>
      <div class="step"><span class="n">2</span><div><b>${esc(t('step2'))}</b><small>${esc(t('step2s'))}</small></div></div>
      <div class="step"><span class="n">3</span><div><b>${esc(t('step3'))}</b><small>${esc(t('step3s'))}</small></div></div></div>
    <div class="card spaced"><div class="toggle"><div class="tx"><b>${esc(t('manualTitle'))}</b><small>${esc(t('manualLocked'))}</small></div><span class="sw on"></span></div>
      <div class="toggle off"><div class="tx"><b>${esc(t('autoTitle'))} <span class="plan">${esc(t('planned'))}</span></b><small>${esc(t('autoSub'))}</small></div><span class="sw"></span></div></div>
    <p class="foot">${esc(t('proposals'))}</p>
    <a class="link" href="#/simulator">${esc(t('simulator'))}</a>`, badge);
}

async function showSimulator() {
  const [props, badge] = await Promise.all([api('/v1/intl/properties'), refreshBadge()]);
  shell(`<div class="demo">${esc(t('demoBar'))}</div>${bar()}
    <div class="hd"><h1>${esc(t('simulator'))}</h1></div>
    <div class="card form">
      <select id="prop">${props.properties.map((row) => `<option value="${esc(row.id)}">${esc(row.title)}</option>`).join('')}</select>
      <input id="name" placeholder="Igor">
      <textarea id="msg"></textarea>
      <button class="btn" id="as-client" type="button">${esc(t('sendAsClient'))}</button>
      <button class="btn sec" id="seed-minus" type="button">${esc(t('seedMinus'))}</button>
      <button class="btn sec" id="seed-all" type="button">${esc(t('seedAll'))}</button>
    </div>`, badge);
  document.getElementById('as-client').onclick = async () => {
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
    location.hash = `#/lead/${result.lead_id}`;
  };
  const seed = (mode) => api('/v1/intl/seed', { method: 'POST', body: JSON.stringify({ mode }) }).then(() => { location.hash = '#/inbox'; });
  document.getElementById('seed-minus').onclick = () => seed('minus_t06');
  document.getElementById('seed-all').onclick = () => seed('all');
}

async function boot() {
  captureLaunch();
  state.dict = await fetch(`i18n/${state.lang}.json`).then((res) => res.json());
  if (!state.tma) {
    shell(`<div class="demo">${esc(t('demoBar'))}</div>${bar()}<div class="card pad"><p>${esc(t('signIn'))}</p></div>`, 0);
    return;
  }
  try {
    const settings = await api('/v1/intl/settings');
    state.ephemeral = settings.ephemeral === true;
  } catch {
    state.ephemeral = false;
  }
  if (state.screen === 'lead' && state.leadId) return showLead();
  if (state.screen === 'viewings') return showViewings();
  if (state.screen === 'properties') return showProperties();
  if (state.screen === 'setup') return showSetup();
  if (state.screen === 'simulator') return showSimulator();
  return showInbox();
}

addEventListener('hashchange', () => { state.sheet = query.get('sheet') === '1'; boot().catch(fail); });
boot().catch(fail);
