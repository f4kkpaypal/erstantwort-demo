'use strict';

// Keyword readiness for the inbox. Independent of the published numeric grade
// (fixtures/intl/testset.json): that score stays the digest contract.
// HOT wins over WARM. A message with no concrete ask is COLD.

const READY_RANK = { HOT: 0, WARM: 1, COLD: 2 };

// A viewing is the strongest broker signal: the person wants to be in the unit.
const HOT_VIEW = /(?<![\p{L}\p{N}])(view(?:ing)?s?|visit(?:ing)?|tour|appointment|open house|come (?:by|over)|see (?:it|the (?:apartment|flat|place|property|unit)))(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(посмотреть|просмотр|осмотр|записаться|приехать|приеду)(?![\p{L}\p{N}])/iu;

// Today / tomorrow / asap means they are scheduling, not browsing.
const HOT_URGENT = /(?<![\p{L}\p{N}])(today|tomorrow|tonight|asap|as soon as possible|right away|urgent(?:ly)?|this weekend)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(сегодня|завтра|срочно|как можно скорее|на выходных)(?![\p{L}\p{N}])/iu;

// Naming cash or a decision to buy/sign is commitment, not a price question.
const HOT_PAY = /(?<![\p{L}\p{N}])(cash|ready to buy|ready to sign|ready to pay|want to buy|i(?:'|’)ll take it|i will take it)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(наличн\p{L}*|хочу купить|готов(?:а|ы)? купить|готов(?:а|ы)? подписать|готов(?:а|ы)? оплатить)(?![\p{L}\p{N}])/iu;

// "What is the deposit?" stays a question. Paying or putting a deposit does not.
const HOT_DEPOSIT = /(?<![\p{L}\p{N}])(?:pay(?:ing)?|put(?:ting)?|transfer(?:ring)?)(?:\s+\p{L}+){0,3}\s+deposit(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])deposit\s+(?:ready|today|tomorrow)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(внес(?:у|ти|ём)|задаток)(?![\p{L}\p{N}])/iu;

// A clock or a named day is a concrete slot, not small talk.
const HOT_CLOCK = /(?<![\p{L}\p{N}])\d{1,2}[:.]\d{2}\s*(?:am|pm)?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d{1,2}\s*(?:am|pm)(?![\p{L}\p{N}])/iu;
const HOT_DAY = /(?<![\p{L}\p{N}])(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(понедельник|вторник|сред[ауы]|четверг|пятниц[ауи]|суббот[ауи]|воскресень\p{L}*)(?![\p{L}\p{N}])/iu;
const HOT_DATE = /(?<![\p{L}\p{N}])\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:январ\p{L}*|феврал\p{L}*|марта|апрел\p{L}*|мая|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*)\s+\d{1,2}(?![\d])/iu;

// Clarifying questions: interest without a decision.
const WARM_EN = /(?<![\p{L}\p{N}])(price|prices|cost|how much|how many|bedrooms?|rooms?|where|location|neighbourhood|neighborhood|area|district|available|mortgage|installments?|instalments?|documents?|deposit|size|sqft|sqm|floor|balcony)(?![\p{L}\p{N}])/iu;
const WARM_RU = /(какая цен|сколько стоит|сколько комнат|сколько спал|где(?:\s+это|\s+находится|\s+район)?|район|локац|наличи|ипотек|документ|депозит|площад|этаж|балкон)/iu;
const PROPERTY_NOUN = /(?<![\p{L}\p{N}])(apartment|flat|villa|property|unit|house|studio)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(квартир\p{L}*|апартамент\p{L}*|вилл\p{L}*|объект\p{L}*|студи\p{L}*)(?![\p{L}\p{N}])/iu;

function classifyReadiness(text, analysis) {
  if (analysis && analysis.intent === 'stop') return { label: 'COLD', hits: ['optout'] };
  const clean = String(text || '').toLowerCase().trim();
  if (!clean) return { label: 'COLD', hits: ['empty'] };
  const hits = [];
  if (HOT_VIEW.test(clean)) hits.push('viewing');
  if (HOT_URGENT.test(clean)) hits.push('urgent');
  if (HOT_PAY.test(clean)) hits.push('payment');
  if (HOT_DEPOSIT.test(clean)) hits.push('deposit');
  if (HOT_CLOCK.test(clean)) hits.push('clock');
  if (HOT_DAY.test(clean)) hits.push('day');
  if (HOT_DATE.test(clean)) hits.push('date');
  if (hits.length) return { label: 'HOT', hits };
  const warm = [];
  if (WARM_EN.test(clean)) warm.push('question');
  if (WARM_RU.test(clean)) warm.push('question_ru');
  if (clean.includes('?') && PROPERTY_NOUN.test(clean)) warm.push('property_question');
  if (warm.length) return { label: 'WARM', hits: warm };
  return { label: 'COLD', hits: ['no_signal'] };
}

function readinessRank(lead) {
  return READY_RANK[lead && lead.readiness] ?? READY_RANK[lead && lead.grade] ?? 9;
}

module.exports = {
  classifyReadiness,
  readinessRank,
  READY_RANK,
  HOT_VIEW,
  HOT_URGENT,
  HOT_PAY,
  HOT_DEPOSIT,
  HOT_CLOCK,
  HOT_DAY,
  HOT_DATE,
  WARM_EN,
  WARM_RU,
};
