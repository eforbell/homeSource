'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  authedDel, authedGet, authedPost, authedPut, createMember, createTestDocument,
  getPool, loginAs, resetDatabase, startServer, stopServer
} = require('./helpers');
const continuity = require('../lib/continuity');
const insights = require('../lib/insights');
const trustees = require('../lib/trustees');
const { saveFileRecord, storeFile } = require('../lib/files');

let pool;
let owner;
let otherParent;
let beneficiary;
let ownerCookie;
let otherCookie;
let beneficiaryCookie;
let letter;
let selected;
let ordinary;
let letterFile;
let selectedFile;
let beneficiaryKey;
let letterInsight;
let continuitySwitch;
let ownedTrustee;

async function createKey(memberId, fingerprint) {
  const { rows } = await pool.query(
    `INSERT INTO encryption_keys
       (key_type, member_id, public_key, encrypted_private_key, algorithm, key_fingerprint, protection_tier)
     VALUES ('member', $1, $2, 'wrapped-private', 'x25519', $3, 'passphrase') RETURNING *`,
    [memberId, Buffer.from(`public-${fingerprint}`).toString('base64'), fingerprint]
  );
  return rows[0];
}

function wrap(value) {
  return {
    kind: 'pki_x25519', ephemeral_public_key_b64: `ephemeral-${value}`,
    hkdf_salt_b64: `salt-${value}`, wrapped_dek_b64: `wrapped-${value}`
  };
}

function envelope(ownerKey, kidKey) {
  return {
    version: 2, mode: 'pki', files: { upload: { cipher: 'aes-256-gcm', holders: [
      { member_id: owner.id, role: 'owner', encryption_key_id: ownerKey.id,
        key_fingerprint: ownerKey.key_fingerprint, wrapped_dek: wrap('owner') },
      { member_id: beneficiary.id, role: 'beneficiary', sealed: true, sealed_until: 'deadman_trigger',
        encryption_key_id: kidKey.id, key_fingerprint: kidKey.key_fingerprint, wrapped_dek: wrap('beneficiary') }
    ] } }
  };
}

async function createPkiDocument({ title, metadata = {} }) {
  const ownerKey = await createKey(owner.id, `${title}-owner-key`);
  const doc = await createTestDocument(owner.id, {
    title, document_type: 'legal', source_type: 'upload', status: 'active', metadata,
    is_encrypted: true, encryption_mode: 'pki', encryption_key_id: ownerKey.id,
    encryption_metadata: envelope(ownerKey, beneficiaryKey)
  });
  const file = await saveFileRecord(
    doc.id,
    await storeFile(Buffer.from(`${title}-ciphertext`), `${title}.enc`, 'application/octet-stream')
  );
  await pool.query(
    `INSERT INTO document_designations
       (document_id, member_id, role, sealed, sealed_until, encryption_key_id)
     VALUES ($1, $2, 'beneficiary', TRUE, 'deadman_trigger', $3)`,
    [doc.id, beneficiary.id, beneficiaryKey.id]
  );
  return { doc, file };
}

function uploadHolders(payload) {
  return payload?.encryption_metadata?.files?.upload?.holders || [];
}

describe('continuity-aware authorization boundary', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createMember('Continuity Owner', 'parent', 'owner-pass');
    otherParent = await createMember('Other Parent', 'parent', 'other-pass');
    beneficiary = await createMember('Continuity Beneficiary', 'kid', 'kid-pass');
    ownerCookie = await loginAs(owner, 'owner-pass');
    otherCookie = await loginAs(otherParent, 'other-pass');
    beneficiaryCookie = await loginAs(beneficiary, 'kid-pass');
    beneficiaryKey = await createKey(beneficiary.id, 'beneficiary-key');

    continuitySwitch = await continuity.saveDraft({
      ownerId: owner.id, reminderEmail: 'owner@family.test', intervalDays: 30,
      gracePeriodDays: 14, recipients: [{ member_id: beneficiary.id }], operationKey: 'authz-draft'
    });
    ({ doc: letter, file: letterFile } = await createPkiDocument({
      title: 'Private Continuity Letter', metadata: { continuity_letter: true }
    }));
    await pool.query(
      'UPDATE continuity_switches SET letter_document_id = $2 WHERE id = $1',
      [continuitySwitch.id, letter.id]
    );
    ({ doc: selected, file: selectedFile } = await createPkiDocument({
      title: 'Ordinary Selected Policy'
    }));
    const { rows: packetRows } = await pool.query(
      `INSERT INTO continuity_packet_versions
         (switch_id, version_number, status, letter_document_id, policy_hash, operation_key, created_by, activated_at)
       VALUES ($1, 1, 'active', $2, $3, 'authorization-fixture', $4, NOW()) RETURNING id`,
      [continuitySwitch.id, letter.id, 'a'.repeat(64), owner.id]
    );
    await pool.query(
      `INSERT INTO continuity_packet_documents (packet_version_id, document_id, item_kind, packet_order)
       VALUES ($1, $2, 'letter', 1), ($1, $3, 'selected', 2)`,
      [packetRows[0].id, letter.id, selected.id]
    );
    await pool.query(
      'UPDATE continuity_switches SET active_packet_version_id = $2 WHERE id = $1',
      [continuitySwitch.id, packetRows[0].id]
    );
    ordinary = await createTestDocument(owner.id, { title: 'Ordinary Link Target' });
    await pool.query(
      `INSERT INTO magic_links
         (source_document_id, target_document_id, link_type, reasoning, confidence, created_by, status)
       VALUES ($1, $2, 'relates_to', 'authorization fixture', 1, 'user', 'accepted')`,
      [letter.id, ordinary.id]
    );
    letterInsight = await insights.upsertInsight({
      category: 'document_quality', severity: 'warning', subject_type: 'document',
      subject_id: letter.id, dedupe_key: 'continuity-authz-letter', title: 'Letter leaked insight',
      body: {}, source_document_ids: [letter.id], status: 'new'
    });
    ownedTrustee = await trustees.createTrustee({
      name: 'Owner Witness', email: 'owner-witness@family.test', createdBy: owner.id
    });
    await trustees.createTrusteeInvitation({ trusteeId: ownedTrustee.id });
  });

  it('hides Letter metadata, key material, files, and administration from another parent', async () => {
    const listRes = await authedGet('api/documents', otherCookie);
    assert.equal(listRes.status, 200);
    const listed = await listRes.json();
    assert.equal(listed.documents.some((doc) => doc.id === letter.id), false);

    const searchRes = await authedGet('api/search?q=Private+Continuity+Letter', otherCookie);
    assert.equal(searchRes.status, 200);
    assert.equal((await searchRes.json()).total, 0);

    for (const path of [
      `api/documents/${letter.id}`,
      `api/documents/${letter.id}/key-info`,
      `api/documents/${letter.id}/magicindex-status`,
      `api/documents/${letter.id}/files/${letterFile.id}/download`,
      `api/documents/${letter.id}/links`
    ]) {
      assert.equal((await authedGet(path, otherCookie)).status, 403, path);
    }

    assert.equal((await authedPut(`api/documents/${letter.id}`, otherCookie, { title: 'Stolen title' })).status, 403);
    assert.equal((await authedPut(`api/documents/${letter.id}/tags`, otherCookie, { tag_ids: [] })).status, 403);
    assert.equal((await authedPost(`api/documents/${letter.id}/owners`, otherCookie, { member_id: otherParent.id })).status, 403);
    assert.equal((await authedPost(`api/documents/${letter.id}/links`, otherCookie, {
      target_document_id: ordinary.id, link_type: 'relates_to'
    })).status, 403);
    assert.equal((await authedPut(`api/documents/${letter.id}`, ownerCookie, { title: 'Bypass workflow' })).status, 403);
    assert.equal((await authedPost(`api/documents/${letter.id}/share`, ownerCookie, { access_level: 'view' })).status, 403);
    assert.equal((await authedGet(`api/continuity/switch/${continuitySwitch.id}/packet`, otherCookie)).status, 404);

    const ownerDetail = await authedGet(`api/documents/${letter.id}`, ownerCookie);
    assert.equal(ownerDetail.status, 200);
    assert.equal(uploadHolders(await ownerDetail.json()).length, 2);
    assert.equal((await authedGet(`api/documents/${letter.id}/files/${letterFile.id}/download`, ownerCookie)).status, 200);

    const dependencyRes = await authedGet(
      `api/members/${beneficiary.id}/keys/${beneficiaryKey.id}/dependencies`, beneficiaryCookie
    );
    assert.equal(dependencyRes.status, 200);
    const dependency = await dependencyRes.json();
    assert.equal(dependency.documents[0].document_id, null);
    assert.equal(dependency.documents[0].title, 'Protected continuity document');
  });

  it('preserves ordinary document access while redacting continuity-specific sealed wraps', async () => {
    const detailRes = await authedGet(`api/documents/${selected.id}`, otherCookie);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.deepEqual(uploadHolders(detail).map((holder) => holder.role), ['owner']);
    assert.doesNotMatch(JSON.stringify(detail), /wrapped-beneficiary/);

    const keyRes = await authedGet(`api/documents/${selected.id}/key-info`, otherCookie);
    assert.equal(keyRes.status, 200);
    const keyInfo = await keyRes.json();
    assert.deepEqual(keyInfo.holders.map((holder) => holder.role), ['owner']);
    assert.doesNotMatch(JSON.stringify(keyInfo), /beneficiary-key|wrapped-beneficiary/);
    assert.equal((await authedGet(`api/documents/${selected.id}/files/${selectedFile.id}/download`, otherCookie)).status, 200);

    const updateRes = await authedPut(`api/documents/${selected.id}`, otherCookie, { description: 'packet sabotage' });
    assert.equal(updateRes.status, 403);

    const relatedRes = await authedGet(`api/documents/${ordinary.id}/links`, otherCookie);
    assert.equal(relatedRes.status, 200);
    assert.deepEqual(await relatedRes.json(), []);

    const unsealRes = await authedPost(
      `api/documents/${selected.id}/designations/${beneficiaryKey.id}/unseal`, otherCookie, {}
    );
    assert.equal(unsealRes.status, 403);

    const ownerDetail = await authedGet(`api/documents/${selected.id}`, ownerCookie);
    assert.equal(uploadHolders(await ownerDetail.json()).length, 2);
  });

  it('removes another owner Letter and sealed-designation inventory from aggregate surfaces', async () => {
    const statsRes = await authedGet('api/stats', otherCookie);
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();
    assert.equal(stats.recent.some((doc) => doc.id === letter.id), false);

    const directoryRes = await authedGet('api/continuity/directory', otherCookie);
    assert.equal(directoryRes.status, 200);
    const directory = await directoryRes.json();
    assert.equal(directory.documents.some((doc) => doc.id === letter.id || doc.id === selected.id), false);
    const kid = directory.members.find((member) => member.id === beneficiary.id);
    assert.equal(kid.designation_count, 0);

    const postureRes = await authedGet('api/pki/posture', otherCookie);
    assert.equal(postureRes.status, 200);
    const posture = await postureRes.json();
    assert.equal(posture.documents.some((doc) => doc.title === 'Private Continuity Letter'), false);
    assert.equal(posture.key_documents.some((doc) => doc.title === 'Private Continuity Letter'), false);

    const insightListRes = await authedGet('api/insights', otherCookie);
    assert.equal(insightListRes.status, 200);
    assert.equal((await insightListRes.json()).some((entry) => entry.id === letterInsight.id), false);
    assert.equal((await authedGet(`api/insights/${letterInsight.id}`, otherCookie)).status, 403);
    const summaryRes = await authedGet('api/insights/summary', otherCookie);
    assert.equal(summaryRes.status, 200);
    assert.equal((await summaryRes.json()).action_required_count, 0);

    const trusteesRes = await authedGet('api/trustees', otherCookie);
    assert.equal(trusteesRes.status, 200);
    assert.deepEqual(await trusteesRes.json(), []);
    assert.equal((await authedPost(`api/trustees/${ownedTrustee.id}/invitations/resend`, otherCookie, {})).status, 404);
    assert.equal((await authedDel(`api/trustees/${ownedTrustee.id}`, otherCookie)).status, 404);
  });
});
