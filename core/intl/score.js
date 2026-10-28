'use strict';

const GRADE_RANK = { HOT: 0, WARM: 1, COLD: 2 };

function compareBudget(analysis, property, peg) {
  const budget = analysis.budget;
  if (!budget || budget.amount == null || !property) return { delta: 0, low: false };
  const same = budget.currency === property.currency;
  const pair = (budget.currency === 'USD' && property.currency === 'AED')
    || (budget.currency === 'AED' && property.currency === 'USD');
  if (!same && !pair) return { delta: 0, low: false };
  if (!budget.period) return { delta: 0, low: false };
  const rate = Number(peg) || 3.6725;
  let budgetYearOrTotal = budget.amount;
  let price = property.price;
  if (property.kind === 'sale') {
    if (budget.period !== 'total') return { delta: 0, low: false };
  } else {
    if (budget.period === 'month') budgetYearOrTotal = budget.amount * 12;
    else if (budget.period === 'year') budgetYearOrTotal = budget.amount;
    else return { delta: 0, low: false };
    if (property.price_period === 'month') price = property.price * 12;
  }
  const budgetUsd = budget.currency === 'AED' ? budgetYearOrTotal / rate : budgetYearOrTotal;
  const priceUsd = property.currency === 'AED' ? price / rate : price;
  if (!priceUsd) return { delta: 0, low: false };
  const ratio = budgetUsd / priceUsd;
  if (ratio >= 0.9) return { delta: 10, low: false, ratio };
  if (ratio < 0.6) return { delta: -10, low: true, ratio };
  return { delta: 0, low: false, ratio };
}

function scoreChat(analysis, property, peg = 3.6725) {
  if (!analysis || analysis.intent === 'stop') {
    return { score: 0, grade: 'COLD', reasons: ['Opted out'] };
  }
  if (analysis.intent === 'unclear') {
    const score = analysis.budget && analysis.budget.amount != null ? 15 : 0;
    return { score, grade: gradeOf(score, false), reasons: score ? ['Named a budget'] : ['Message was not understood'] };
  }
  let score = 10;
  const reasons = [];
  const intentPoints = { viewing: 35, docs: 20, price: 15, finance: 15, avail: 15, area: 10, details: 10 };
  score += intentPoints[analysis.intent] || 0;
  if (analysis.intent === 'viewing') reasons.push('Asked for a viewing');
  else if (analysis.intent === 'price') reasons.push('Asked about the price');
  else if (analysis.intent === 'finance') reasons.push('Asked about payment');
  else if (analysis.intent === 'docs') reasons.push('Asked about documents');
  else if (analysis.intent === 'avail') reasons.push('Asked if it is available');
  else if (analysis.intent === 'area') reasons.push('Asked about the area');
  else if (analysis.intent === 'details') reasons.push('Asked about the property');
  score += Math.min(10, (analysis.also || []).length * 5);
  const timing = analysis.timing?.class;
  if (timing === 'concrete') {
    score += 25;
    reasons.push('Wants a concrete time');
  } else if (timing === 'months_le3') {
    score += 15;
    reasons.push('Wants this within 3 months');
  } else if (timing === 'other') {
    score += 10;
  }
  if (analysis.budget && analysis.budget.amount != null) {
    score += 15;
    reasons.push('Named a budget');
  }
  const compared = compareBudget(analysis, property, peg);
  score += compared.delta;
  if (compared.delta > 0) reasons.push('Named a budget close to the price');
  if (compared.low) reasons.push('budget well below price');
  if (analysis.cash) {
    score += 10;
    reasons.push('Pays in cash');
  }
  score = Math.max(0, score);
  const grade = gradeOf(score, compared.low);
  return { score, grade, reasons: reasons.slice(0, 3), budget_low: compared.low };
}

function gradeOf(score, low) {
  let grade = 'COLD';
  if (score >= 60) grade = 'HOT';
  else if (score >= 30) grade = 'WARM';
  if (low && grade === 'HOT') grade = 'WARM';
  return grade;
}

function sortLeads(leads, mode) {
  return leads.slice().sort((a, b) => {
    const ga = GRADE_RANK[a.grade] ?? 9;
    const gb = GRADE_RANK[b.grade] ?? 9;
    if (ga !== gb) return ga - gb;
    if (mode !== 'digest' && (b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return String(a.first_msg_at || '').localeCompare(String(b.first_msg_at || ''));
  });
}

module.exports = { scoreChat, compareBudget, gradeOf, sortLeads };
