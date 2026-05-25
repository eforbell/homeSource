'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedPost, authedFetch, getPool, url } = require('./helpers');
const pki = require('../lib/pki');

let pool;
let parent;
let kid;
let parentCookie;
let kidCookie;

describe('WebAuthn key registration API', () => {
  before(async () => {
    await startServer();
    pool = getPool();
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Wendy', 'parent', 'pass123');
    kid = await createMember('Kara', 'kid', 'kidpass');
    parentCookie = await loginAs(parent, 'pass123');
    kidCookie = await loginAs(kid, 'kidpass');
  });

  it('allows a member to begin a security-key registration ceremony', async () => {
    const res = await authedPost(`api/members/${parent.id}/keys/webauthn/options`, parentCookie, {
      requested_method: 'security_key',
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.options.challenge);
    assert.equal(data.options.authenticatorSelection.authenticatorAttachment, 'cross-platform');
    assert.ok(data.options.extensions?.prf?.eval?.first);

    const { rows } = await pool.query(
      `SELECT requested_method, challenge, prf_salt
       FROM webauthn_challenges
       WHERE member_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [parent.id]
    );
    assert.equal(rows[0].requested_method, 'security_key');
    assert.equal(rows[0].challenge, data.options.challenge);
    assert.equal(rows[0].prf_salt, data.options.extensions.prf.eval.first);
  });

  it('allows a member to begin a passkey registration ceremony', async () => {
    const res = await authedPost(`api/members/${parent.id}/keys/webauthn/options`, parentCookie, {
      requested_method: 'passkey',
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.options.authenticatorSelection.authenticatorAttachment, 'platform');
  });

  it('rejects cross-member ceremony starts', async () => {
    const res = await authedPost(`api/members/${parent.id}/keys/webauthn/options`, kidCookie, {
      requested_method: 'security_key',
    });
    assert.equal(res.status, 403);
  });

  it('requires complete payload fields for ceremony completion', async () => {
    await authedPost(`api/members/${parent.id}/keys/webauthn/options`, parentCookie, {
      requested_method: 'security_key',
    });
    const res = await authedPost(`api/members/${parent.id}/keys/webauthn/complete`, parentCookie, {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /registration_response/i);
  });

  it('requires a credential id for assertion options', async () => {
    const res = await authedPost(`api/members/${parent.id}/keys/webauthn/assertion-options`, parentCookie, {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /credential_id/i);
  });

  it('requires assertion payload fields for ceremony finalization', async () => {
    const res = await authedPost(`api/members/${parent.id}/keys/webauthn/finalize`, parentCookie, {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /No pending WebAuthn assertion|assertion_response/i);
  });

  it('lets a member save recovery wrap for a live key', async () => {
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('webauthn-key').toString('base64'),
      encryptedPrivateKey: '{"kind":"webauthn_prf_v1","wrapped_private_key_b64":"abc"}',
      algorithm: 'x25519',
      credentialId: 'credential-1',
      prfEnabled: true,
      protectionTier: 'hardware',
      label: 'Primary',
      credentialVerified: true,
      verificationMethod: 'webauthn',
    });

    const res = await authedPost(`api/members/${parent.id}/keys/${key.id}/recovery`, parentCookie, {
      recovery_wrapped_private_key: '{"kind":"recovery_mnemonic_v1","wrapped_private_key_b64":"xyz"}',
      recovery_type: 'mnemonic_bip39',
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.recovery_enabled, true);
  });

  it('only lets the key owner fetch wrapped key material', async () => {
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('material-key').toString('base64'),
      encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"def"}',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Material Test',
    });

    const ownerRes = await authedFetch(`api/members/${parent.id}/keys/${key.id}/material`, parentCookie);
    assert.equal(ownerRes.status, 200);
    const ownerData = await ownerRes.json();
    assert.match(ownerData.encrypted_private_key, /wrapped_private_key_b64/);

    const otherRes = await authedFetch(`api/members/${parent.id}/keys/${key.id}/material`, kidCookie);
    assert.equal(otherRes.status, 403);
  });

  it('allows kids to open the settings page for self-service key registration', async () => {
    const res = await fetch(url('settings.html'), {
      headers: { Cookie: kidCookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
  });
});
