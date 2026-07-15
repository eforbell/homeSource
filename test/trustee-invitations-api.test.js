'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  authedDel,
  authedGet,
  authedPost,
  createMember,
  getPool,
  loginAs,
  resetDatabase,
  startServer,
  stopServer,
  url
} = require('./helpers');
const trustees = require('../lib/trustees');

let pool;
let parent;
let kid;
let parentCookie;
let kidCookie;
let previousAppUrl;

function publicKey(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

describe('trustee invitation ceremony API', () => {
  before(async () => {
    previousAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'https://home.family.test';
    await startServer();
    pool = getPool();
  });

  after(async () => {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Invitation Parent', 'parent', 'parent-pass');
    kid = await createMember('Invitation Kid', 'kid', 'kid-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
    kidCookie = await loginAs(kid, 'kid-pass');
  });

  it('creates a hashed, seven-day invitation for a parent-created trustee', async () => {
    const response = await authedPost('api/trustees', parentCookie, {
      name: 'Morgan Trustee',
      relationship: 'Attorney',
      email: 'morgan@family.test'
    });

    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.trustee.status, 'invited');
    assert.equal(payload.invitation.delivered, false);
    assert.equal(payload.invitation.token, undefined);

    const { rows: invitations } = await pool.query('SELECT * FROM trustee_invitations WHERE trustee_id = $1', [payload.trustee.id]);
    assert.equal(invitations.length, 1);
    assert.match(invitations[0].token_hash, /^[a-f0-9]{64}$/);
    assert.ok(new Date(invitations[0].expires_at) > new Date(Date.now() + 6 * 24 * 60 * 60 * 1000));

    const { rows: audits } = await pool.query("SELECT * FROM audit_log WHERE action = 'trustee.invited'");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].details.email_delivery.delivered, false);
  });

  it('does not let a household kid create trustees', async () => {
    const response = await authedPost('api/trustees', kidCookie, {
      name: 'Unauthorized Trustee',
      email: 'unauthorized@family.test'
    });
    assert.equal(response.status, 403);
  });

  it('replaces an outstanding invitation without exposing either token', async () => {
    const created = await authedPost('api/trustees', parentCookie, {
      name: 'Resend Trustee', email: 'resend@family.test'
    });
    const { trustee } = await created.json();
    const resent = await authedPost(`api/trustees/${trustee.id}/invitations/resend`, parentCookie, {});
    assert.equal(resent.status, 200);
    assert.equal((await resent.json()).invitation.delivered, false);
    const { rows: invitations } = await pool.query(
      'SELECT id, used_at, token_hash FROM trustee_invitations WHERE trustee_id = $1 ORDER BY id', [trustee.id]
    );
    assert.equal(invitations.length, 2);
    assert.ok(invitations[0].used_at);
    assert.equal(invitations[1].used_at, null);
    assert.notEqual(invitations[0].token_hash, invitations[1].token_hash);
    const { rows: audits } = await pool.query("SELECT action FROM audit_log WHERE action = 'trustee.invitation_resent'");
    assert.equal(audits.length, 1);
  });

  it('registers a trustee key once without issuing an app session', async () => {
    const trustee = await trustees.createTrustee({
      name: 'Morgan Trustee', email: 'morgan@family.test', createdBy: parent.id
    });
    const invitation = await trustees.createTrusteeInvitation({ trusteeId: trustee.id });

    const landing = await fetch(url(`api/trustee-invitations/${invitation.token}`));
    assert.equal(landing.status, 200);
    assert.deepEqual(await landing.json(), {
      trustee: { name: 'Morgan Trustee', relationship: null },
      invited_by: 'Invitation Parent',
      expires_at: invitation.expires_at.toISOString()
    });

    const register = await fetch(url(`api/trustee-invitations/${invitation.token}/register`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_key: publicKey('trustee-public-key'),
        encrypted_private_key: 'client-encrypted-private-key',
        label: 'Morgan continuity key'
      })
    });
    assert.equal(register.status, 201);
    assert.equal(register.headers.get('set-cookie'), null);
    const registered = await register.json();
    assert.equal(registered.trustee.status, 'registered');
    assert.equal(registered.key.key_type, 'trustee');
    assert.equal(registered.key.trustee_id, trustee.id);
    assert.equal(registered.key.member_id, undefined);
    assert.equal(registered.key.encrypted_private_key, undefined);

    const listedKeys = await authedGet(`api/trustees/${trustee.id}/keys`, parentCookie);
    assert.equal(listedKeys.status, 200);
    const keys = await listedKeys.json();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].id, registered.key.id);
    assert.equal(keys[0].public_key, publicKey('trustee-public-key'));
    assert.equal(keys[0].encrypted_private_key, undefined);
    const kidListedKeys = await authedGet(`api/trustees/${trustee.id}/keys`, kidCookie);
    assert.equal(kidListedKeys.status, 403);

    const { rows: storedInvitation } = await pool.query('SELECT used_at FROM trustee_invitations WHERE id = $1', [invitation.id]);
    assert.ok(storedInvitation[0].used_at);
    const repeated = await fetch(url(`api/trustee-invitations/${invitation.token}/register`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKey('repeat'), encrypted_private_key: 'repeat' })
    });
    assert.equal(repeated.status, 404);

    const { rows: audits } = await pool.query("SELECT * FROM audit_log WHERE action = 'trustee.registered'");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_id, null);
  });

  it('starts a sessionless trustee WebAuthn ceremony bound to the invitation', async () => {
    const trustee = await trustees.createTrustee({
      name: 'Hardware Trustee', email: 'hardware@family.test', createdBy: parent.id
    });
    const invitation = await trustees.createTrusteeInvitation({ trusteeId: trustee.id });
    const options = await fetch(url(`api/trustee-invitations/${invitation.token}/webauthn/options`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requested_method: 'security_key' })
    });
    assert.equal(options.status, 200);
    assert.equal(options.headers.get('set-cookie'), null);
    const payload = await options.json();
    assert.ok(payload.options.challenge);
    assert.equal(payload.options.authenticatorSelection.authenticatorAttachment, 'cross-platform');
    const { rows } = await pool.query(
      `SELECT trustee_id, member_id, purpose, challenge FROM webauthn_challenges
       WHERE trustee_id = $1 ORDER BY created_at DESC LIMIT 1`, [trustee.id]
    );
    assert.deepEqual(rows[0], {
      trustee_id: trustee.id, member_id: null,
      purpose: 'trustee_key_registration', challenge: payload.options.challenge
    });
  });

  it('rejects expired and revoked trustee invitations', async () => {
    const expiredTrustee = await trustees.createTrustee({
      name: 'Expired Trustee', email: 'expired@family.test', createdBy: parent.id
    });
    const expiredInvitation = await trustees.createTrusteeInvitation({
      trusteeId: expiredTrustee.id,
      expiresAt: new Date(Date.now() - 1_000)
    });
    const expired = await fetch(url(`api/trustee-invitations/${expiredInvitation.token}`));
    assert.equal(expired.status, 404);

    const activeTrustee = await trustees.createTrustee({
      name: 'Revoked Trustee', email: 'revoked@family.test', createdBy: parent.id
    });
    const activeInvitation = await trustees.createTrusteeInvitation({ trusteeId: activeTrustee.id });
    const revoked = await authedDel(`api/trustees/${activeTrustee.id}`, parentCookie);
    assert.equal(revoked.status, 200);

    const inaccessible = await fetch(url(`api/trustee-invitations/${activeInvitation.token}`));
    assert.equal(inaccessible.status, 404);
    const registration = await fetch(url(`api/trustee-invitations/${activeInvitation.token}/register`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKey('revoked'), encrypted_private_key: 'revoked' })
    });
    assert.equal(registration.status, 404);
  });
});
