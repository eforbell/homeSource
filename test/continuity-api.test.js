'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  authedGet, authedPost, createMember, getPool, loginAs, resetDatabase, startServer, stopServer
} = require('./helpers');

let pool;
let parent;
let kid;
let parentCookie;
let kidCookie;
let previousEnv;

async function keyFor({ memberId = null, trusteeId = null, fingerprint }) {
  const { rows } = await pool.query(
    `INSERT INTO encryption_keys
       (key_type, member_id, trustee_id, public_key, encrypted_private_key, algorithm, key_fingerprint, protection_tier)
     VALUES ($1, $2, $3, $4, 'wrapped-private', 'x25519', $5, 'passphrase') RETURNING *`,
    [trusteeId ? 'trustee' : 'member', memberId, trusteeId, Buffer.from(`public-${fingerprint}`).toString('base64'), fingerprint]
  );
  return rows[0];
}

function wrap(value) {
  return {
    kind: 'pki_x25519',
    ephemeral_public_key_b64: Buffer.from(`ephemeral-${value}`).toString('base64'),
    hkdf_salt_b64: Buffer.from(`salt-${value}`).toString('base64'),
    wrapped_dek_b64: Buffer.from(`dek-${value}`).toString('base64')
  };
}

describe('continuity switch API', () => {
  before(async () => {
    previousEnv = {
      APP_URL: process.env.APP_URL, MAIL_TRANSPORT: process.env.MAIL_TRANSPORT,
      SMTP_FROM: process.env.SMTP_FROM
    };
    process.env.APP_URL = 'https://home.family.test';
    process.env.MAIL_TRANSPORT = 'file';
    process.env.SMTP_FROM = 'Home Source <home@family.test>';
    await startServer();
    pool = getPool();
  });
  after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await stopServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('API Continuity Parent', 'parent', 'parent-pass');
    kid = await createMember('API Continuity Kid', 'kid', 'kid-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
    kidCookie = await loginAs(kid, 'kid-pass');
  });

  it('stages an envelope-canonical letter, hides it, and arms with re-authentication', async () => {
    const ownerKey = await keyFor({ memberId: parent.id, fingerprint: 'owner-fingerprint' });
    const kidKey = await keyFor({ memberId: kid.id, fingerprint: 'kid-fingerprint' });
    const draftRes = await authedPost('api/continuity/switch/draft', parentCookie, {
      reminder_email: 'owner@family.test', interval_days: 30, grace_period_days: 14,
      recipients: [{ member_id: kid.id }], operation_key: 'draft-api-1'
    });
    assert.equal(draftRes.status, 200);
    const item = await draftRes.json();
    const metadata = {
      version: 2, mode: 'pki', policy: { access_model: 'any_one_holder', threshold: 1 },
      files: { upload: { cipher: 'aes-256-gcm', iv_b64: 'aXY=', tag_length_bits: 128, holders: [
        { member_id: parent.id, encryption_key_id: ownerKey.id, key_fingerprint: ownerKey.key_fingerprint, role: 'owner', wrapped_dek: wrap('owner') },
        { member_id: kid.id, encryption_key_id: kidKey.id, key_fingerprint: kidKey.key_fingerprint, role: 'beneficiary', sealed: true, sealed_until: 'deadman_trigger', wrapped_dek: wrap('kid') }
      ] } }
    };
    const staged = await authedPost(`api/continuity/switch/${item.id}/letter/stage`, parentCookie, {
      recipients: [{ member_id: kid.id }], encryption_metadata: metadata,
      payload_b64: Buffer.from('encrypted-letter-ciphertext').toString('base64'), operation_key: 'stage-api-1'
    });
    assert.equal(staged.status, 201);
    const firstStagedPayload = await staged.json();
    const stagedReplay = await authedPost(`api/continuity/switch/${item.id}/letter/stage`, parentCookie, {
      recipients: [{ member_id: kid.id }], encryption_metadata: metadata,
      payload_b64: Buffer.from('unused-replay-ciphertext').toString('base64'), operation_key: 'stage-api-1'
    });
    assert.equal(stagedReplay.status, 201);
    assert.equal((await stagedReplay.json()).document_id, firstStagedPayload.document_id);

    const replacementStage = await authedPost(`api/continuity/switch/${item.id}/letter/stage`, parentCookie, {
      recipients: [{ member_id: kid.id }], encryption_metadata: metadata,
      payload_b64: Buffer.from('replacement-encrypted-ciphertext').toString('base64'), operation_key: 'stage-api-2'
    });
    assert.equal(replacementStage.status, 201);
    const stagedPayload = await replacementStage.json();
    assert.notEqual(stagedPayload.document_id, firstStagedPayload.document_id);
    const { rows: stagedDocs } = await pool.query(
      `SELECT id FROM documents WHERE status = 'staged' AND source_type = 'authored'`
    );
    assert.deepEqual(stagedDocs.map(row => row.id), [stagedPayload.document_id]);
    const hidden = await authedGet(`api/documents/${stagedPayload.document_id}`, parentCookie);
    assert.equal(hidden.status, 403);

    const wrong = await authedPost(`api/continuity/switch/${item.id}/letter/commit`, parentCookie, {
      current_passphrase: 'wrong-pass', operation_key: 'commit-api-1'
    });
    assert.equal(wrong.status, 400);
    const armed = await authedPost(`api/continuity/switch/${item.id}/letter/commit`, parentCookie, {
      current_passphrase: 'parent-pass', operation_key: 'commit-api-1'
    });
    assert.equal(armed.status, 200);
    assert.equal((await armed.json()).status, 'armed');
    const armedReplay = await authedPost(`api/continuity/switch/${item.id}/letter/commit`, parentCookie, {
      current_passphrase: 'parent-pass', operation_key: 'commit-api-1'
    });
    assert.equal(armedReplay.status, 200);
    assert.equal((await armedReplay.json()).status, 'armed');
    const visible = await authedGet(`api/documents/${stagedPayload.document_id}`, parentCookie);
    assert.equal(visible.status, 200);
    const { rows: designations } = await pool.query('SELECT sealed, member_id FROM document_designations WHERE document_id = $1', [stagedPayload.document_id]);
    assert.deepEqual(designations, [{ sealed: true, member_id: kid.id }]);

    const backup = await authedPost('api/backup/export', parentCookie, { encrypted: false });
    assert.equal(backup.status, 200);
    const backupPayload = await backup.json();
    const archive = path.join(process.env.STORAGE_PATH, 'exports', backupPayload.file);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-continuity-backup-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', extracted]);
      const root = fs.readdirSync(extracted).map(name => path.join(extracted, name)).find(candidate => fs.statSync(candidate).isDirectory());
      const database = JSON.parse(fs.readFileSync(path.join(root, 'database.json'), 'utf8'));
      assert.equal(database.continuity_switches.length, 1);
      assert.equal(database.continuity_recipients.length, 1);
      assert.ok(database.continuity_events.some(event => event.event_type === 'switch.armed'));
      assert.equal(database.documents.find(doc => Number(doc.id) === Number(stagedPayload.document_id)).source_type, 'authored');
      assert.doesNotMatch(JSON.stringify(database), /parent-pass|encrypted-letter-ciphertext/);
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
    }
  });

  it('rejects kid access, mismatched envelopes, and destructive actions without the owner passphrase', async () => {
    const kidDraft = await authedPost('api/continuity/switch/draft', kidCookie, {
      reminder_email: 'kid@family.test', interval_days: 30, grace_period_days: 14,
      recipients: [{ member_id: kid.id }]
    });
    assert.equal(kidDraft.status, 403);
    const item = await (await authedPost('api/continuity/switch/draft', parentCookie, {
      reminder_email: 'owner@family.test', interval_days: 30, grace_period_days: 14,
      recipients: [{ member_id: kid.id }], operation_key: 'draft-api-2'
    })).json();
    const ownerKey = await keyFor({ memberId: parent.id, fingerprint: 'only-owner' });
    const badStage = await authedPost(`api/continuity/switch/${item.id}/letter/stage`, parentCookie, {
      recipients: [{ member_id: kid.id }], operation_key: 'stage-api-bad',
      payload_b64: Buffer.from('encrypted').toString('base64'),
      encryption_metadata: { version: 2, mode: 'pki', files: { upload: { holders: [
        { member_id: parent.id, encryption_key_id: ownerKey.id, key_fingerprint: ownerKey.key_fingerprint, role: 'owner', wrapped_dek: wrap('owner') }
      ] } } }
    });
    assert.equal(badStage.status, 400);

    await pool.query(`UPDATE continuity_switches SET status = 'armed', schedule_cycle = 1, next_checkin_due_at = NOW() + INTERVAL '30 days' WHERE id = $1`, [item.id]);
    const noPass = await authedPost(`api/continuity/switch/${item.id}/pause`, parentCookie, {});
    assert.equal(noPass.status, 400);
    const paused = await authedPost(`api/continuity/switch/${item.id}/pause`, parentCookie, { current_passphrase: 'parent-pass' });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).status, 'paused');
  });
});
