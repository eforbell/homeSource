'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, url } = require('./helpers');
const pki = require('../lib/pki');

let parent;
let kid;
let parentCookie;
let kidCookie;

async function createKey(member, label, overrides = {}) {
  return pki.registerMemberKey({
    memberId: member.id,
    publicKey: Buffer.from(`${label}-${member.id}`).toString('base64'),
    encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"def"}',
    algorithm: 'x25519',
    credentialId: null,
    prfEnabled: false,
    protectionTier: 'passphrase',
    label,
    ...overrides
  });
}

function holderFor(member, key, role = 'owner', overrides = {}) {
  return {
    member_id: member.id,
    encryption_key_id: key.id,
    key_fingerprint: key.key_fingerprint,
    role,
    wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' },
    ...overrides
  };
}

async function createPkiDoc({ title, owner, owners = [owner.id], primaryKey, holders, extraFiles = {} }) {
  const { createDocument } = require('../lib/documents');
  return createDocument({
    title,
    document_type: 'other',
    source_type: 'upload',
    created_by: owner.id,
    is_encrypted: true,
    encryption_mode: 'pki',
    encryption_key_id: primaryKey.id,
    encryption_metadata: {
      version: 1,
      mode: 'pki',
      files: {
        upload: {
          cipher: 'aes-256-gcm',
          iv_b64: 'abc',
          holders
        },
        ...extraFiles
      }
    }
  }, owners);
}

function byLabel(keys, label) {
  return keys.find((key) => key.label === label);
}

describe('PKI posture API', () => {
  before(async () => {
    await startServer();
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Parker', 'parent', 'pass123');
    kid = await createMember('Kira', 'kid', 'kidpass');
    parentCookie = await loginAs(parent, 'pass123');
    kidCookie = await loginAs(kid, 'kidpass');
  });

  it('requires authentication', async () => {
    const res = await fetch(url('api/pki/posture'));
    assert.equal(res.status, 401);
  });

  it('lets a parent see household PKI posture', async () => {
    const parentPrimary = await createKey(parent, 'Parent Primary');
    const parentBackup = await createKey(parent, 'Parent Backup');
    const kidPrimary = await createKey(kid, 'Kid Primary');

    await createPkiDoc({
      title: 'Parent Healthy Doc',
      owner: parent,
      primaryKey: parentPrimary,
      holders: [
        holderFor(parent, parentPrimary, 'owner'),
        holderFor(parent, parentBackup, 'backup')
      ]
    });
    await createPkiDoc({
      title: 'Kid Sole Doc',
      owner: kid,
      primaryKey: kidPrimary,
      holders: [holderFor(kid, kidPrimary, 'owner')]
    });

    const res = await authedGet('api/pki/posture', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.summary.pki_document_count, 2);
    assert.equal(data.summary.healthy_document_count, 1);
    assert.equal(data.summary.at_risk_document_count, 1);
    assert.ok(byLabel(data.keys, 'Parent Primary'));
    assert.ok(byLabel(data.keys, 'Parent Backup'));
    assert.ok(byLabel(data.keys, 'Kid Primary'));
    assert.deepEqual(data.documents.map((doc) => doc.title).sort(), ['Kid Sole Doc', 'Parent Healthy Doc']);
  });

  it('scopes kid posture to own keys and accessible document titles', async () => {
    const parentPrimary = await createKey(parent, 'Parent Primary');
    const kidBeneficiary = await createKey(kid, 'Kid Beneficiary');
    const kidPrimary = await createKey(kid, 'Kid Primary');

    await createPkiDoc({
      title: 'Parent Hidden Doc',
      owner: parent,
      primaryKey: parentPrimary,
      holders: [
        holderFor(parent, parentPrimary, 'owner'),
        holderFor(kid, kidBeneficiary, 'beneficiary')
      ]
    });
    await createPkiDoc({
      title: 'Kid Visible Doc',
      owner: kid,
      primaryKey: kidPrimary,
      holders: [holderFor(kid, kidPrimary, 'owner')]
    });

    const res = await authedGet('api/pki/posture', kidCookie);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.deepEqual(data.keys.map((key) => key.label).sort(), ['Kid Beneficiary', 'Kid Primary']);
    assert.deepEqual(data.documents.map((doc) => doc.title), ['Kid Visible Doc']);
    assert.equal(data.key_documents.some((doc) => doc.title === 'Parent Hidden Doc'), false);
  });

  it('counts a key dependency before any revoke attempt', async () => {
    const primary = await createKey(parent, 'Two Doc Primary');
    const backup = await createKey(parent, 'Two Doc Backup');

    await createPkiDoc({
      title: 'Sole Protected',
      owner: parent,
      primaryKey: primary,
      holders: [holderFor(parent, primary, 'owner')]
    });
    await createPkiDoc({
      title: 'Redundant Protected',
      owner: parent,
      primaryKey: primary,
      holders: [holderFor(parent, primary, 'owner'), holderFor(parent, backup, 'backup')]
    });

    const res = await authedGet('api/pki/posture', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    const keyPosture = byLabel(data.keys, 'Two Doc Primary');

    assert.equal(keyPosture.document_count, 2);
    assert.equal(keyPosture.at_risk_docs, 1);
    assert.equal(keyPosture.safe_docs, 1);
  });

  it('classifies stranded documents and all-revoked key dependencies', async () => {
    const primary = await createKey(parent, 'Stranded Primary');
    const backup = await createKey(parent, 'Stranded Backup');

    await createPkiDoc({
      title: 'Stranded Doc',
      owner: parent,
      primaryKey: primary,
      holders: [holderFor(parent, primary, 'owner'), holderFor(parent, backup, 'backup')]
    });
    await pki.revokeMemberKey(primary.id, parent.id, parent.id);
    await pki.revokeMemberKey(backup.id, parent.id, parent.id);

    const res = await authedGet('api/pki/posture', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.summary.stranded_document_count, 1);
    assert.equal(data.documents[0].status, 'stranded_no_active_holders');
    assert.equal(data.key_documents.find((doc) => doc.key_id === primary.id).status, 'all_holders_revoked');
  });

  it('classifies malformed holder metadata without a server error', async () => {
    const primary = await createKey(parent, 'Malformed Primary');
    const malformedHolder = holderFor(parent, primary, 'owner');
    delete malformedHolder.key_fingerprint;

    await createPkiDoc({
      title: 'Malformed Doc',
      owner: parent,
      primaryKey: primary,
      holders: [malformedHolder]
    });

    const res = await authedGet('api/pki/posture', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.summary.inconsistent_document_count, 1);
    assert.equal(data.documents[0].status, 'holder_metadata_inconsistent');
    assert.equal(data.key_documents[0].status, 'holder_metadata_inconsistent');
  });

  it('counts untested and missing-recovery active keys while excluding revoked keys', async () => {
    const untestedNoRecovery = await createKey(parent, 'Untested No Recovery');
    const testedWithRecovery = await createKey(parent, 'Tested With Recovery');
    const revokedNoRecovery = await createKey(parent, 'Revoked No Recovery');

    await pki.updateKeyLastUsed(testedWithRecovery.id);
    await pki.saveRecoveryWrap(testedWithRecovery.id, parent.id, '{"wrapped":"private"}');
    await pki.revokeMemberKey(revokedNoRecovery.id, parent.id, parent.id);

    const res = await authedGet('api/pki/posture', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.summary.active_key_count, 2);
    assert.equal(data.summary.untested_active_key_count, 1);
    assert.equal(data.summary.keys_without_recovery_count, 1);
    assert.equal(byLabel(data.keys, 'Untested No Recovery').document_count, 0);
  });

  it('marks an active self-owned key tested through the readiness endpoint', async () => {
    const key = await createKey(parent, 'Self Tested Key');

    const res = await authedPost(`api/members/${parent.id}/keys/${key.id}/tested`, parentCookie, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.key.last_used_at);

    const postureRes = await authedGet('api/pki/posture', parentCookie);
    assert.equal(postureRes.status, 200);
    const posture = await postureRes.json();
    assert.equal(byLabel(posture.keys, 'Self Tested Key').last_used_at, data.key.last_used_at);
  });

  it('rejects tested updates for cross-member and revoked keys', async () => {
    const parentKey = await createKey(parent, 'Parent Tested Forbidden');
    const revokedKey = await createKey(kid, 'Kid Revoked Tested');
    await pki.revokeMemberKey(revokedKey.id, kid.id, kid.id);

    const crossRes = await authedPost(`api/members/${parent.id}/keys/${parentKey.id}/tested`, kidCookie, {});
    assert.equal(crossRes.status, 403);

    const revokedRes = await authedPost(`api/members/${kid.id}/keys/${revokedKey.id}/tested`, kidCookie, {});
    assert.equal(revokedRes.status, 404);
  });
});
