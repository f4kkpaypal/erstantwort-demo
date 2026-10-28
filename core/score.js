'use strict';

const QUESTION_ASK = ['budget', 'financing', 'timeline'];

function bandEquity(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return 'unbekannt';
  if (ratio >= 0.2) return '≥20 %';
  if (ratio >= 0.1) return '10–20 %';
  if (ratio > 0) return '<10 %';
  return 'unbekannt';
}

function push(signals, code, points, reason) {
  signals.push({ code, points, reason: reason || null });
}

function scoreOwnerLead(input) {
  const signals = [];
  const horizon = input.timeline_horizon || input.sale_horizon || 'unbekannt';
  if (horizon === 'bis_3_monate') push(signals, 'urgency', 30, 'Verkauf in den nächsten 3 Monaten');
  else if (horizon === '3_bis_6_monate') push(signals, 'urgency', 15, 'Verkauf in 3 bis 6 Monaten');
  else if (horizon === 'ueber_6_monate') push(signals, 'urgency', 5, null);
  else push(signals, 'urgency', 0, null);

  const type = String(input.object_type || '').toLowerCase();
  const knownType = ['wohnung', 'haus', 'grundstueck', 'gewerbe'].includes(type);
  push(signals, 'object_type', knownType ? 10 : 0, knownType ? 'Objektart genannt' : null);

  const region = String(input.city || input.district || '').trim();
  push(signals, 'region', region ? 10 : 0, region ? 'Lage genannt' : null);

  const area = num(input.area_sqm);
  push(signals, 'area', area != null && area > 0 ? 10 : 0, area != null && area > 0 ? 'Fläche genannt' : null);

  if (input.valuation_requested === true) push(signals, 'valuation', 20, 'Bewertungstermin gewünscht');
  else push(signals, 'valuation', 0, null);

  if (String(input.phone || '').trim()) push(signals, 'phone', 5, null);
  else push(signals, 'phone', 0, null);

  const score = signals.reduce((sum, row) => sum + row.points, 0);
  const grade = score >= 60 ? 'HOT' : score >= 30 ? 'WARM' : 'COLD';
  const ranked = signals
    .filter((row) => row.reason && row.points > 0)
    .sort((a, b) => b.points - a.points || a.code.localeCompare(b.code));
  const reasons = [];
  for (const row of ranked) {
    if (reasons.length >= 3) break;
    if (!reasons.includes(row.reason)) reasons.push(row.reason);
  }
  return {
    score,
    grade,
    reasons,
    questions_to_ask: [],
    signals,
    equity_ratio_band: 'unbekannt',
    income_ok_flag: null,
  };
}

function scoreLead(input) {
  if (input && input.lead_kind === 'eigentuemer') return scoreOwnerLead(input);
  const inquiry = input.inquiry_type === 'miete' ? 'miete' : input.inquiry_type === 'kauf' ? 'kauf' : 'unbekannt';
  const signals = [];
  const price = num(input.price_eur);
  const budget = num(input.budget_max_eur);
  const equity = num(input.equity_eur);
  const kalt = num(input.kaltmiete_eur);
  const warm = num(input.warmmiete_eur);
  const incomeMin = num(input.income_min_eur);

  if (inquiry === 'kauf') {
    if (input.financing_status === 'barzahler') push(signals, 'financing', 30, 'Barzahler');
    else if (input.financing_status === 'finanzierungszusage') push(signals, 'financing', 30, 'Finanzierung bestätigt');
    else if (input.financing_status === 'in_pruefung') push(signals, 'financing', 15, null);
    else if (input.financing_status === 'nicht_geklaert') push(signals, 'financing', -10, null);
    else push(signals, 'financing', 0, null);

    if (budget != null && price) {
      const ratio = budget / price;
      if (ratio >= 0.95) push(signals, 'budget', 20, 'Budget passt');
      else if (ratio >= 0.8) push(signals, 'budget', 10, 'Budget passt');
      else push(signals, 'budget', -10, null);
    } else push(signals, 'budget', 0, null);

    if (equity != null && price) {
      const ratio = equity / price;
      if (ratio >= 0.2) push(signals, 'equity', 15, 'Eigenkapital ≥ 20 %');
      else if (ratio >= 0.1) push(signals, 'equity', 8, null);
      else push(signals, 'equity', 0, null);
    } else push(signals, 'equity', 0, null);
  } else if (inquiry === 'miete') {
    if (incomeMin != null && kalt) {
      const ratio = incomeMin / kalt;
      if (ratio >= 3) push(signals, 'income', 25, 'Einkommen ≥ 3× Kaltmiete');
      else if (ratio >= 2.5) push(signals, 'income', 10, null);
      else push(signals, 'income', 0, null);
    } else push(signals, 'income', 0, null);

    if (budget != null && warm && budget >= warm) push(signals, 'budget', 10, 'Budget passt');
    else push(signals, 'budget', 0, null);

    if (input.schufa_available === 'ja') push(signals, 'schufa', 10, null);
    else push(signals, 'schufa', 0, null);
  }

  if (input.timeline_horizon === 'bis_3_monate') push(signals, 'timeline', 20, 'Zeitrahmen ≤ 3 Monate');
  else if (input.timeline_horizon === '3_bis_6_monate') push(signals, 'timeline', 10, null);
  else push(signals, 'timeline', 0, null);

  if (input.viewing_requested) push(signals, 'viewing', 10, 'Besichtigungswunsch');
  else push(signals, 'viewing', 0, null);

  if (String(input.phone || '').trim()) push(signals, 'phone', 5, null);
  else push(signals, 'phone', 0, null);

  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (questions.length > 0) push(signals, 'question', 5, null);
  else push(signals, 'question', 0, null);

  const score = signals.reduce((sum, s) => sum + s.points, 0);
  let grade = score >= 60 ? 'HOT' : score >= 30 ? 'WARM' : 'COLD';
  const injection = input.injection_suspected === true;
  if (injection && grade === 'HOT') grade = 'WARM';

  const ranked = signals
    .filter((s) => s.reason && s.points > 0)
    .sort((a, b) => b.points - a.points || a.code.localeCompare(b.code));
  const reasons = [];
  if (injection) reasons.push('⚠ Prompt-Injection-Verdacht');
  for (const row of ranked) {
    if (reasons.length >= 3) break;
    if (!reasons.includes(row.reason)) reasons.push(row.reason);
  }

  const missing = Array.isArray(input.missing_fields) ? input.missing_fields : [];
  const questionsToAsk = QUESTION_ASK.filter((field) => missing.includes(field));

  let equityRatioBand = 'unbekannt';
  if (inquiry === 'kauf' && equity != null && price) equityRatioBand = bandEquity(equity / price);

  let incomeOk = null;
  if (inquiry === 'miete' && incomeMin != null && kalt) incomeOk = incomeMin / kalt >= 3;

  return {
    score,
    grade,
    reasons,
    questions_to_ask: questionsToAsk,
    signals,
    equity_ratio_band: equityRatioBand,
    income_ok_flag: incomeOk,
  };
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = { scoreLead, scoreOwnerLead, bandEquity };
