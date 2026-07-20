'use strict';

const crypto = require('node:crypto');
const { pool, withTransaction } = require('./db');

function positiveId(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function boundedIds(values, name) {
  if (!Array.isArray(values) || values.length > 200) throw new TypeError(`${name} must be an array`);
  const ids = values.map((value) => positiveId(value, name));
  if (new Set(ids).size !== ids.length) throw new TypeError(`${name} contains duplicates`);
  return ids;
}

function identity(row) {
  return row.member_id ? `m:${Number(row.member_id)}` : `t:${Number(row.trustee_id)}`;
}

function envelopeHolders(document) {
  const metadata = document.encryption_metadata;
  if (Number(metadata?.version) !== 2 || metadata?.mode !== 'pki') return [];
  return Array.isArray(metadata?.files?.upload?.holders) ? metadata.files.upload.holders : [];
}

async function loadDocumentEvidence(db, { documentId, ownerId, letter = false }) {
  const { rows } = await db.query(
    `SELECT d.*,
            EXISTS (SELECT 1 FROM document_owners own WHERE own.document_id = d.id AND own.member_id = $2) AS owner_access,
            (SELECT COUNT(*)::int FROM document_files file WHERE file.document_id = d.id) AS file_count
     FROM documents d WHERE d.id = $1`,
    [documentId, ownerId]
  );
  const document = rows[0];
  const expectedStatus = letter ? 'staged' : 'active';
  if (!document || document.status !== expectedStatus || document.encryption_mode !== 'pki'
      || document.is_encrypted !== true || document.owner_access !== true || Number(document.file_count) < 1) {
    throw new Error(letter ? 'The staged Letter is not packet-ready' : 'A selected packet document is not eligible');
  }
  if (!letter && document.metadata?.continuity_letter === true) throw new Error('A prior Letter cannot be selected as a packet document');
  if (!envelopeHolders(document).length) throw new Error('A packet document requires a version 2 PKI envelope');
  return document;
}

async function coverageFor(db, document, recipient) {
  const key = identity(recipient);
  const holders = envelopeHolders(document).filter((holder) => identity(holder) === key
    && Boolean(holder.member_id) !== Boolean(holder.trustee_id)
    && holder.sealed === true && holder.sealed_until === 'deadman_trigger'
    && holder.role === recipient.role && holder?.wrapped_dek?.kind === 'pki_x25519');
  if (!holders.length) return { coverage_status: 'not_designated' };
  const { rows } = await db.query(
    `SELECT designation.id AS designation_id, designation.encryption_key_id,
            key.key_fingerprint, key.member_id, key.trustee_id, key.revoked_at
     FROM document_designations designation
     JOIN encryption_keys key ON key.id = designation.encryption_key_id
     WHERE designation.document_id = $1 AND designation.role = $2
       AND designation.member_id IS NOT DISTINCT FROM $3::int
       AND designation.trustee_id IS NOT DISTINCT FROM $4::int
       AND designation.sealed = TRUE AND designation.sealed_until = 'deadman_trigger'`,
    [document.id, recipient.role, recipient.member_id || null, recipient.trustee_id || null]
  );
  const candidates = rows.filter((evidence) => !evidence.revoked_at
    && holders.some((holder) => Number(evidence.encryption_key_id) === Number(holder.encryption_key_id)
      && evidence.key_fingerprint === holder.key_fingerprint)
    && (!recipient.member_id || Number(evidence.member_id) === Number(recipient.member_id))
    && (!recipient.trustee_id || Number(evidence.trustee_id) === Number(recipient.trustee_id)))
    .sort((a, b) => Number(a.designation_id) - Number(b.designation_id));
  if (!candidates.length) return { coverage_status: 'not_designated' };
  const evidence = candidates[0];
  return {
    coverage_status: 'covered', designation_id: Number(evidence.designation_id),
    encryption_key_id: Number(evidence.encryption_key_id), key_fingerprint: evidence.key_fingerprint
  };
}

async function loadPacket(db, packetVersionId) {
  const { rows } = await db.query('SELECT * FROM continuity_packet_versions WHERE id = $1', [packetVersionId]);
  const version = rows[0];
  if (!version) return null;
  version.documents = (await db.query(
    'SELECT * FROM continuity_packet_documents WHERE packet_version_id = $1 ORDER BY packet_order', [version.id]
  )).rows;
  version.recipients = (await db.query(
    'SELECT * FROM continuity_packet_recipients WHERE packet_version_id = $1 ORDER BY packet_order', [version.id]
  )).rows;
  version.coverage = (await db.query(
    `SELECT coverage.* FROM continuity_packet_recipient_documents coverage
     JOIN continuity_packet_recipients recipient ON recipient.id = coverage.packet_recipient_id
     WHERE recipient.packet_version_id = $1 ORDER BY coverage.packet_recipient_id, coverage.packet_document_id`,
    [version.id]
  )).rows;
  return version;
}

async function stagePacket({ ownerId, switchId, selectedDocumentIds = [], witnessTrusteeIds = [], operationKey }) {
  const owner = positiveId(ownerId, 'owner_id');
  const switchKey = positiveId(switchId, 'switch_id');
  const selectedIds = boundedIds(selectedDocumentIds, 'selected_document_ids');
  const witnessIds = boundedIds(witnessTrusteeIds, 'witness_trustee_ids');
  const operation = String(operationKey || '').trim();
  if (!operation || operation.length > 120) throw new TypeError('A bounded operation_key is required');
  return withTransaction(async (db) => {
    const { rows: switchRows } = await db.query(
      `SELECT * FROM continuity_switches WHERE id = $1 AND owner_id = $2
       AND status IN ('draft', 'armed', 'paused') FOR UPDATE`, [switchKey, owner]
    );
    const item = switchRows[0];
    if (!item?.staged_letter_document_id) throw new Error('Stage the encrypted Letter before staging its packet');
    const replay = await db.query(
      'SELECT id FROM continuity_packet_versions WHERE switch_id = $1 AND operation_key = $2', [item.id, operation]
    );
    if (replay.rows[0]) return loadPacket(db, replay.rows[0].id);

    const letter = await loadDocumentEvidence(db, { documentId: item.staged_letter_document_id, ownerId: owner, letter: true });
    const { rows: recipients } = await db.query(
      `SELECT member_id, trustee_id, role FROM document_designations
       WHERE document_id = $1 ORDER BY id`, [letter.id]
    );
    if (!recipients.length) throw new Error('The staged Letter has no packet recipients');
    const documents = [{ document: letter, item_kind: 'letter' }];
    for (const documentId of selectedIds) {
      if (Number(documentId) === Number(letter.id)) throw new Error('The Letter is included automatically');
      documents.push({
        document: await loadDocumentEvidence(db, { documentId, ownerId: owner }), item_kind: 'selected'
      });
    }
    const matrix = [];
    for (const entry of documents) {
      let covered = 0;
      for (const recipient of recipients) {
        const evidence = await coverageFor(db, entry.document, recipient);
        if (evidence.coverage_status === 'covered') covered += 1;
        matrix.push({ document_id: entry.document.id, recipient: identity(recipient), ...evidence });
      }
      if (entry.item_kind === 'letter' && covered !== recipients.length) throw new Error('The Letter must cover every packet recipient');
      if (entry.item_kind === 'selected' && covered === 0) throw new Error('Each selected document must cover at least one packet recipient');
    }
    if (witnessIds.length) {
      const { rows: witnesses } = await db.query(
        `SELECT trustee.id
         FROM vault_trustees trustee
         JOIN trustee_contact_channels contact ON contact.trustee_id = trustee.id
           AND contact.channel_type = 'email' AND contact.status = 'verified'
         WHERE trustee.id = ANY($1::int[]) AND trustee.created_by = $2 AND trustee.status = 'registered'`,
        [witnessIds, owner]
      );
      if (witnesses.length !== witnessIds.length) throw new Error('Every witness trustee must be registered with a verified contact');
    }
    const nextVersion = Number((await db.query(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS version FROM continuity_packet_versions WHERE switch_id = $1', [item.id]
    )).rows[0].version);
    const policy = {
      letter_document_id: Number(letter.id),
      document_ids: documents.map((entry) => Number(entry.document.id)),
      recipients: recipients.map(identity),
      coverage: matrix.map((entry) => [entry.document_id, entry.recipient, entry.coverage_status, entry.encryption_key_id || null, entry.key_fingerprint || null]),
      witness_trustee_ids: [...witnessIds].sort((a, b) => a - b)
    };
    const policyHash = crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');
    if (item.staged_packet_version_id) {
      await db.query(
        `UPDATE continuity_packet_versions SET status = 'superseded', superseded_at = NOW()
         WHERE id = $1 AND status = 'staged'`, [item.staged_packet_version_id]
      );
    }
    const { rows: versions } = await db.query(
      `INSERT INTO continuity_packet_versions
         (switch_id, version_number, letter_document_id, policy_hash, operation_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [item.id, nextVersion, letter.id, policyHash, operation, owner]
    );
    const version = versions[0];
    const documentRows = new Map();
    for (let i = 0; i < documents.length; i++) {
      const entry = documents[i];
      const { rows } = await db.query(
        `INSERT INTO continuity_packet_documents (packet_version_id, document_id, item_kind, packet_order)
         VALUES ($1, $2, $3, $4) RETURNING *`, [version.id, entry.document.id, entry.item_kind, i + 1]
      );
      documentRows.set(Number(entry.document.id), rows[0]);
    }
    const recipientRows = new Map();
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const { rows } = await db.query(
        `INSERT INTO continuity_packet_recipients
           (packet_version_id, member_id, trustee_id, role, packet_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [version.id, recipient.member_id, recipient.trustee_id, recipient.role, i + 1]
      );
      recipientRows.set(identity(recipient), rows[0]);
    }
    for (const evidence of matrix) {
      await db.query(
        `INSERT INTO continuity_packet_recipient_documents
           (packet_version_id, packet_recipient_id, packet_document_id, coverage_status, designation_id, encryption_key_id, key_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [version.id, recipientRows.get(evidence.recipient).id, documentRows.get(Number(evidence.document_id)).id,
          evidence.coverage_status, evidence.designation_id || null, evidence.encryption_key_id || null, evidence.key_fingerprint || null]
      );
    }
    await db.query('DELETE FROM continuity_switch_trustees WHERE switch_id = $1', [item.id]);
    for (const trusteeId of witnessIds) {
      await db.query('INSERT INTO continuity_switch_trustees (switch_id, trustee_id) VALUES ($1, $2)', [item.id, trusteeId]);
    }
    await db.query('UPDATE continuity_switches SET staged_packet_version_id = $2, updated_at = NOW() WHERE id = $1', [item.id, version.id]);
    return loadPacket(db, version.id);
  });
}

async function getPacketForOwner({ ownerId, switchId }, db = pool) {
  const { rows } = await db.query(
    `SELECT staged_packet_version_id, active_packet_version_id FROM continuity_switches
     WHERE id = $1 AND owner_id = $2 AND status <> 'cancelled'`,
    [positiveId(switchId, 'switch_id'), positiveId(ownerId, 'owner_id')]
  );
  if (!rows[0]) return null;
  return {
    staged: rows[0].staged_packet_version_id ? await loadPacket(db, rows[0].staged_packet_version_id) : null,
    active: rows[0].active_packet_version_id ? await loadPacket(db, rows[0].active_packet_version_id) : null,
    witnesses: (await db.query(
      `SELECT trustee.id, trustee.name FROM continuity_switch_trustees witness
       JOIN vault_trustees trustee ON trustee.id = witness.trustee_id
       WHERE witness.switch_id = $1 ORDER BY trustee.name`, [switchId]
    )).rows
  };
}

async function validatePacketActivation(db, { switchRow, ownerId }) {
  const packet = await loadPacket(db, switchRow.staged_packet_version_id);
  if (!packet || packet.status !== 'staged' || Number(packet.letter_document_id) !== Number(switchRow.staged_letter_document_id)) {
    throw new Error('A current staged continuity packet is required');
  }
  for (const recipient of packet.recipients) {
    const contactTable = recipient.member_id ? 'member_contact_channels' : 'trustee_contact_channels';
    const identityColumn = recipient.member_id ? 'member_id' : 'trustee_id';
    const identityValue = recipient.member_id || recipient.trustee_id;
    const { rows } = await db.query(
      `SELECT id FROM ${contactTable} WHERE ${identityColumn} = $1 AND channel_type = 'email' AND status = 'verified'`,
      [identityValue]
    );
    if (rows.length !== 1) throw new Error('Every packet recipient requires one verified contact');
  }
  const documentById = new Map(packet.documents.map((row) => [Number(row.id), row]));
  const recipientById = new Map(packet.recipients.map((row) => [Number(row.id), row]));
  for (const evidence of packet.coverage) {
    if (evidence.coverage_status !== 'covered') continue;
    const packetDocument = documentById.get(Number(evidence.packet_document_id));
    const recipient = recipientById.get(Number(evidence.packet_recipient_id));
    const document = await loadDocumentEvidence(db, {
      documentId: packetDocument.document_id, ownerId,
      letter: packetDocument.item_kind === 'letter'
    });
    const current = await coverageFor(db, document, recipient);
    if (current.coverage_status !== 'covered'
        || Number(current.designation_id) !== Number(evidence.designation_id)
        || Number(current.encryption_key_id) !== Number(evidence.encryption_key_id)
        || current.key_fingerprint !== evidence.key_fingerprint) {
      throw new Error('Continuity packet coverage changed after staging');
    }
  }
  const { rows: witnesses } = await db.query(
    `SELECT witness.trustee_id, trustee.status, contact.id AS contact_id
     FROM continuity_switch_trustees witness
     JOIN vault_trustees trustee ON trustee.id = witness.trustee_id
     LEFT JOIN trustee_contact_channels contact ON contact.trustee_id = trustee.id
       AND contact.channel_type = 'email' AND contact.status = 'verified'
     WHERE witness.switch_id = $1`, [switchRow.id]
  );
  if (witnesses.some((row) => row.status !== 'registered' || !row.contact_id)) {
    throw new Error('Every witness trustee must remain registered and reachable');
  }
  return packet;
}

async function activatePacket(db, { switchRow, ownerId, now }) {
  const packet = await validatePacketActivation(db, { switchRow, ownerId });
  if (switchRow.active_packet_version_id) {
    await db.query(
      `UPDATE continuity_packet_versions SET status = 'superseded', superseded_at = $2
       WHERE id = $1 AND status = 'active'`, [switchRow.active_packet_version_id, now]
    );
  }
  await db.query(
    `UPDATE continuity_packet_versions SET status = 'active', activated_at = $2
     WHERE id = $1 AND status = 'staged'`, [packet.id, now]
  );
  return packet;
}

module.exports = { stagePacket, getPacketForOwner, validatePacketActivation, activatePacket };
