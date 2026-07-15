'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { authedGet, authedPost, createMember, createTestDocument, getPool, loginAs, resetDatabase, startServer, stopServer } = require('./helpers');
const pki = require('../lib/pki');

let pool;
let parent;
let kid;
let parentCookie;
let kidCookie;

function publicKey(value) { return Buffer.from(value, 'utf8').toString('base64'); }
function wrapped(seed) { return { kind: 'pki_x25519', ephemeral_public_key_b64: `${seed}-ephemeral`, hkdf_salt_b64: `${seed}-salt`, wrapped_dek_b64: `${seed}-wrapped` }; }

describe('sealed designation API', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Seal Parent', 'parent', 'parent-pass');
    kid = await createMember('Seal Kid', 'kid', 'kid-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
    kidCookie = await loginAs(kid, 'kid-pass');
  });

  it('seals a beneficiary holder, synchronizes the projection, and removes kid route access', async () => {
    const ownerKey = await pki.registerMemberKey({ memberId: parent.id, publicKey: publicKey('owner'), encryptedPrivateKey: 'owner-private', algorithm: 'x25519', credentialId: null, prfEnabled: false, protectionTier: 'passphrase', label: 'Owner key' });
    const beneficiaryKey = await pki.registerMemberKey({ memberId: kid.id, publicKey: publicKey('beneficiary'), encryptedPrivateKey: 'beneficiary-private', algorithm: 'x25519', credentialId: null, prfEnabled: false, protectionTier: 'passphrase', label: 'Beneficiary key' });
    const document = await createTestDocument(parent.id, {
      title: 'Sealed Estate Instructions', owner_ids: [parent.id, kid.id], is_encrypted: true, encryption_mode: 'pki', encryption_key_id: ownerKey.id,
      encryption_metadata: { version: 1, mode: 'pki', files: { upload: { cipher: 'aes-256-gcm', iv_b64: 'iv', holders: [{ member_id: parent.id, encryption_key_id: ownerKey.id, key_fingerprint: ownerKey.key_fingerprint, role: 'owner', wrapped_dek: wrapped('owner') }] } } }
    });
    const envelope = { version: 2, mode: 'pki', files: { upload: { cipher: 'aes-256-gcm', iv_b64: 'iv', holders: [
      { member_id: parent.id, encryption_key_id: ownerKey.id, key_fingerprint: ownerKey.key_fingerprint, role: 'owner', wrapped_dek: wrapped('owner') },
      { member_id: kid.id, encryption_key_id: beneficiaryKey.id, key_fingerprint: beneficiaryKey.key_fingerprint, role: 'beneficiary', sealed: true, sealed_until: 'deadman_trigger', wrapped_dek: wrapped('beneficiary') }
    ] } } };

    const response = await authedPost(`api/documents/${document.id}/designations/seal`, parentCookie, { encryption_metadata: envelope });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.document.encryption_metadata.version, 2);

    const { rows: designations } = await pool.query('SELECT * FROM document_designations WHERE document_id = $1', [document.id]);
    assert.equal(designations.length, 1);
    assert.equal(designations[0].member_id, kid.id);
    assert.equal(designations[0].sealed, true);

    const keyInfo = await authedGet(`api/documents/${document.id}/key-info`, parentCookie);
    const info = await keyInfo.json();
    const sealedHolder = info.holders.find((holder) => holder.encryption_key_id === beneficiaryKey.id);
    assert.equal(sealedHolder.sealed, true);
    assert.equal(sealedHolder.unlock_eligible, false);

    const directory = await authedGet('api/continuity/directory', parentCookie);
    assert.equal(directory.status, 200);
    const directoryData = await directory.json();
    assert.equal(directoryData.members.find((member) => member.id === kid.id).designation_count, 1);
    assert.equal(directoryData.documents.find((entry) => entry.id === document.id).designations[0].sealed, true);
    assert.equal((await authedGet('api/continuity/directory', kidCookie)).status, 403);

    const undesignated = await createTestDocument(parent.id, { title: 'Undesignated document' });
    const refreshedDirectory = await authedGet('api/continuity/directory', parentCookie);
    assert.equal((await refreshedDirectory.json()).documents.some((entry) => entry.id === undesignated.id), false);

    assert.equal((await authedGet(`api/documents/${document.id}`, kidCookie)).status, 403);
    const kidDocs = await authedGet('api/documents', kidCookie);
    assert.equal((await kidDocs.json()).documents.some((entry) => entry.id === document.id), false);

    // The projection is deliberately rebuildable; unseal must recreate it with coherent state.
    await pool.query('DELETE FROM document_designations WHERE document_id = $1', [document.id]);
    const unseal = await authedPost(`api/documents/${document.id}/designations/${beneficiaryKey.id}/unseal`, parentCookie, {});
    assert.equal(unseal.status, 200);
    const { rows: rebuilt } = await pool.query('SELECT sealed, sealed_until FROM document_designations WHERE document_id = $1', [document.id]);
    assert.deepEqual(rebuilt, [{ sealed: false, sealed_until: 'unsealed' }]);
    assert.equal((await authedGet(`api/documents/${document.id}`, kidCookie)).status, 200);
  });
});
