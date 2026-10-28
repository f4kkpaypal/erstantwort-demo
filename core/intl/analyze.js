'use strict';

const { normalize, parseAmount, applySuffix } = require('./normalize');

const PRIORITY = ['price', 'finance', 'docs', 'viewing', 'area', 'avail', 'details'];
const EN_WORDS = new Set('the is a an i you can do does what how hi hello please it to for in on at my we your this that are when have want'.split(' '));

const INTENT = {
  price: { en: /\b(price|cost|how much|how much is|discount|negotiat\w*|lower the price|reduce|cheaper|best offer|go down|стоит)\b/i, ru: /(сколько стоит|стоит|цен[ауые]|стоимост|скидк|торг|снизить|дешевле|уступ)/i },
  finance: { en: /\b(mortgage|installments?|instalments?|payment plan|financing|finance|loan|down ?payment)\b/i, ru: /(ипотек|рассрочк|кредит|первоначальн|план платеж)/i },
  docs: { en: /\b(documents?|paperwork|passport|visa|contract|ejari|deposit|requirements?)\b/i, ru: /(документ|паспорт|виз[ауы]|договор|депозит|требовани)/i },
  viewing: { en: /\b(view(?:ing)?|visit|see (?:it|the|this)|come (?:by|over|on)|can i come|tour|appointment|book a)\b/i, ru: /(посмотреть|показ|просмотр|приехать|увидеть|записаться|осмотр)/i },
  area: { en: /\b(area|neighbou?rhood|nearby|close to|near|beach|school|metro|transport|district|location|surroundings)\b/i, ru: /(район|рядом|недалеко|окрестност|школ|пляж|метро|транспорт|инфраструктур)/i },
  avail: { en: /\b(still available|available|vacant|free now|is it taken|still free|still on)\b/i, ru: /(свободн|актуальн|ещё в продаже|еще в продаже|не сдан|не продан)/i },
  details: { en: /\b(pool|floors?|parking|furnished|balcony|gym|pets?|bills|size|bedrooms?|elevator|lift|view from|sqft|sqm)\b/i, ru: /(бассейн|этаж|парковк|меблир|балкон|питомц|животн|лифт|площад)/i },
};

const STOP_EXACT = new Set(['stop', 'стоп', 'unsubscribe', 'отписаться', 'توقف']);
const STOP_PHRASE = /stop messaging|stop texting|stop calling|stop writing|stop contacting|do not contact|don't contact|don't write|do not write|don't message me|do not message me|leave me alone|please stop|remove me|не пишите|не пиши|не беспокойте|отпишите|прекратите писать|хватит писать|пожалуйста,\s*стоп|пожалуйста стоп|удалите меня|уберите меня|больше не пишите|لا تراسلني|توقف عن مراسلتي/i;
const STOP_TOKEN = /(?<![\p{L}\p{N}-])(stop|стоп|توقف|unsubscribe|отписаться)(?![\p{L}\p{N}-])/giu;
const INJECT = /ignore (?:all )?(?:previous|above) instructions|system prompt|you are now|игнорируй (?:все )?(?:предыдущие|прошлые) инструкции/i;
const CASH = /наличн|\bcash\b/i;
const DISCOUNT = /discount|negotiat|lower the price|\breduce\b|cheaper|best offer|go down to|can you do|скидк|торг|снизить|дешевле|уступ/i;
const LINK = /https?:\/\/\S+|\bwww\.\S+|\bclick here\b/i;

const MONTH = /per month|a month|monthly|\/month|\/mo|\bpm\b|в месяц|ежемесячно|\/мес|per bulan/i;
const YEAR = /per year|a year|yearly|annually|p\.a\.|\/year|\/yr|в год|за год|ежегодно|годовых/i;
const DURATION = /(?:for|на)\s+\d+\s+(?:months?|месяц(?:ев|а)?)/i;

function letterStats(clean) {
  const letters = [...clean].filter((ch) => /\p{L}/u.test(ch));
  const cyr = letters.filter((ch) => /\p{Script=Cyrillic}/u.test(ch)).length;
  const lat = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  const arab = letters.filter((ch) => /\p{Script=Arabic}/u.test(ch)).length;
  return { letters: letters.length, cyr, lat, arab };
}

function detectLanguage(clean) {
  const stats = letterStats(clean);
  if (!stats.letters) return 'other';
  if (stats.arab && stats.arab >= stats.cyr && stats.arab >= stats.lat) return 'other';
  if (stats.cyr / stats.letters >= 0.5) return 'ru';
  if (stats.lat >= stats.cyr) {
    const words = clean.split(/\s+/);
    const hits = words.filter((word) => EN_WORDS.has(word.replace(/[^\p{L}]/gu, ''))).length;
    const keyword = PRIORITY.some((name) => INTENT[name].en.test(clean));
    if (hits >= 2 || keyword) return 'en';
    return 'other';
  }
  return 'other';
}

const SUFFIX = '(?:mn|млн|тыс|k|к|m)';
const WORD_SCALE = /^\s*(million|millions|mln|млн|миллионов|миллиона|миллион|thousand|thousands|тысяча|тысячи|тысяч)(?!\p{L})/iu;

function scaleAfter(clean, index, amount) {
  const suffix = suffixAt(clean, index);
  if (suffix.suffix) return { amount: Math.round(applySuffix(amount, suffix.suffix)), end: index + suffix.length };
  const word = clean.slice(index).match(WORD_SCALE);
  if (!word) return { amount: Math.round(amount), end: index };
  const token = word[1].toLowerCase();
  const factor = /^(thousand|thousands|тысяча|тысячи|тысяч)$/.test(token) ? 1000 : 1000000;
  return { amount: Math.round(amount * factor), end: index + word[0].length };
}

function isOptOut(clean) {
  if (STOP_PHRASE.test(clean)) return true;
  const exact = clean.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (STOP_EXACT.has(exact)) return true;
  STOP_TOKEN.lastIndex = 0;
  let hit;
  while ((hit = STOP_TOKEN.exec(clean))) {
    const before = clean.slice(0, hit.index).trim();
    const after = clean.slice(hit.index + hit[0].length).trim();
    const prev = (before.split(/\s+/).pop() || '').replace(/[^\p{L}]/gu, '');
    const next = (after.replace(/^[^\p{L}\p{N}]+/u, '').split(/\s+/)[0] || '').replace(/[^\p{L}]/gu, '');
    if (prev === 'bus' || prev === 'pit' || prev === 'non') continue;
    if (next === 'by') continue;
    const atStart = before === '';
    const atEnd = after === '';
    const afterPunct = /[\p{P}]$/u.test(before);
    if (atStart || atEnd || afterPunct) return true;
  }
  return false;
}

function suffixAt(text, index) {
  const match = text.slice(index).match(new RegExp(`^\\s*(${SUFFIX})(?!\\p{L})`, 'iu'));
  if (!match) return { suffix: '', length: 0 };
  return { suffix: match[1], length: match[0].length };
}

function firstMoney(clean) {
  const patterns = [
    /(?:\$|€|\b(?:usd|aed|eur|idr|dh|rp)\b|долл\w*|дирхам\w*|dirham\w*|dollars?)\s*(\d[\d\s.,]*\d|\d)/giu,
    /(\d[\d\s.,]*\d|\d)\s*(?=\s*(?:\$|€|\b(?:usd|aed|eur|idr|dh|rp)\b|dirham\w*|дирхам\w*|долл\w*|евро\b|dollars?|million|millions|mln|млн|миллион|thousand|thousands|тысяч))/giu,
  ];
  let best = null;
  for (const re of patterns) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    let match;
    while ((match = global.exec(clean))) {
      const amountRaw = match[1];
      const amount = parseAmount(amountRaw);
      if (amount == null) continue;
      const after = match.index + match[0].length;
      const scaled = scaleAfter(clean, after, amount);
      const tail = clean.slice(scaled.end, scaled.end + 24);
      const chunk = `${match[0]} ${clean.slice(after, scaled.end)} ${tail}`.toLowerCase();
      let currency = null;
      if (/\$|\busd\b|долл|dollar/.test(chunk)) currency = 'USD';
      else if (/\baed\b|\bdh\b|дирхам|dirham/.test(chunk)) currency = 'AED';
      else if (/€|\beur\b|евро/.test(chunk)) currency = 'EUR';
      else if (/\brp\b|\bidr\b|juta|\bjt\b/.test(chunk)) currency = 'other';
      if (!currency) continue;
      if (!best || match.index < best.index) {
        best = {
          index: match.index,
          amount: scaled.amount,
          currency,
          end: scaled.end,
        };
      }
    }
  }
  if (!best && /\bjuta\b|\bjt\b/.test(clean)) {
    return { amount: null, currency: 'other', period: null, unsupported: true };
  }
  return best;
}

function periodNear(clean, money) {
  if (!money || money.index == null) return null;
  const left = Math.max(0, clean.lastIndexOf('.', money.index));
  const rightDot = clean.indexOf('.', money.end);
  const sentence = clean.slice(left, rightDot === -1 ? clean.length : rightDot);
  if (MONTH.test(sentence) || MONTH.test(clean)) {
    const window = clean.slice(Math.max(0, money.index - 40), money.end + 40);
    if (MONTH.test(window)) return 'month';
  }
  const window = clean.slice(Math.max(0, money.index - 48), money.end + 48);
  if (MONTH.test(window)) return 'month';
  if (YEAR.test(window)) return 'year';
  return null;
}

function detectTiming(clean) {
  const within = clean.match(/within\s+(\d+)\s+months?|в течение\s+(\d+)\s+мес/);
  if (within) {
    const n = Number(within[1] || within[2]);
    if (n <= 3) return { class: 'months_le3', label_en: `within ${n} months`, label_ru: `в течение ${n} мес.` };
    return { class: 'other', label_en: `within ${n} months`, label_ru: `в течение ${n} мес.` };
  }
  if (/this week|на этой неделе|выходн|weekend/.test(clean)) {
    return { class: 'concrete', label_en: /weekend|выходн/.test(clean) ? 'weekend' : 'this week', label_ru: /выходн/.test(clean) ? 'на выходных' : 'на этой неделе' };
  }
  if (/\btoday\b|сегодня/.test(clean)) return { class: 'concrete', label_en: 'today', label_ru: 'сегодня' };
  if (/\btomorrow\b|завтра/.test(clean)) return { class: 'concrete', label_en: 'tomorrow', label_ru: 'завтра' };
  const day = clean.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (day) {
    const label = day[1][0].toUpperCase() + day[1].slice(1);
    return { class: 'concrete', label_en: label, label_ru: label };
  }
  if (/long stay|long[- ]term|длительн/.test(clean)) return { class: 'other', label_en: 'long stay', label_ru: 'длительное проживание' };
  if (DURATION.test(clean)) return { class: 'other', label_en: 'stay length', label_ru: 'срок аренды' };
  return null;
}

function countIntent(clean) {
  const score = {};
  for (const name of PRIORITY) {
    let hits = 0;
    for (const lang of ['en', 'ru']) {
      const re = INTENT[name][lang];
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      hits += (clean.match(global) || []).length;
    }
    score[name] = hits;
  }
  return score;
}

function bareBudget(clean) {
  const match = clean.match(/(?:budget|бюджет)\D{0,20}(\d[\d\s.,]*\d|\d)/iu);
  if (!match) return null;
  const amount = parseAmount(match[1]);
  if (amount == null) return null;
  const scaled = scaleAfter(clean, match.index + match[0].length, amount);
  return {
    index: match.index,
    amount: scaled.amount,
    end: scaled.end,
    currency: null,
  };
}

function budgetFor(clean, propertyKind, propertyCurrency) {
  const money = firstMoney(clean) || bareBudget(clean);
  if (!money) return { budget: null, flags: [] };
  const flags = [];
  let currency = money.currency;
  if (!currency && (propertyCurrency === 'USD' || propertyCurrency === 'AED')) {
    currency = propertyCurrency;
    flags.push('budget_currency_assumed');
  }
  if (currency === 'EUR' || currency === 'other') flags.push('budget_cur_unsupported');
  let period = periodNear(clean, money);
  if (!period) {
    if (propertyKind === 'sale') period = 'total';
    else if (propertyKind === 'rent') flags.push('budget_period_unclear');
  }
  return {
    budget: { amount: money.amount, currency: currency || null, period: period || null },
    flags,
  };
}

function sanitizeName(senderName) {
  const first = String(senderName || '').trim().split(/\s+/)[0] || '';
  if (!first || first.length > 30 || /\d|https?:|www\./i.test(first)) return { name: '', sanitized: Boolean(senderName) };
  if (!/^[\p{L}'-]+$/u.test(first)) return { name: '', sanitized: true };
  return { name: first, sanitized: false };
}

function stopLanguage(clean, detected) {
  if (/\p{Script=Cyrillic}/u.test(clean)) return 'ru';
  if (/\p{Script=Arabic}/u.test(clean)) return 'other';
  if (detected === 'en' || /\b(stop|unsubscribe|please|remove|messaging|contact|write|calling|texting)\b/.test(clean)) return 'en';
  return detected;
}

function analyze(msg, ctx = {}) {
  const kind = msg?.kind || 'text';
  if (kind === 'non_text') {
    return {
      language: 'other',
      intent: 'unclear',
      also: [],
      asks_discount: false,
      budget: null,
      timing: null,
      cash: false,
      flags: ['review', 'non_text'],
      confidence: 1,
      source: 'rules',
      name: sanitizeName(ctx.senderName),
    };
  }
  const norm = normalize(msg?.text || '');
  if (!norm.clean || norm.length > 2000) {
    return {
      language: 'other',
      intent: 'unclear',
      also: [],
      asks_discount: false,
      budget: null,
      timing: null,
      cash: false,
      flags: norm.clean ? ['review'] : ['review', 'lang_other'],
      confidence: 0,
      source: 'rules',
      name: sanitizeName(ctx.senderName),
    };
  }
  const language = detectLanguage(norm.clean);
  if (isOptOut(norm.clean)) {
    return base({ language: stopLanguage(norm.clean, language), intent: 'stop', flags: ['optout'], confidence: 1 }, ctx);
  }
  if (INJECT.test(norm.clean)) {
    return base({ language, intent: 'unclear', flags: ['review', 'injection_suspect'], confidence: 1 }, ctx);
  }
  if (language === 'other') {
    const flags = ['review', 'lang_other'];
    if (LINK.test(norm.clean)) flags.splice(1, 0, 'link');
    return base({ language, intent: 'unclear', flags, confidence: 1 }, ctx);
  }
  const counts = countIntent(norm.clean);
  const ranked = PRIORITY.filter((name) => counts[name] > 0)
    .sort((a, b) => counts[b] - counts[a] || PRIORITY.indexOf(a) - PRIORITY.indexOf(b));
  const flags = [];
  let budget = null;
  let timing = null;
  const cash = CASH.test(norm.clean);
  const asksDiscount = DISCOUNT.test(norm.clean);
  if (asksDiscount) flags.push('asks_discount');
  if (LINK.test(norm.clean)) flags.push('link');
  if (!ranked.length) {
    const money = budgetFor(norm.clean, ctx.propertyKind, ctx.propertyCurrency);
    flags.push('review', ...money.flags);
    return base({
      language,
      intent: 'unclear',
      flags: unique(flags),
      budget: money.budget,
      asks_discount: asksDiscount,
      cash,
      confidence: 0.2,
    }, ctx);
  }
  const money = budgetFor(norm.clean, ctx.propertyKind, ctx.propertyCurrency);
  budget = money.budget;
  flags.push(...money.flags);
  if (asksDiscount && budget && budget.currency && !ranked.includes('price')) ranked.push('price');
  timing = detectTiming(norm.clean);
  if (timing && DURATION.test(norm.clean) && timing.class === 'other' && /выходн|weekend|this week|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday/.test(norm.clean)) {
    timing = detectTiming(norm.clean.replace(DURATION, ' '));
  }
  return base({
    language,
    intent: ranked[0],
    also: ranked.slice(1),
    asks_discount: asksDiscount,
    budget,
    timing,
    cash,
    flags: unique(flags),
    confidence: 0.9,
  }, ctx);
}

function base(partial, ctx) {
  return {
    language: partial.language,
    intent: partial.intent,
    also: partial.also || [],
    asks_discount: partial.asks_discount === true,
    budget: partial.budget || null,
    timing: partial.timing || null,
    cash: partial.cash === true,
    flags: partial.flags || [],
    confidence: partial.confidence,
    source: 'rules',
    name: sanitizeName(ctx.senderName),
  };
}

function unique(list) {
  return [...new Set(list)];
}

module.exports = { analyze, detectLanguage, sanitizeName, PRIORITY };
