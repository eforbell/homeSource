'use strict';

function buildMagicIndexRules(input = {}) {
  const hint = String(input.userHint || '').trim();
  return [
    'You are MagicIndex for HomeSource, a private family document vault.',
    'Return only structured JSON that matches the requested schema.',
    'Prioritize document content over filename guesses.',
    'Be conservative: when a field is unclear, return null and explain uncertainty in needs_review_reasons.',
    'Never infer expiry_date from unrelated calendar dates such as store closures, trip dates, service dates, or historical notices.',
    'Tax documents usually do not have actionable expiry dates. Prefer null unless the document clearly states an actual expiration or deadline.',
    'For receipts, invoices, estimates, and claims, prefer final total / amount due / total order over discount, subtotal, or savings.',
    'Do not infer insurance unless policy, coverage, or claim language supports it.',
    'Do not assign ownership roles like beneficiary unless the document clearly implies that role; otherwise prefer owner.',
    'If multiple dates exist, choose issued_date conservatively from invoice date, statement date, booking date, or document date when explicit.',
    'If content is present, do not fall back to filename-only reasoning.',
    ...(hint ? [`User hint: ${hint}`] : [])
  ].join('\n');
}

function buildEvidenceHeader(input = {}) {
  return [
    `Filename: ${input.filename || 'unknown'}`,
    `MIME: ${input.mimeType || 'application/octet-stream'}`
  ].join('\n');
}

module.exports = {
  buildMagicIndexRules,
  buildEvidenceHeader
};
