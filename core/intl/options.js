'use strict';

const { DateTime } = require('luxon');

const BROKER_EN = 'The broker will confirm this personally.';
const BROKER_RU = 'Брокер подтвердит это лично.';
const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function formatPrice(property, lang) {
  const grouped = lang === 'ru'
    ? String(property.price).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    : String(property.price).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (lang === 'ru') {
    const tail = property.price_period === 'year' ? ' в год' : property.price_period === 'month' ? ' в месяц' : '';
    return `${grouped} ${property.currency}${tail}`;
  }
  const tail = property.price_period === 'year' ? ' / year' : property.price_period === 'month' ? ' / month' : '';
  return `${property.currency} ${grouped}${tail}`;
}

function slotPhrase(slot, property, lang) {
  const zone = (property && property.tz) || 'Asia/Dubai';
  const dt = DateTime.fromISO(slot.start_utc || slot, { setZone: true }).setZone(zone);
  const dow = lang === 'ru' ? DOW_RU[dt.weekday - 1] : DOW_EN[dt.weekday - 1];
  const mon = lang === 'ru' ? MON_RU[dt.month - 1] : MON_EN[dt.month - 1];
  const label = (property && property[lang === 'ru' ? 'tz_label_ru' : 'tz_label_en']) || zone;
  const note = lang === 'ru' ? '(Время ещё не зарезервировано.)' : '(Not reserved yet.)';
  return { when: `${dow} ${dt.day} ${mon}, ${dt.toFormat('HH:mm')} (${label})`, note };
}

function hi(name, lang) {
  if (lang === 'ru') return name ? `Здравствуйте, ${name}` : 'Здравствуйте';
  return name ? `Hi ${name}` : 'Hi';
}

function refOf(property, lang) {
  if (!property || property.id === 'general') return lang === 'ru' ? 'этому запросу' : 'this request';
  return lang === 'ru' ? (property.ref_ru || property.title) : (property.ref_en || property.title);
}

function priceOf(property, lang) {
  if (!property || property.price == null || property.id === 'general') return '';
  return property[lang === 'ru' ? 'price_ru' : 'price_en'] || formatPrice(property, lang);
}

function askTime(lang) {
  return lang === 'ru' ? 'Какой день и время вам удобны?' : 'Which day and time suit you?';
}

function sameInstant(a, b) {
  if (!a || !b) return false;
  return Date.parse(a) === Date.parse(b);
}

function lineFrom(list, property, lang) {
  const free = (list || []).map((slot) => slotPhrase(slot, property, lang));
  const reserved = free[0]?.note || (lang === 'ru' ? '(Время ещё не зарезервировано.)' : '(Not reserved yet.)');
  if (!free.length) return askTime(lang);
  return `${free.map((slot) => slot.when).join(lang === 'ru' ? ' или ' : ' or ')}. ${reserved}`;
}

function orderPool(slots, proposed) {
  const pool = (slots || []).slice();
  if (!proposed || !proposed.start_utc) return pool;
  if (proposed.free) {
    const existing = pool.find((slot) => sameInstant(slot.start_utc, proposed.start_utc));
    const clientSlot = existing || {
      id: proposed.id || `client-${String(proposed.start_utc).replace(/[^0-9]/g, '').slice(0, 14)}`,
      start_utc: proposed.start_utc,
    };
    return [clientSlot, ...pool.filter((slot) => !sameInstant(slot.start_utc, proposed.start_utc))];
  }
  return pool.filter((slot) => !sameInstant(slot.start_utc, proposed.start_utc));
}

function hasProfile(property) {
  if (!property || property.id === 'general') return false;
  return Boolean(property.address || property.district || property.bedrooms || property.listing_url || property.brochure_url || property.plan_url);
}

function detailBits(property, lang) {
  const bits = [];
  if (property.address) bits.push(property.address);
  if (property.district) bits.push(property.district);
  if (property.bedrooms != null && property.bedrooms !== '') {
    const n = Number(property.bedrooms);
    bits.push(lang === 'ru' ? `${n} комн.` : `${n} bedroom${n === 1 ? '' : 's'}`);
  }
  if (property.area_value) {
    const unit = property.area_unit === 'sqm' ? (lang === 'ru' ? 'м²' : 'sqm') : (property.area_unit || '');
    bits.push(`${property.area_value} ${unit}`.trim());
  }
  return bits;
}

function materialsOf(property) {
  if (!property || property.id === 'general') return [];
  const items = [];
  if (property.brochure_url) {
    items.push({ kind: 'brochure', name: 'PDF', url: property.brochure_url });
  }
  if (property.plan_url) {
    items.push({ kind: 'plan', name: 'plan', url: property.plan_url });
  }
  if (property.listing_url) {
    items.push({ kind: 'link', name: 'link', url: property.listing_url });
  }
  return items;
}

function rankOf(intent) {
  if (intent === 'viewing') return ['confirm', 'other', 'two', 'one', 'view', 'ask', 'price_time', 'price', 'details'];
  if (intent === 'price' || intent === 'finance') return ['price', 'details', 'price_time', 'confirm', 'other', 'view', 'one', 'two', 'ask'];
  if (['details', 'area', 'docs', 'avail'].includes(intent)) return ['details', 'price', 'price_time', 'confirm', 'other', 'view', 'one', 'two', 'ask'];
  return ['price', 'details', 'confirm', 'other', 'two', 'one', 'view', 'ask', 'price_time'];
}

function orderByIntent(rows, intent) {
  const rank = rankOf(intent);
  return rows.slice().sort((a, b) => {
    const ia = rank.indexOf(a.id);
    const ib = rank.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function ensurePrice(chosen, pool, price, limit) {
  if (!price || chosen.some((item) => item.text.includes(price))) return chosen.slice(0, limit);
  const priced = pool.find((item) => item && item.text.includes(price));
  if (!priced) return chosen.slice(0, limit);
  const next = chosen.filter((item) => item.id !== priced.id);
  if (next.length < limit) next.push(priced);
  else next.splice(limit - 1, 1, priced);
  return next.slice(0, limit);
}

function placeMaterials(chosen, materials, price, limit) {
  const rest = chosen.filter((item) => item.id !== 'materials');
  const at = Math.min(2, rest.length);
  const next = rest.slice();
  next.splice(at, 0, materials);
  while (next.length > limit) {
    let drop = -1;
    for (let i = next.length - 1; i >= 1; i -= 1) {
      if (next[i].id === 'materials') continue;
      const priced = price && next[i].text.includes(price);
      const onlyPrice = priced && next.filter((row) => row.text.includes(price)).length === 1;
      if (!onlyPrice) {
        drop = i;
        break;
      }
    }
    if (drop < 0) break;
    next.splice(drop, 1);
  }
  return next.slice(0, limit);
}

const GREET_OTHER = 'Здравствуйте! Напишите, пожалуйста, на русском или английском. / Hi! Please write in Russian or English.';

function greetOther(analysis) {
  if (!analysis || analysis.intent === 'stop') return false;
  const flags = analysis.flags || [];
  if (flags.some((flag) => ['injection_suspect', 'non_text', 'optout'].includes(flag))) return false;
  return analysis.language === 'other' || flags.includes('lang_other');
}

function buildOptions(lead, property, slots, broker) {
  const analysis = lead.analysis || lead;
  if (greetOther(analysis)) {
    return [row('greet_other', 'Ask for RU or EN', 'Попросить RU или EN', GREET_OTHER, [])];
  }
  if (analysis.intent === 'stop') return [];
  if ((analysis.flags || []).some((flag) => ['injection_suspect', 'non_text', 'optout'].includes(flag))) return [];
  if (analysis.intent === 'unclear' && !lead.title_match) return [];
  const lang = analysis.language === 'ru' ? 'ru' : 'en';
  const name = (lead.name && lead.name.name) || lead.clean_name || '';
  const ref = refOf(property, lang);
  const price = priceOf(property, lang);
  const phrase = lang === 'ru' ? BROKER_RU : BROKER_EN;
  const proposed = lead.proposed || null;
  const pool = orderPool(slots, proposed);
  const oneSlots = pool.slice(0, 1);
  const twoSlots = pool.slice(0, 2);
  const oneIds = oneSlots.map((slot) => slot.id).filter(Boolean);
  const twoIds = twoSlots.map((slot) => slot.id).filter(Boolean);
  const oneLine = lineFrom(oneSlots, property, lang);
  const twoLine = lineFrom(twoSlots, property, lang);
  const needPhrase = ['docs', 'finance', 'details', 'area', 'avail'].includes(analysis.intent) || analysis.asks_discount === true;
  const tail = needPhrase ? ` ${phrase}` : '';
  const hello = hi(name, lang);
  const en = lang === 'en';
  const priceBit = price ? (lang === 'ru' ? `Цена в объявлении: ${price}.` : `The listed price is ${price}.`) : phrase;
  const interest = `${hello}, ${en ? `thanks for your interest in ${ref}` : `спасибо за интерес к ${ref}`}.`;
  const rows = templates(analysis.intent, {
    hello, ref, priceBit, oneLine, twoLine, ask: askTime(lang), phrase, lang, tail, oneIds, twoIds,
  });
  if (lead.force_ask) {
    const ask = rows.find((item) => item && item.id === 'ask');
    if (ask) return [ask];
  }
  const bits = hasProfile(property) ? detailBits(property, lang) : [];
  if (bits.length) {
    const detail = `${interest} ${bits.join(', ')}.${tail}`;
    rows.push(row('details', 'Property details', 'Данные объекта', detail, []));
  }
  const limit = analysis.intent === 'viewing' ? 4 : 3;
  let chosen;
  if (!proposed || !proposed.start_utc || proposed.free == null) {
    chosen = ensurePrice(orderByIntent(rows.filter(Boolean), analysis.intent), rows, price, limit);
  } else if (proposed.free) {
    const confirm = row('confirm', 'Confirm their time', 'Подтвердить это время', `${interest} ${oneLine}${tail}`, oneIds);
    chosen = pickOptions(['confirm', 'one', 'two', 'price_time', 'price', 'details', 'view', 'ask'], rows, [confirm], limit, price);
  } else {
    const other = row('other', 'Suggest another time', 'Предложить другое время', `${interest} ${twoLine}${tail}`, twoIds);
    chosen = pickOptions(['other', 'one', 'two', 'price_time', 'price', 'details', 'view', 'ask'], rows, [other], limit, price);
  }
  const files = lead.title_match ? materialsOf(property) : [];
  if (!files.length) return chosen;
  const link = property.listing_url || '';
  const attached = link
    ? (lang === 'ru' ? `Презентация и материалы приложены: ${link}.` : `The brochure and files are attached: ${link}.`)
    : (lang === 'ru' ? 'Презентация и материалы приложены.' : 'The brochure and files are attached.');
  const extra = tail || !bits.length ? '' : `${bits.join(', ')}. `;
  const materials = row('materials', 'Send property files', 'Материалы объекта', `${interest} ${extra}${attached}${tail}`, []);
  materials.attachments = files;
  return placeMaterials(chosen, materials, price, limit);
}

function pickOptions(preferredIds, rows, extra, limit, price) {
  const all = [...extra, ...rows].filter(Boolean);
  const ordered = [];
  for (const id of preferredIds) {
    const found = all.find((item) => item.id === id);
    if (found && !ordered.some((item) => item.id === found.id)) ordered.push(found);
  }
  for (const item of all) {
    if (!ordered.some((row) => row.id === item.id)) ordered.push(item);
  }
  let chosen = ordered.slice(0, limit);
  if (price && !chosen.some((row) => row.text.includes(price))) {
    const priced = ordered.find((row) => row.text.includes(price));
    if (priced) chosen = [...chosen.slice(0, Math.max(0, limit - 1)), priced];
  }
  return chosen.slice(0, limit);
}

function templates(intent, c) {
  const en = c.lang === 'en';
  if (intent === 'viewing') {
    return [
      row('two', 'Offer two times', 'Два времени', `${c.hello}, ${en ? `thanks for your interest in ${c.ref}` : `спасибо за интерес к ${c.ref}`}. ${c.twoLine}${c.tail}`, c.twoIds),
      row('ask', 'Ask their time', 'Спросить время', `${c.hello}, ${en ? `thanks for your message about ${c.ref}` : `спасибо за сообщение по ${c.ref}`}. ${c.ask}${c.tail}`, []),
      row('one', 'One time', 'Одно время', `${c.hello}, ${en ? 'thanks for writing' : 'спасибо за сообщение'}. ${c.oneLine}${c.tail}`, c.oneIds),
      row('price_time', 'Price and a time', 'Цена и время', `${c.hello}, ${c.priceBit} ${c.oneLine}${c.tail}`, c.oneIds),
    ];
  }
  const common = [
    row('price', 'Listed price', 'Цена в объявлении', `${c.hello}, ${en ? `thanks for your interest in ${c.ref}` : `спасибо за интерес к ${c.ref}`}. ${c.priceBit}${c.tail}`),
    row('ask', 'Ask a detail', 'Уточнить', `${c.hello}, ${en ? `thanks for your message about ${c.ref}` : `спасибо за сообщение по ${c.ref}`}. ${c.phrase}`),
    row('view', 'Offer a time', 'Время показа', `${c.hello}, ${c.priceBit} ${c.oneLine}${c.tail}`, c.oneIds),
  ];
  return common;
}

function rewriteReplyTime(text, when, lang) {
  const note = lang === 'ru' ? '(Время ещё не зарезервировано.)' : '(Not reserved yet.)';
  const line = `${when}. ${note}`;
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return line;
  const idx = source.indexOf(note);
  if (idx === -1) return `${source} ${line}`.replace(/\s+/g, ' ').trim();
  const head = source.slice(0, idx);
  const cut = head.search(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|пн|вт|ср|чт|пт|сб|вс)\s+\d{1,2}/);
  const kept = (cut === -1 ? head : head.slice(0, cut)).trim();
  return `${kept} ${line}`.replace(/\s+/g, ' ').trim();
}

function row(id, labelEn, labelRu, text, slotIds) {
  return {
    id,
    label_en: labelEn,
    label_ru: labelRu,
    text: text.replace(/\s+/g, ' ').trim(),
    slot_ids: slotIds || [],
  };
}

function sentenceCount(text) {
  const stripped = String(text || '')
    .replace(/\(Not reserved yet\.\)/g, '')
    .replace(/\(Время ещё не зарезервировано\.\)/g, '')
    .replace(/AI-assisted message\.[^.]*\./g, '')
    .replace(/Сообщение подготовлено с помощью ИИ\.[^.]*\./g, '')
    .replace(/Reply STOP to opt out\./g, '')
    .replace(/Напишите STOP, чтобы отписаться\./g, '');
  const parts = stripped.split(/[.!?…]+(?=\s|$)/).map((part) => part.trim()).filter(Boolean);
  return parts.length;
}

module.exports = {
  buildOptions,
  formatPrice,
  slotPhrase,
  sentenceCount,
  rewriteReplyTime,
  materialsOf,
  orderByIntent,
  BROKER_EN,
  BROKER_RU,
  GREET_OTHER,
};
