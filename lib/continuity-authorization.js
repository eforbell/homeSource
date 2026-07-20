'use strict';

const { pool } = require('./db');

class ContinuityAuthorizationError extends Error {
  constructor(message = 'Access denied', statusCode = 403) {
    super(message);
    this.name = 'ContinuityAuthorizationError';
    this.statusCode = statusCode;
  }
}

function positiveId(value, field = 'document_id') {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    if (field === 'document_id') throw new TypeError('Document id must be a positive integer');
    throw new TypeError(`${field} is invalid`);
  }
  return parsed;
}

function actorIdentity(actor) {
  if (!actor) throw new ContinuityAuthorizationError('Authentication required', 401);
  return { id: positiveId(actor.id, 'actor_id'), role: actor.role };
}

function continuityLetterReferenceSql(alias) {
  return `(EXISTS (
      SELECT 1 FROM continuity_switches referenced_switch
      WHERE ${alias}.id = referenced_switch.letter_document_id
         OR ${alias}.id = referenced_switch.staged_letter_document_id
    )
    OR EXISTS (
      SELECT 1 FROM continuity_packet_versions referenced_packet
      WHERE referenced_packet.letter_document_id = ${alias}.id
    ))`;
}

function continuityLetterVisibilitySql(alias, actorParameter) {
  const referenced = continuityLetterReferenceSql(alias);
  return `(
    NOT ((${alias}.metadata @> '{"continuity_letter": true}'::jsonb)
      OR ${referenced})
    OR (NOT ${referenced} AND ${alias}.created_by = ${actorParameter})
    OR EXISTS (
      SELECT 1 FROM continuity_switches visibility_switch
      WHERE visibility_switch.owner_id = ${actorParameter}
        AND (${alias}.id = visibility_switch.letter_document_id
          OR ${alias}.id = visibility_switch.staged_letter_document_id)
    )
    OR EXISTS (
      SELECT 1 FROM continuity_packet_versions visibility_packet
      JOIN continuity_switches visibility_switch ON visibility_switch.id = visibility_packet.switch_id
      WHERE visibility_packet.letter_document_id = ${alias}.id
        AND visibility_switch.owner_id = ${actorParameter}
    )
  )`;
}

function documentAuthorizationSql(where) {
  return `SELECT d.id, d.status, d.created_by, d.metadata,
            EXISTS (
              SELECT 1 FROM document_owners ownership
              WHERE ownership.document_id = d.id AND ownership.member_id = $2
            ) AS actor_owns_document,
            EXISTS (
              SELECT 1 FROM document_designations designation
              WHERE designation.document_id = d.id
                AND designation.member_id = $2 AND designation.sealed = TRUE
            ) AS actor_has_sealed_designation,
            ARRAY(
              SELECT DISTINCT letter_switch.owner_id
              FROM continuity_switches letter_switch
              WHERE d.id = letter_switch.letter_document_id
                 OR d.id = letter_switch.staged_letter_document_id
                 OR EXISTS (
                   SELECT 1 FROM continuity_packet_versions letter_packet
                   WHERE letter_packet.switch_id = letter_switch.id
                     AND letter_packet.letter_document_id = d.id
                 )
              ORDER BY letter_switch.owner_id
            ) AS letter_owner_ids,
            ARRAY(
              SELECT DISTINCT packet_switch.owner_id
              FROM continuity_packet_documents packet_document
              JOIN continuity_packet_versions packet ON packet.id = packet_document.packet_version_id
              JOIN continuity_switches packet_switch ON packet_switch.id = packet.switch_id
              WHERE packet_document.document_id = d.id
              ORDER BY packet_switch.owner_id
            ) AS packet_owner_ids
     FROM documents d WHERE ${where}`;
}

function authorizationFromRow(row, principal) {
  const letterOwnerIds = (row.letter_owner_ids || []).map(Number);
  const packetOwnerIds = (row.packet_owner_ids || []).map(Number);
  const marker = row.metadata?.continuity_letter === true;
  const isLetter = marker || letterOwnerIds.length > 0;
  if (isLetter && letterOwnerIds.length === 0 && row.created_by) letterOwnerIds.push(Number(row.created_by));
  const isLetterOwner = letterOwnerIds.includes(principal.id);
  const isPacketOwner = packetOwnerIds.includes(principal.id);
  const packetBound = packetOwnerIds.length > 0;
  const normalRead = row.status !== 'staged' && (
    principal.role === 'parent'
    || (row.actor_owns_document && !row.actor_has_sealed_designation)
  );
  const canRead = isLetter ? isLetterOwner && row.status !== 'staged' : normalRead;
  const canViewSealedWrap = isLetter
    ? isLetterOwner && row.status !== 'staged'
    : principal.role === 'parent' && row.actor_owns_document && (!packetBound || isPacketOwner);

  return {
    document_id: Number(row.id),
    is_continuity_letter: isLetter,
    is_packet_bound: packetBound,
    letter_owner_ids: letterOwnerIds,
    packet_owner_ids: packetOwnerIds,
    actor_owns_document: row.actor_owns_document,
    can_read: canRead,
    can_download: canRead,
    can_administer: principal.role === 'parent' && !isLetter && (!packetBound || isPacketOwner),
    can_administer_continuity_seal: principal.role === 'parent' && !isLetter
      && row.actor_owns_document && (!packetBound || isPacketOwner),
    can_view_sealed_wrap: canViewSealedWrap,
    can_administer_letter: principal.role === 'parent' && isLetterOwner
  };
}

async function resolveDocumentAuthorization({ documentId, actor, db = pool }) {
  const id = positiveId(documentId);
  const principal = actorIdentity(actor);
  const { rows } = await db.query(documentAuthorizationSql('d.id = $1'), [id, principal.id]);
  return rows[0] ? authorizationFromRow(rows[0], principal) : null;
}

async function resolveDocumentAuthorizations({ documentIds, actor, db = pool }) {
  const principal = actorIdentity(actor);
  const ids = [...new Set((documentIds || []).map((value) => positiveId(value)))];
  if (!ids.length) return new Map();
  const { rows } = await db.query(documentAuthorizationSql('d.id = ANY($1::int[])'), [ids, principal.id]);
  return new Map(rows.map((row) => [Number(row.id), authorizationFromRow(row, principal)]));
}

async function assertDocumentAccess({ documentId, actor, mode = 'read', db = pool }) {
  const authorization = await resolveDocumentAuthorization({ documentId, actor, db });
  if (!authorization) throw new ContinuityAuthorizationError('Document not found', 404);
  const permission = {
    read: 'can_read',
    download: 'can_download',
    administer: 'can_administer',
    continuity_seal: 'can_administer_continuity_seal',
    sealed_wrap: 'can_view_sealed_wrap',
    letter_admin: 'can_administer_letter'
  }[mode];
  if (!permission) throw new TypeError(`Unknown document authorization mode: ${mode}`);
  if (!authorization[permission]) throw new ContinuityAuthorizationError();
  return authorization;
}

function redactSealedHolders(encryptionMetadata) {
  if (!encryptionMetadata || typeof encryptionMetadata !== 'object') return encryptionMetadata;
  const redacted = structuredClone(encryptionMetadata);
  for (const entry of Object.values(redacted.files || {})) {
    if (!Array.isArray(entry?.holders)) continue;
    entry.holders = entry.holders.filter((holder) => holder?.sealed !== true);
  }
  return redacted;
}

function sanitizeDocument(document, authorization) {
  if (!document || authorization?.can_view_sealed_wrap) return document;
  return { ...document, encryption_metadata: redactSealedHolders(document.encryption_metadata) };
}

function sanitizeKeyInfo(info, authorization) {
  if (!info || authorization?.can_view_sealed_wrap) return info;
  const allowedKeyIds = new Set(
    (info.holders || []).filter((holder) => holder?.sealed !== true)
      .map((holder) => Number(holder.encryption_key_id))
  );
  return {
    ...info,
    encryption_metadata: redactSealedHolders(info.encryption_metadata),
    holders: (info.holders || []).filter((holder) => holder?.sealed !== true),
    key: info.key && allowedKeyIds.has(Number(info.key.id)) ? info.key : null,
    primary_key: info.primary_key && allowedKeyIds.has(Number(info.primary_key.id)) ? info.primary_key : null
  };
}

async function authorizeAndSanitizeDocument({ document, actor, db = pool }) {
  const authorization = await assertDocumentAccess({ documentId: document.id, actor, mode: 'read', db });
  return sanitizeDocument(document, authorization);
}

async function authorizeAndSanitizeDocuments({ documents, actor, db = pool }) {
  const authorizations = await resolveDocumentAuthorizations({
    documentIds: (documents || []).map((document) => document.id), actor, db
  });
  return (documents || []).flatMap((document) => {
    const authorization = authorizations.get(Number(document.id));
    return authorization?.can_read ? [sanitizeDocument(document, authorization)] : [];
  });
}

async function sanitizeDependencySummary(summary, actor, db = pool) {
  if (!summary) return summary;
  const sourceDocuments = summary.documents || [];
  const authorizations = await resolveDocumentAuthorizations({
    documentIds: sourceDocuments.map((document) => document.document_id), actor, db
  });
  const documents = sourceDocuments.map((document) => {
    const authorization = authorizations.get(Number(document.document_id));
    return authorization?.can_read ? document : {
      ...document, document_id: null, title: 'Protected continuity document'
    };
  });
  return { ...summary, documents };
}

module.exports = {
  ContinuityAuthorizationError,
  continuityLetterVisibilitySql,
  resolveDocumentAuthorization,
  resolveDocumentAuthorizations,
  assertDocumentAccess,
  redactSealedHolders,
  sanitizeDocument,
  sanitizeKeyInfo,
  authorizeAndSanitizeDocument,
  authorizeAndSanitizeDocuments,
  sanitizeDependencySummary
};
