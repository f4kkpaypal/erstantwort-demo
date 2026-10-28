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
  const zone = property.tz || 'Asia/Dubai';
  const dt = DateTime.fromISO(slot.start_utc || slot, { setZone: true }).setZone(zone);
  const dow = lang === 'ru' ? DOW_RU[dt.weekday - 1] : DOW_EN[dt.weekday - 1];
  const mon = lang === 'ru' ? MON_RU[dt.month - 1] : MON_EN[dt.month - 1];
  const label = property[lang === 'ru' ? 'tz_label_ru' : 'tz_label_en'] || zone;
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

function buildOptions(lead, property, slots, broker) {
  const analysis = lead.analysis || lead;
  if (['stop', 'unclear'].includes(analysis.intent)) return [];
  if ((analysis.flags || []).some((flag) => ['injection_suspect', 'lang_other', 'non_text', 'optout'].includes(flag))) return [];
  const lang = analysis.language === 'ru' ? 'ru' : 'en';
  const name = (lead.name && lead.name.name) || lead.clean_name || '';
  const ref = refOf(property, lang);
  const price = priceOf(property, lang);
  const phrase = lang === 'ru' ? BROKER_RU : BROKER_EN;
  const used = (slots || []).slice(0, 2);
  const free = used.map((slot) => slotPhrase(slot, property, lang));
  const slotIds = used.map((slot) => slot.id).filter(Boolean);
  const reserved = free[0]?.note || (lang === 'ru' ? '(Время ещё не зарезервировано.)' : '(Not reserved yet.)');
  const slotLine = free.length
    ? `${free.map((slot) => slot.when).join(lang === 'ru' ? ' или ' : ' or ')}. ${reserved}`
    : askTime(lang);
  const needPhrase = ['docs', 'finance', 'details', 'area', 'avail'].includes(analysis.intent) || analysis.asks_discount === true;
  const tail = needPhrase ? ` ${phrase}` : '';
  const hello = hi(name, lang);
  const priceBit = price ? (lang === 'ru' ? `Цена в объявлении: ${price}.` : `The listed price is ${price}.`) : phrase;
  const rows = templates(analysis.intent, { hello, ref, priceBit, slotLine, ask: askTime(lang), phrase, lang, tail, slotIds });
  return rows.filter(Boolean).slice(0, analysis.intent === 'viewing' ? 4 : 3);
}

function templates(intent, c) {
  const en = c.lang === 'en';
  if (intent === 'viewing') {
    return [
      row('two', 'Offer two times', 'Два времени', `${c.hello}, ${en ? `thanks for your interest in ${c.ref}` : `спасибо за интерес к ${c.ref}`}. ${c.slotLine}${c.tail}`, c.slotIds),
      row('ask', 'Ask their time', 'Спросить время', `${c.hello}, ${en ? `thanks for your message about ${c.ref}` : `спасибо за сообщение по ${c.ref}`}. ${c.ask}${c.tail}`, []),
      row('one', 'One time', 'Одно время', `${c.hello}, ${en ? 'thanks for writing' : 'спасибо за сообщение'}. ${c.slotLine}${c.tail}`, c.slotIds),
      row('price_time', 'Price and a time', 'Цена и время', `${c.hello}, ${c.priceBit} ${c.slotLine}${c.tail}`, c.slotIds),
    ];
  }
  const common = [
    row('price', 'Listed price', 'Цена в объявлении', `${c.hello}, ${en ? `thanks for your interest in ${c.ref}` : `спасибо за интерес к ${c.ref}`}. ${c.priceBit}${c.tail}`),
    row('ask', 'Ask a detail', 'Уточнить', `${c.hello}, ${en ? `thanks for your message about ${c.ref}` : `спасибо за сообщение по ${c.ref}`}. ${c.phrase}`),
    row('view', 'Offer a time', 'Время показа', `${c.hello}, ${c.priceBit} ${c.slotLine}${c.tail}`, c.slotIds),
  ];
  return common;
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
  BROKER_EN,
  BROKER_RU,
};
