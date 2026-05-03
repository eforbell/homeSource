'use strict';

function parseMoneyValue(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/,/g, '')
    .replace(/\bUSD\b/ig, '')
    .replace(/\$/g, '')
    .trim();
  const match = cleaned.match(/-?\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function normalizeLabel(label) {
  return String(label || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function labelScore(label) {
  const normalized = normalizeLabel(label);
  if (!normalized) return 0;
  if (/\b(total|invoice total|total cost|grand total|final total|amount due|balance due|amount paid|total amount|payment total|total fee|total premium)\b/.test(normalized)) return 100;
  if (/\b(balance|premium|charge amount|amount|payment)\b/.test(normalized)) return 70;
  if (/\b(subtotal)\b/.test(normalized)) return 40;
  if (/\b(discount|rebate|savings|credit)\b/.test(normalized)) return 10;
  return 0;
}

function hasCurrencyEvidence(rawValue) {
  const raw = String(rawValue || '');
  return /\$|\bUSD\b|\bUS dollars?\b/i.test(raw);
}

function chooseBestMoneyCandidate(candidates = []) {
  const viable = candidates.filter((candidate) => Number.isFinite(candidate.value));
  if (!viable.length) return null;
  viable.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.confidence || 0) !== (a.confidence || 0)) return (b.confidence || 0) - (a.confidence || 0);
    return Math.abs(b.value || 0) - Math.abs(a.value || 0);
  });
  const best = viable[0];
  return {
    value: best.value,
    currency: best.currency || 'USD',
    confidence: best.confidence ?? 0,
    source: best.source,
    raw_value: best.raw_value,
    raw_label: best.raw_label || null
  };
}

function inferAmountFromKeyFacts(keyFacts = []) {
  const candidates = [];
  for (const fact of keyFacts) {
    const value = parseMoneyValue(fact?.value);
    if (!Number.isFinite(value)) continue;
    const score = labelScore(fact?.label);
    if (score <= 0 && !hasCurrencyEvidence(fact?.value)) continue;
    candidates.push({
      value,
      currency: 'USD',
      confidence: Number(fact?.confidence) || 0,
      source: 'key_fact',
      raw_value: String(fact?.value || ''),
      raw_label: String(fact?.label || ''),
      score
    });
  }
  return chooseBestMoneyCandidate(candidates);
}

function inferAmountFromSummary(summary = '') {
  const value = parseMoneyValue(summary);
  if (!Number.isFinite(value)) return null;
  return {
    value,
    currency: 'USD',
    confidence: 0.4,
    source: 'summary',
    raw_value: summary,
    raw_label: null
  };
}

function normalizeMoney(rawAmount, keyFacts = [], summary = '') {
  const directValue = Number(rawAmount?.value);
  if (rawAmount && Number.isFinite(directValue)) {
    return {
      value: directValue,
      currency: String(rawAmount.currency || 'USD').toUpperCase().slice(0, 3) || 'USD',
      confidence: Number.isFinite(Number(rawAmount.confidence)) ? Number(rawAmount.confidence) : 0,
      source: 'amount',
      raw_value: rawAmount.value,
      raw_label: null
    };
  }

  const keyFactAmount = inferAmountFromKeyFacts(keyFacts);
  if (keyFactAmount) return keyFactAmount;

  const summaryAmount = inferAmountFromSummary(summary);
  if (summaryAmount) return summaryAmount;

  return null;
}

module.exports = {
  parseMoneyValue,
  normalizeLabel,
  labelScore,
  inferAmountFromKeyFacts,
  inferAmountFromSummary,
  normalizeMoney,
  hasCurrencyEvidence
};
