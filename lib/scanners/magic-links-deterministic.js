'use strict';

const { pool } = require('../db');
const { upsertSuggestedLink } = require('../magic-links');
const { normalizeKeyFactKey } = require('../magic-index/schema');

function normalizeValue(value) {
  return String(value || '').trim().toLowerCase();
}

function factMap(doc) {
  const facts = new Map();
  const keyFacts = doc.metadata?.magicindex?.suggestions?.key_facts || [];
  for (const fact of keyFacts) {
    if (!fact?.value) continue;
    const key = normalizeKeyFactKey(fact.key || fact.label);
    if (!key || facts.has(key)) continue;
    facts.set(key, String(fact.value).trim());
  }
  return facts;
}

function ownerNames(doc) {
  const owners = doc.metadata?.magicindex?.suggestions?.suggested_owners || [];
  return owners.map((owner) => normalizeValue(owner.member_name)).filter(Boolean).sort();
}

function sameOwners(docA, docB) {
  const a = ownerNames(docA);
  const b = ownerNames(docB);
  if (!a.length || !b.length || a.length !== b.length) return false;
  return a.every((value, idx) => value === b[idx]);
}

function parsePeriod(value) {
  const text = String(value || '');
  const match = text.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}).*?(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const start = Date.parse(match[1]);
  const end = Date.parse(match[2]);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

function hasRevisionHint(doc) {
  const haystack = `${doc.title || ''} ${doc.metadata?.magicindex?.suggestions?.summary || ''}`.toLowerCase();
  return /\b(renewal|amended|revised|updated|replacement|reprint|change order|corrected)\b/.test(haystack);
}

function newerByDate(a, b, field) {
  const av = a[field] ? Date.parse(a[field]) : NaN;
  const bv = b[field] ? Date.parse(b[field]) : NaN;
  if (Number.isNaN(av) || Number.isNaN(bv) || av === bv) return null;
  return av > bv ? [a, b] : [b, a];
}

function isOcrDerived(doc) {
  const source = doc.metadata?.magicindex?.suggestions?.extraction_evidence?.source
    || doc.metadata?.magicindex?.extraction_evidence?.source;
  return source === 'pdf_ocr_preview' || source === 'image_ocr_preview';
}

function hasLikelyOcrVinInsertion(a, b, vinA, vinB, plateA, plateB) {
  if (!plateA || plateA !== plateB || !isOcrDerived(a) || !isOcrDerived(b)) return false;
  const [shorter, longer] = vinA.length < vinB.length ? [vinA, vinB] : [vinB, vinA];
  if (shorter.length !== 17 || longer.length !== 18) return false;
  for (let index = 0; index < longer.length; index++) {
    if (longer.slice(0, index) + longer.slice(index + 1) === shorter) return true;
  }
  return false;
}

function candidateInsuranceSupersede(a, b) {
  if (a.document_type !== 'insurance' || b.document_type !== 'insurance') return null;
  const factsA = factMap(a);
  const factsB = factMap(b);
  const policyA = normalizeValue(factsA.get('policy_number'));
  const policyB = normalizeValue(factsB.get('policy_number'));
  if (!policyA || policyA !== policyB) return null;
  const newer = newerByDate(a, b, 'expiry_date') || newerByDate(a, b, 'issued_date');
  if (!newer) return null;
  const [newerDoc, olderDoc] = newer;
  const type = hasRevisionHint(newerDoc) ? 'renews' : 'supersedes';
  return {
    sourceDocumentId: newerDoc.id,
    targetDocumentId: olderDoc.id,
    linkType: type,
    confidence: 0.95,
    reasoning: `Same policy number ${factsA.get('policy_number')} with later coverage term on ${newerDoc.title}.`
  };
}

function candidateVehicleSupersede(a, b) {
  if (a.document_type !== 'vehicle' || b.document_type !== 'vehicle') return null;
  const registrationText = (doc) => `${doc.title || ''} ${doc.metadata?.magicindex?.suggestions?.summary || ''}`;
  if (!/\bregistration\b/i.test(registrationText(a)) || !/\bregistration\b/i.test(registrationText(b))) return null;
  const factsA = factMap(a);
  const factsB = factMap(b);
  const vinA = normalizeValue(factsA.get('vin'));
  const vinB = normalizeValue(factsB.get('vin'));
  const plateA = normalizeValue(factsA.get('plate_number'));
  const plateB = normalizeValue(factsB.get('plate_number'));
  const ocrVinInsertion = hasLikelyOcrVinInsertion(a, b, vinA, vinB, plateA, plateB);
  if (vinA && vinB && vinA !== vinB && !ocrVinInsertion) return null;
  if (!(vinA && vinA === vinB) && !(plateA && plateA === plateB)) return null;
  const newer = newerByDate(a, b, 'expiry_date') || newerByDate(a, b, 'issued_date');
  if (!newer) return null;
  const [newerDoc, olderDoc] = newer;
  return {
    sourceDocumentId: newerDoc.id,
    targetDocumentId: olderDoc.id,
    linkType: 'supersedes',
    confidence: vinA && vinA === vinB ? 0.95 : (ocrVinInsertion ? 0.75 : 0.7),
    reasoning: ocrVinInsertion
      ? `Same plate and near-matching VIN, with one extra OCR character and later registration dates on ${newerDoc.title}. Verify the VIN against both originals before accepting.`
      : `Same ${vinA && vinA === vinB ? 'VIN' : 'plate'} with later registration dates on ${newerDoc.title}.`
  };
}

function candidateTaxSupersede(a, b) {
  if (a.document_type !== 'tax' || b.document_type !== 'tax') return null;
  const factsA = factMap(a);
  const factsB = factMap(b);
  const yearA = normalizeValue(factsA.get('tax_year'));
  const yearB = normalizeValue(factsB.get('tax_year'));
  if (!yearA || yearA !== yearB) return null;
  if (!sameOwners(a, b)) return null;
  const amendedA = hasRevisionHint(a);
  const amendedB = hasRevisionHint(b);
  if (amendedA === amendedB) return null;
  const newerDoc = amendedA ? a : b;
  const olderDoc = amendedA ? b : a;
  return {
    sourceDocumentId: newerDoc.id,
    targetDocumentId: olderDoc.id,
    linkType: 'supersedes',
    confidence: 0.95,
    reasoning: `Same tax year ${factsA.get('tax_year') || factsB.get('tax_year')} and same filers; amended/corrected filing on ${newerDoc.title}.`
  };
}

function candidateStatementSupersede(a, b) {
  const factsA = factMap(a);
  const factsB = factMap(b);
  const accountA = normalizeValue(factsA.get('account_number'));
  const accountB = normalizeValue(factsB.get('account_number'));
  if (!accountA || accountA !== accountB) return null;
  const periodA = parsePeriod(factsA.get('statement_period'));
  const periodB = parsePeriod(factsB.get('statement_period'));
  if (!periodA || !periodB || periodA.start !== periodB.start || periodA.end !== periodB.end) return null;
  const newer = newerByDate(a, b, 'issued_date');
  if (!newer) return null;
  const [newerDoc, olderDoc] = newer;
  if (!hasRevisionHint(newerDoc)) return null;
  return {
    sourceDocumentId: newerDoc.id,
    targetDocumentId: olderDoc.id,
    linkType: 'supersedes',
    confidence: 0.9,
    reasoning: `Corrected statement for the same account and period on ${newerDoc.title}.`
  };
}

function candidateEstimateSupersede(a, b) {
  const factsA = factMap(a);
  const factsB = factMap(b);
  const projectA = normalizeValue(factsA.get('project_number'));
  const projectB = normalizeValue(factsB.get('project_number'));
  const orderA = normalizeValue(factsA.get('order_number') || factsA.get('purchase_order_number'));
  const orderB = normalizeValue(factsB.get('order_number') || factsB.get('purchase_order_number'));
  if (!(projectA && projectA === projectB) && !(orderA && orderA === orderB)) return null;
  if (!hasRevisionHint(a) && !hasRevisionHint(b)) return null;
  const newer = newerByDate(a, b, 'issued_date');
  if (!newer) return null;
  const [newerDoc, olderDoc] = newer;
  return {
    sourceDocumentId: newerDoc.id,
    targetDocumentId: olderDoc.id,
    linkType: 'supersedes',
    confidence: projectA && projectA === projectB ? 0.9 : 0.8,
    reasoning: `Same ${projectA && projectA === projectB ? 'project' : 'order'} with revision/update language on ${newerDoc.title}.`
  };
}

function buildCandidate(a, b) {
  return [
    candidateInsuranceSupersede(a, b),
    candidateVehicleSupersede(a, b),
    candidateTaxSupersede(a, b),
    candidateStatementSupersede(a, b),
    candidateEstimateSupersede(a, b),
    candidateSameAccount(a, b),
    candidateSameAsset(a, b)
  ].filter(Boolean);
}

function candidateSameAccount(a, b) {
  const factsA = factMap(a);
  const factsB = factMap(b);
  const keys = ['policy_number', 'claim_number', 'account_number', 'order_number', 'project_number'];
  for (const key of keys) {
    const aVal = normalizeValue(factsA.get(key));
    const bVal = normalizeValue(factsB.get(key));
    if (!aVal || aVal !== bVal) continue;
    return {
      sourceDocumentId: a.id,
      targetDocumentId: b.id,
      linkType: 'same_account',
      confidence: 0.92,
      reasoning: `Same ${key.replace(/_/g, ' ')} (${factsA.get(key)}).`
    };
  }
  return null;
}

function candidateSameAsset(a, b) {
  const factsA = factMap(a);
  const factsB = factMap(b);
  const vinA = normalizeValue(factsA.get('vin'));
  const vinB = normalizeValue(factsB.get('vin'));
  if (vinA && vinA === vinB) {
    return {
      sourceDocumentId: a.id,
      targetDocumentId: b.id,
      linkType: 'same_asset',
      confidence: 0.95,
      reasoning: `Same VIN (${factsA.get('vin')}).`
    };
  }
  const plateA = normalizeValue(factsA.get('plate_number'));
  const plateB = normalizeValue(factsB.get('plate_number'));
  if (vinA && vinB && hasLikelyOcrVinInsertion(a, b, vinA, vinB, plateA, plateB)) {
    return {
      sourceDocumentId: a.id,
      targetDocumentId: b.id,
      linkType: 'same_asset',
      confidence: 0.8,
      reasoning: 'Same plate and near-matching VIN with a one-character OCR insertion; verify the VIN against both originals.'
    };
  }
  const addressA = normalizeValue(factsA.get('property_address'));
  const addressB = normalizeValue(factsB.get('property_address'));
  if (addressA && addressA === addressB) {
    return {
      sourceDocumentId: a.id,
      targetDocumentId: b.id,
      linkType: 'same_asset',
      confidence: 0.88,
      reasoning: `Same property address (${factsA.get('property_address')}).`
    };
  }
  return null;
}

async function scanDeterministicLinks() {
  const { rows: docs } = await pool.query(`
    SELECT id, title, document_type, issued_date, expiry_date, metadata
    FROM documents
    WHERE status = 'active'
      AND NOT (metadata @> '{"continuity_letter": true}'::jsonb)
      AND (metadata ? 'magicindex')
    ORDER BY id ASC
  `);

  let createdOrUpdated = 0;
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const candidates = buildCandidate(docs[i], docs[j]);
      for (const candidate of candidates) {
        await upsertSuggestedLink(candidate);
        createdOrUpdated++;
      }
    }
  }
  return { created_or_updated: createdOrUpdated };
}

module.exports = {
  factMap,
  ownerNames,
  sameOwners,
  candidateInsuranceSupersede,
  candidateVehicleSupersede,
  candidateTaxSupersede,
  candidateStatementSupersede,
  candidateEstimateSupersede,
  candidateSameAccount,
  candidateSameAsset,
  scanDeterministicLinks
};
