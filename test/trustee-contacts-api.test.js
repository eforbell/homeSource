'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  authedDel, authedGet, authedPost, createMember, getPool, loginAs, resetDatabase, startServer, stopServer, url
} = require('./helpers');
const trustees = require('../lib/trustees');
const trusteeContacts = require('../lib/trustee-contacts');

let pool;
let parent;
let kid;
let otherParent;
let parentCookie;
let kidCookie;
let otherParentCookie;

function publicVerification(path, token) {
  return fetch(url(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
}

async function registeredTrustee(email = 'original@family.test') {
  const trustee = await trustees.createTrustee({
    name: 'Replacement Trustee', email, createdBy: parent.id
  });
  const invitation = await trustees.createTrusteeInvitation({ trusteeId: trustee.id });
  const registered = await trustees.registerTrusteeFromInvitation({
    token: invitation.token,
    publicKey: Buffer.from('replacement-trustee-key').toString('base64'),
    encryptedPrivateKey: 'client-wrapped-private-key'
  });
  return registered.trustee;
}

describe('trustee contact replacement ceremony', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Trustee Contact Parent', 'parent', 'parent-pass');
    otherParent = await createMember('Other Contact Parent', 'parent', 'other-pass');
    kid = await createMember('Trustee Contact Kid', 'kid', 'kid-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
    otherParentCookie = await loginAs(otherParent, 'other-pass');
    kidCookie = await loginAs(kid, 'kid-pass');
  });

  it('keeps the original verified address active until the replacement proves control', async () => {
    const trustee = await registeredTrustee();
    const started = await trusteeContacts.startEmailReplacement({
      ownerId: parent.id, trusteeId: trustee.id, email: 'NEW@Family.Test'
    });
    assert.equal(started.contact.status, 'pending');
    assert.equal(started.contact.normalized_address, 'new@family.test');
    assert.ok(started.token);

    const { rows: before } = await pool.query(
      `SELECT normalized_address, status FROM trustee_contact_channels
       WHERE trustee_id = $1 ORDER BY id`, [trustee.id]
    );
    assert.deepEqual(before, [
      { normalized_address: 'original@family.test', status: 'verified' },
      { normalized_address: 'new@family.test', status: 'pending' }
    ]);
    const { rows: tokenRows } = await pool.query(
      'SELECT token_hash FROM trustee_contact_verification_tokens WHERE contact_channel_id = $1',
      [started.contact.id]
    );
    assert.match(tokenRows[0].token_hash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(tokenRows), new RegExp(started.token));

    const landing = await publicVerification('api/continuity/trustee-contact-verification/validate', started.token);
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get('set-cookie'), null);
    assert.deepEqual(await landing.json(), {
      trustee_name: 'Replacement Trustee',
      target_mask: 'n**@family.test',
      status: 'pending',
      expires_at: started.expires_at.toISOString()
    });

    const confirmed = await publicVerification('api/continuity/trustee-contact-verification/confirm', started.token);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.headers.get('set-cookie'), null);
    assert.equal((await confirmed.json()).status, 'verified');

    const { rows: afterRows } = await pool.query(
      `SELECT normalized_address, status, verification_source FROM trustee_contact_channels
       WHERE trustee_id = $1 ORDER BY id`, [trustee.id]
    );
    assert.deepEqual(afterRows, [
      { normalized_address: 'original@family.test', status: 'revoked', verification_source: 'trustee_registration' },
      { normalized_address: 'new@family.test', status: 'verified', verification_source: 'contact_verification' }
    ]);
    const { rows: trusteeRows } = await pool.query('SELECT email FROM vault_trustees WHERE id = $1', [trustee.id]);
    assert.equal(trusteeRows[0].email, 'new@family.test');
    const { rows: keys } = await pool.query('SELECT revoked_at FROM encryption_keys WHERE trustee_id = $1', [trustee.id]);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].revoked_at, null);

    const replay = await publicVerification('api/continuity/trustee-contact-verification/confirm', started.token);
    assert.equal(replay.status, 404);
  });

  it('replaces pending ceremonies and rejects expired, cross-owner, and kid requests', async () => {
    const trustee = await registeredTrustee();
    const first = await trusteeContacts.startEmailReplacement({
      ownerId: parent.id, trusteeId: trustee.id, email: 'first@family.test'
    });
    const second = await trusteeContacts.startEmailReplacement({
      ownerId: parent.id, trusteeId: trustee.id, email: 'second@family.test'
    });
    assert.notEqual(first.contact.id, second.contact.id);
    assert.equal((await publicVerification('api/continuity/trustee-contact-verification/validate', first.token)).status, 404);

    const expired = await trusteeContacts.startEmailReplacement({
      ownerId: parent.id, trusteeId: trustee.id, email: 'expired@family.test',
      now: new Date('2026-01-01T00:00:00Z')
    });
    assert.equal((await publicVerification('api/continuity/trustee-contact-verification/validate', expired.token)).status, 404);

    const crossOwner = await authedPost(`api/trustees/${trustee.id}/contacts/email`, otherParentCookie, {
      email: 'cross-owner@family.test'
    });
    assert.equal(crossOwner.status, 404);
    const kidRequest = await authedPost(`api/trustees/${trustee.id}/contacts/email`, kidCookie, {
      email: 'kid-request@family.test'
    });
    assert.equal(kidRequest.status, 403);
  });

  it('exposes only safe parent controls for start, resend, listing, and cancellation', async () => {
    const trustee = await registeredTrustee();
    const started = await authedPost(`api/trustees/${trustee.id}/contacts/email`, parentCookie, {
      email: 'api-replacement@family.test'
    });
    assert.equal(started.status, 201);
    const payload = await started.json();
    assert.equal(payload.contact.status, 'pending');
    assert.equal(payload.verification.delivered, false);
    assert.doesNotMatch(JSON.stringify(payload), /token/i);

    const listed = await authedGet('api/trustees', parentCookie);
    const list = await listed.json();
    assert.equal(list[0].verified_contact_address, 'original@family.test');
    assert.equal(list[0].pending_contact_address, 'api-replacement@family.test');

    const resent = await authedPost(
      `api/trustees/${trustee.id}/contacts/${payload.contact.id}/resend`, parentCookie, {}
    );
    assert.equal(resent.status, 200);
    assert.equal((await resent.json()).verification.delivered, false);

    const cancelled = await authedDel(
      `api/trustees/${trustee.id}/contacts/${payload.contact.id}`, parentCookie
    );
    assert.equal(cancelled.status, 200);
    const { rows } = await pool.query(
      `SELECT status FROM trustee_contact_channels
       WHERE trustee_id = $1 AND normalized_address = 'api-replacement@family.test'`, [trustee.id]
    );
    assert.deepEqual(rows, [{ status: 'revoked' }]);
  });

  it('does not let two active trustees claim the same replacement address', async () => {
    const firstTrustee = await registeredTrustee('first-owner@family.test');
    const second = await trustees.createTrustee({
      name: 'Second Trustee', email: 'second-owner@family.test', createdBy: parent.id
    });
    const secondInvitation = await trustees.createTrusteeInvitation({ trusteeId: second.id });
    await trustees.registerTrusteeFromInvitation({
      token: secondInvitation.token,
      publicKey: Buffer.from('second-trustee-key').toString('base64'),
      encryptedPrivateKey: 'second-wrapped-key'
    });

    await assert.rejects(
      trusteeContacts.startEmailReplacement({
        ownerId: parent.id, trusteeId: firstTrustee.id, email: 'second-owner@family.test'
      }),
      /already assigned/i
    );
  });

  it('revokes contact state and invalidates pending proof when the trustee is revoked', async () => {
    const trustee = await registeredTrustee();
    const started = await trusteeContacts.startEmailReplacement({
      ownerId: parent.id, trusteeId: trustee.id, email: 'pending-revoke@family.test'
    });
    await trustees.revokeTrustee(trustee.id);
    assert.equal(await trusteeContacts.getValidEmailReplacement(started.token), null);
    const { rows } = await pool.query(
      'SELECT status FROM trustee_contact_channels WHERE trustee_id = $1 ORDER BY id', [trustee.id]
    );
    assert.deepEqual(rows, [{ status: 'revoked' }, { status: 'revoked' }]);
  });

  it('backs up contact history and token hashes without the usable replacement token', async () => {
    const trustee = await registeredTrustee();
    const started = await trusteeContacts.startEmailReplacement({
      ownerId: parent.id, trusteeId: trustee.id, email: 'backup-replacement@family.test'
    });
    const response = await authedPost('api/backup/export', parentCookie, { encrypted: false });
    assert.equal(response.status, 200);
    const backup = await response.json();
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-trustee-contact-backup-'));
    try {
      execFileSync('tar', ['-xzf', path.join(process.env.STORAGE_PATH, 'exports', backup.file), '-C', extracted]);
      const root = fs.readdirSync(extracted).map((name) => path.join(extracted, name))
        .find((candidate) => fs.statSync(candidate).isDirectory());
      const database = JSON.parse(fs.readFileSync(path.join(root, 'database.json'), 'utf8'));
      assert.equal(database.trustee_contact_channels.length, 2);
      assert.equal(database.trustee_contact_verification_tokens.length, 1);
      assert.match(database.trustee_contact_verification_tokens[0].token_hash, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(database), new RegExp(started.token));
    } finally { fs.rmSync(extracted, { recursive: true, force: true }); }
  });
});
