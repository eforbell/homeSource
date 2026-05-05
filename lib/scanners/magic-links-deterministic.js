'use strict';

const { pool } = require('../db');
const { upsertSuggestedLink } = require('../magic-links');

function normalizeValue(value) {
  return String(value || '').trim().toLowerCase();
}

function factMap(doc) {
  const facts = new Map();
  const keyFacts = doc.metadata?.magicindex?.suggestions?.key_facts || [];
  for (const fact of keyFacts) {
    if (!fact?.key || !fact?.value) continue;
    const key = String(fact.key).trim();
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
  const factsA = factMap(a);
  const factsB = factMap(b);
  const vinA = normalizeValue(factsA.get('vin'));
  const vinB = normalizeValue(factsB.get('vin'));
  const plateA = normalizeValue(factsA.get('plate_number'));
  const plateB = normalizeValue(factsB.get('plate_number'));
  if (!(vinA && vinA === vinB) && !(plateA && plateA === plateB)) return null;
  const newer = newerByDate(a, b, 'expiry_date') || newerByDate(a, b, 'issued_date');
  if (!newer) return null;
  const [newerDoc, olderDoc] = newer;
  return {
    sourceDocumentId: newerDoc.id,
    targetDocumentId: olderDoc.id,
    linkType: 'supersedes',
    confidence: vinA && vinA === vinB ? 0.95 : 0.9,
    reasoning: `Same ${vinA && vinA === vinB ? 'VIN' : 'plate'} with later registration dates on ${newerDoc.title}.`
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
  const providerA = normalizeValue(factsA.get('provider_name'));
  const providerB = normalizeValue(factsB.get('provider_name'));
  if (!(accountA && accountA === accountB) && !(providerA && providerA === providerB)) return null;
  const periodA = parsePeriod(factsA.get('statement_period') || factsA.get('renewal_term'));
  const periodB = parsePeriod(factsB.get('statement_period') || factsB.get('renewal_term'));
  if (periodA && periodB && periodA.end !== periodB.end) {
    const newerDoc = periodA.end > periodB.end ? a : b;
    const olderDoc = periodA.end > periodB.end ? b : a;
    return {
      sourceDocumentId: newerDoc.id,
      targetDocumentId: olderDoc.id,
      linkType: 'supersedes',
      confidence: accountA && accountA === accountB ? 0.9 : 0.75,
      reasoning: `Same ${accountA && accountA === accountB ? 'account' : 'provider'} with a later statement period on ${newerDoc.title}.`
    };
  }
  const newer = newerByDate(a, b, 'issued_date');
  if (!newer) return null;
  const [newerDoc, olderDoc] = newer;
  return {
    sourceDocumentId: newerDoc.id,
    targetDocumentId: olderDoc.id,
    linkType: 'supersedes',
    confidence: accountA && accountA === accountB ? 0.85 : 0.7,
    reasoning: `Same ${accountA && accountA === accountB ? 'account' : 'provider'} with later statement date on ${newerDoc.title}.`
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
