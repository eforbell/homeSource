'use strict';

const { pool } = require('../db');
const { updateDocument } = require('../documents');
const { setDocumentTags } = require('../tags');

async function applyMagicIndexToDocument({ documentId, result, threshold = 0.85, provider = 'unknown', model = null, force = false, userHint = null }) {
  const autoApplied = {};
  const data = {};
  const metadataPatch = {
    magicindex: {
      state: 'complete',
      provider,
      model,
      user_hint: userHint || undefined,
      last_analyzed_at: new Date().toISOString(),
      confidence: result.confidence,
      field_confidence: result.field_confidence || {},
      extraction_evidence: result.extraction_evidence || null,
      request_diagnostics: result.request_diagnostics || null,
      auto_apply_threshold: threshold,
      fields: {}
    }
  };

  maybeApplyField({ force, threshold, source: result.title, key: 'title', outputKey: 'title', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });
  maybeApplyField({ force, threshold, source: result.document_type, key: 'document_type', outputKey: 'document_type', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });
  maybeApplyField({ force, threshold, source: result.summary, key: 'summary', outputKey: 'description', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });
  maybeApplyField({ force, threshold, source: result.issued_date, key: 'issued_date', outputKey: 'issued_date', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });
  maybeApplyField({ force, threshold, source: result.expiry_date, key: 'expiry_date', outputKey: 'expiry_date', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });

  metadataPatch.magicindex.suggestions = result;
  data.metadata = await mergedMetadata(documentId, metadataPatch);
  await updateDocument(documentId, data);

  const tagThreshold = force ? 0 : confidenceForField(result.field_confidence, 'suggested_tags', threshold, result.confidence);
  const tagIds = await autoApplyTags(result.suggested_tags || [], tagThreshold);
  if (tagIds.length) {
    await setDocumentTags(documentId, tagIds);
    autoApplied.tags = tagIds;
  }

  const ownerThreshold = force ? 0 : confidenceForField(result.field_confidence, 'suggested_owners', threshold, result.confidence);
  await autoApplyOwners(documentId, result.suggested_owners || [], ownerThreshold);
  return autoApplied;
}

function maybeApplyField({ force, threshold, source, key, outputKey, target, autoApplied, metadataFields, fieldConfidence }) {
  if (!source) return;
  const allow = force || confidenceForField(fieldConfidence, key, threshold) >= Number(threshold || 0);
  if (!allow) return;
  target[outputKey] = source;
  autoApplied[outputKey] = source;
  metadataFields[outputKey] = 'auto_applied';
}

function confidenceForField(fieldConfidence, key, threshold, overall = 0) {
  const n = Number(fieldConfidence?.[key]);
  if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  const fallback = Number.isFinite(Number(overall)) ? Number(overall) : Number(threshold || 0);
  return Math.max(0, Math.min(1, fallback));
}

async function mergedMetadata(documentId, patch) {
  const { rows } = await pool.query('SELECT metadata FROM documents WHERE id = $1', [documentId]);
  return { ...(rows[0]?.metadata || {}), ...patch };
}

async function autoApplyTags(tags, threshold) {
  const cache = await loadExistingTagCache();
  const ids = [];
  const seen = new Set();
  for (const tag of tags) {
    if (!tag.name || Number(tag.confidence) < threshold) continue;
    const cleaned = normalizeTagName(tag.name);
    if (!cleaned) continue;
    let tagId = findExistingTagId(cache, cleaned);
    if (!tagId) {
      const { rows } = await pool.query(`
        INSERT INTO tags (name, color) VALUES ($1, '#6b7280')
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, name
      `, [cleaned]);
      tagId = rows[0].id;
      cache.push({ id: tagId, name: rows[0].name });
    }
    if (!seen.has(tagId)) {
      ids.push(tagId);
      seen.add(tagId);
    }
  }
  return ids;
}

async function loadExistingTagCache() {
  const { rows } = await pool.query('SELECT id, name FROM tags');
  return rows || [];
}

function normalizeTagName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .slice(0, 60);
}

function canonicalTagKey(name) {
  return normalizeTagName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function findExistingTagId(existingTags, suggestedName) {
  const normalized = normalizeTagName(suggestedName);
  const lower = normalized.toLowerCase();
  const canonical = canonicalTagKey(normalized);

  const exact = existingTags.find((tag) => String(tag.name || '').trim().toLowerCase() === lower);
  if (exact) return exact.id;

  const sameCanonical = existingTags.find((tag) => canonicalTagKey(tag.name) === canonical);
  if (sameCanonical) return sameCanonical.id;

  const fuzzy = bestFuzzyTag(existingTags, normalized);
  return fuzzy?.id || null;
}

function bestFuzzyTag(existingTags, suggestedName) {
  const suggestedCanonical = canonicalTagKey(suggestedName);
  if (!suggestedCanonical) return null;
  const suggestedTokens = new Set(suggestedCanonical.split(' ').filter(Boolean));
  let best = null;
  let bestScore = 0;
  for (const tag of existingTags) {
    const candidateCanonical = canonicalTagKey(tag.name);
    if (!candidateCanonical) continue;
    let score = 0;
    if (candidateCanonical.includes(suggestedCanonical) || suggestedCanonical.includes(candidateCanonical)) score += 0.7;
    const candidateTokens = new Set(candidateCanonical.split(' ').filter(Boolean));
    const overlap = [...suggestedTokens].filter((token) => candidateTokens.has(token)).length;
    const union = new Set([...suggestedTokens, ...candidateTokens]).size || 1;
    score += (overlap / union) * 0.5;
    if (score > bestScore) {
      best = tag;
      bestScore = score;
    }
  }
  return bestScore >= 0.75 ? best : null;
}

async function autoApplyOwners(documentId, owners, threshold) {
  for (const owner of owners) {
    if (!owner.member_name || Number(owner.confidence) < threshold) continue;
    const { rows } = await pool.query('SELECT id FROM family_members WHERE lower(name) = lower($1) LIMIT 1', [owner.member_name.trim()]);
    if (!rows[0]) continue;
    await pool.query(`
      INSERT INTO document_owners (document_id, member_id, ownership_type)
      VALUES ($1, $2, $3)
      ON CONFLICT (document_id, member_id) DO UPDATE SET ownership_type = EXCLUDED.ownership_type
    `, [documentId, rows[0].id, owner.ownership_type || 'owner']);
  }
}

module.exports = { applyMagicIndexToDocument, normalizeTagName, canonicalTagKey, findExistingTagId };
