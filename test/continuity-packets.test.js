'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createMember, createTestDocument, getPool, resetDatabase, startServer, stopServer
} = require('./helpers');
const continuity = require('../lib/continuity');
const packets = require('../lib/continuity-packets');
const trustees = require('../lib/trustees');
const { saveFileRecord, storeFile } = require('../lib/files');

let pool;
let parent;
let kid;

async function keyFor({ memberId = null, trusteeId = null, fingerprint }) {
  const { rows } = await pool.query(
    `INSERT INTO encryption_keys
       (key_type, member_id, trustee_id, public_key, encrypted_private_key, algorithm, key_fingerprint, protection_tier)
     VALUES ($1, $2, $3, $4, 'wrapped-private', 'x25519', $5, 'passphrase') RETURNING *`,
    [trusteeId ? 'trustee' : 'member', memberId, trusteeId,
      Buffer.from(`public-${fingerprint}`).toString('base64'), fingerprint]
  );
  return rows[0];
}

function wrapped(value) {
  return {
    kind: 'pki_x25519', ephemeral_public_key_b64: `ephemeral-${value}`,
    hkdf_salt_b64: `salt-${value}`, wrapped_dek_b64: `dek-${value}`
  };
}

function envelope(ownerKey, kidKey) {
  return {
    version: 2, mode: 'pki', files: { upload: { cipher: 'aes-256-gcm', holders: [
      { member_id: parent.id, role: 'owner', encryption_key_id: ownerKey.id,
        key_fingerprint: ownerKey.key_fingerprint, wrapped_dek: wrapped('owner') },
      { member_id: kid.id, role: 'beneficiary', sealed: true, sealed_until: 'deadman_trigger',
        encryption_key_id: kidKey.id, key_fingerprint: kidKey.key_fingerprint, wrapped_dek: wrapped('kid') }
    ] } }
  };
}

describe('immutable continuity packet policy', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Packet Parent', 'parent', 'parent-pass');
    kid = await createMember('Packet Kid', 'kid', 'kid-pass');
  });

  it('versions explicit scope, derived coverage, and independent witnesses without mutating history', async () => {
    const ownerKey = await keyFor({ memberId: parent.id, fingerprint: 'packet-owner-key' });
    const kidKey = await keyFor({ memberId: kid.id, fingerprint: 'packet-kid-key' });
    const item = await continuity.saveDraft({
      ownerId: parent.id, reminderEmail: 'owner@family.test', intervalDays: 30,
      gracePeriodDays: 14, recipients: [{ member_id: kid.id }], operationKey: 'packet-draft'
    });
    const metadata = envelope(ownerKey, kidKey);
    const letter = await continuity.stageLetter({
      ownerId: parent.id, switchId: item.id, recipients: [{ member_id: kid.id }],
      encryptionMetadata: metadata, encryptedBytes: Buffer.from('packet-letter-one'), operationKey: 'packet-letter-one'
    });
    const selected = await createTestDocument(parent.id, {
      title: 'Selected encrypted packet item', document_type: 'legal', source_type: 'upload',
      is_encrypted: true, encryption_mode: 'pki', encryption_key_id: ownerKey.id,
      encryption_metadata: metadata
    });
    await saveFileRecord(selected.id, await storeFile(Buffer.from('selected-ciphertext'), 'selected.enc', 'application/octet-stream'));
    const { rows: designationRows } = await pool.query(
      `INSERT INTO document_designations
         (document_id, member_id, role, sealed, sealed_until, encryption_key_id)
       VALUES ($1, $2, 'beneficiary', TRUE, 'deadman_trigger', $3) RETURNING id`,
      [selected.id, kid.id, kidKey.id]
    );
    const trustee = await trustees.createTrustee({
      name: 'Packet Witness', email: 'witness@family.test', createdBy: parent.id
    });
    const invitation = await trustees.createTrusteeInvitation({ trusteeId: trustee.id });
    await trustees.registerTrusteeFromInvitation({
      token: invitation.token, publicKey: Buffer.from('witness-key').toString('base64'),
      encryptedPrivateKey: 'witness-wrapped-key'
    });

    const first = await packets.stagePacket({
      ownerId: parent.id, switchId: item.id, selectedDocumentIds: [selected.id],
      witnessTrusteeIds: [trustee.id], operationKey: 'packet-version-one'
    });
    assert.equal(Number(first.version_number), 1);
    assert.deepEqual(first.documents.map((row) => row.item_kind), ['letter', 'selected']);
    assert.deepEqual(first.coverage.map((row) => row.coverage_status), ['covered', 'covered']);
    assert.equal(Number(first.coverage[1].designation_id), designationRows[0].id);
    assert.match(first.policy_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual((await packets.getPacketForOwner({ ownerId: parent.id, switchId: item.id })).witnesses,
      [{ id: trustee.id, name: 'Packet Witness' }]);

    const second = await packets.stagePacket({
      ownerId: parent.id, switchId: item.id, selectedDocumentIds: [],
      witnessTrusteeIds: [], operationKey: 'packet-version-two'
    });
    assert.equal(Number(second.version_number), 2);
    const { rows: versions } = await pool.query(
      'SELECT id, status FROM continuity_packet_versions WHERE switch_id = $1 ORDER BY version_number', [item.id]
    );
    assert.deepEqual(versions, [
      { id: first.id, status: 'superseded' }, { id: second.id, status: 'staged' }
    ]);
    const { rows: historicalCoverage } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM continuity_packet_recipient_documents coverage
       JOIN continuity_packet_recipients recipient ON recipient.id = coverage.packet_recipient_id
       WHERE recipient.packet_version_id = $1`, [first.id]
    );
    assert.equal(historicalCoverage[0].count, 2);
    await assert.rejects(
      pool.query('UPDATE continuity_packet_documents SET packet_order = 9 WHERE packet_version_id = $1', [first.id]),
      /immutable/i
    );
    await assert.rejects(
      pool.query('DELETE FROM continuity_packet_versions WHERE id = $1', [first.id]),
      /immutable/i
    );

    await continuity.stageLetter({
      ownerId: parent.id, switchId: item.id, recipients: [{ member_id: kid.id }],
      encryptionMetadata: metadata, encryptedBytes: Buffer.from('packet-letter-two'), operationKey: 'packet-letter-two'
    });
    const { rows: invalidated } = await pool.query(
      `SELECT cs.staged_packet_version_id, packet.status, d.status AS old_letter_status
       FROM continuity_switches cs
       JOIN continuity_packet_versions packet ON packet.id = $2
       JOIN documents d ON d.id = $3 WHERE cs.id = $1`, [item.id, second.id, letter.id]
    );
    assert.equal(invalidated[0].staged_packet_version_id, null);
    assert.equal(invalidated[0].status, 'superseded');
    assert.equal(invalidated[0].old_letter_status, 'archived');
  });
});
