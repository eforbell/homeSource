'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMember, createTestDocument, getPool, resetDatabase, startServer, stopServer } = require('./helpers');
const trustees = require('../lib/trustees');

let pool;
let parent;
let beneficiary;

describe('trustee and designation data model', () => {
  before(async () => {
    await startServer();
    pool = getPool();
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Trustee Parent', 'parent', 'passphrase');
    beneficiary = await createMember('Trustee Beneficiary', 'kid', 'passphrase');
  });

  it('creates trustees as externally scoped, invited principals', async () => {
    const trustee = await trustees.createTrustee({
      name: 'Morgan Trustee',
      relationship: 'Attorney',
      email: 'morgan@family.test',
      createdBy: parent.id
    });

    assert.equal(trustee.name, 'Morgan Trustee');
    assert.equal(trustee.relationship, 'Attorney');
    assert.equal(trustee.email, 'morgan@family.test');
    assert.equal(trustee.status, 'invited');
    assert.equal(trustee.created_by, parent.id);
  });

  it('allows a trustee-owned key while preserving member-key ownership', async () => {
    const trustee = await trustees.createTrustee({
      name: 'Morgan Trustee',
      email: 'morgan@family.test',
      createdBy: parent.id
    });
    const { rows } = await pool.query(
      `INSERT INTO encryption_keys (key_type, trustee_id, public_key, encrypted_private_key, algorithm, key_fingerprint)
       VALUES ('trustee', $1, 'public', 'wrapped', 'x25519', 'trustee-fingerprint')
       RETURNING *`,
      [trustee.id]
    );

    assert.equal(rows[0].member_id, null);
    assert.equal(rows[0].trustee_id, trustee.id);
    assert.equal(rows[0].key_type, 'trustee');

    await assert.rejects(
      pool.query(
        `INSERT INTO encryption_keys (key_type, member_id, trustee_id, public_key, encrypted_private_key, algorithm)
         VALUES ('trustee', $1, $2, 'public', 'wrapped', 'x25519')`,
        [parent.id, trustee.id]
      ),
      /encryption_keys_principal_check/
    );
  });

  it('projects a sealed beneficiary designation with exactly one recipient identity', async () => {
    const document = await createTestDocument(parent.id, { title: 'Estate Instructions' });
    const designation = await trustees.createDesignation({
      documentId: document.id,
      memberId: beneficiary.id,
      role: 'beneficiary',
      encryptionKeyId: null
    });

    assert.equal(designation.document_id, document.id);
    assert.equal(designation.member_id, beneficiary.id);
    assert.equal(designation.trustee_id, null);
    assert.equal(designation.role, 'beneficiary');
    assert.equal(designation.sealed, true);
    assert.equal(designation.sealed_until, 'deadman_trigger');
  });

  it('rejects ambiguous designation identities', async () => {
    const trustee = await trustees.createTrustee({
      name: 'Morgan Trustee',
      email: 'morgan@family.test',
      createdBy: parent.id
    });
    const document = await createTestDocument(parent.id, { title: 'Estate Instructions' });

    await assert.rejects(
      trustees.createDesignation({
        documentId: document.id,
        memberId: beneficiary.id,
        trusteeId: trustee.id,
        role: 'beneficiary'
      }),
      /exactly one recipient identity/
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO document_designations (document_id, member_id, trustee_id, role)
         VALUES ($1, $2, $3, 'beneficiary')`,
        [document.id, beneficiary.id, trustee.id]
      ),
      /document_designations_check/
    );
  });
});
