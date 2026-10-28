'use strict';

const { analyze } = require('./analyze');

function numbersIn(text) {
  const found = new Set();
  const re = /(\d[\d\s.,]*\d|\d)/g;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const digits = match[1].replace(/[^\d]/g, '');
    if (digits) found.add(Number(digits));
  }
  return found;
}

async function analyzeWithLlm(text, deps) {
  const rules = analyze({ text }, { propertyKind: deps.propertyKind, senderName: deps.senderName });
  if (rules.intent === 'stop' || rules.flags.includes('injection_suspect') || rules.flags.includes('lang_other') || rules.flags.includes('non_text')) {
    return rules;
  }
  if (deps.channel === 'telegram') return rules;
  if (rules.intent !== 'unclear' && (rules.also || []).length < 2) return { ...rules, source: 'rules' };
  let raw;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.config?.LLM_TIMEOUT_MS || 5000);
    raw = await deps.llm({ text, signal: controller.signal });
    clearTimeout(timer);
  } catch {
    return { ...rules, source: 'rules' };
  }
  let parsed;
  try { parsed = JSON.parse(raw.content); } catch { return { ...rules, source: 'rules' }; }
  const allowed = new Set(['price', 'viewing', 'area', 'finance', 'docs', 'avail', 'details', 'unclear']);
  if (!allowed.has(parsed.intent)) return { ...rules, source: 'rules' };
  if (parsed.budget && parsed.budget.amount != null && !numbersIn(text).has(Number(parsed.budget.amount))) {
    return { ...rules, source: 'rules' };
  }
  return { ...rules, intent: parsed.intent, source: 'llm', confidence: parsed.confidence || 0.5 };
}

module.exports = { analyzeWithLlm };
