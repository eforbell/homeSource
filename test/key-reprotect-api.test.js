'use strict';

// Re-protecting a member key with its recovery words (docs/key-move-drill.md). A software authenticator stands
// in for the browser: it registers and asserts real ES256 credentials, and the test does the browser's crypto
// with public/pki-crypto.js, as the settings page does.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { isoBase64URL, isoCBOR } = require('@simplewebauthn/server/helpers');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedPost, getPool, url } = require('./helpers');
const PKICrypto = require('../public/pki-crypto');
const pki = require('../lib/pki');
const keyPossession = require('../lib/key-possession');

const subtle = crypto.webcrypto.subtle;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const origin = () => new URL(url('')).origin;

// An authenticator that keeps its credentials, so it can answer assertions later.
function softwareAuthenticator() {
  const credentials = new Map();
  return {
    register(options) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const coseKey = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const rawId = crypto.randomBytes(16);
      const id = isoBase64URL.fromBuffer(rawId);
      credentials.set(id, { privateKey, counter: 0 });
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: origin(), crossOrigin: false }));
      const authData = Buffer.concat([
        sha256(options.rp.id), Buffer.from([0x45]), Buffer.alloc(4),
        Buffer.alloc(16), Buffer.from([0, rawId.length]), rawId, Buffer.from(coseKey),
      ]);
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id, rawId: id, type: 'public-key',
        response: { clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON), attestationObject: isoBase64URL.fromBuffer(attestationObject), transports: ['usb'] },
        clientExtensionResults: { prf: { enabled: true } },
      };
    },
    assert(options, credentialId = options.allowCredentials[0].id) {
      const credential = credentials.get(credentialId);
      credential.counter += 1;
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(credential.counter);
      const authData = Buffer.concat([sha256(options.rpId), Buffer.from([0x05]), counter]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: origin(), crossOrigin: false }));
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), credential.privateKey);
      return {
        id: credentialId, rawId: credentialId, type: 'public-key',
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
          authenticatorData: isoBase64URL.fromBuffer(authData),
          signature: isoBase64URL.fromBuffer(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}

// A member key as the settings page makes one: a keypair, its wrap under a credential's PRF, and a recovery
// wrap under twelve words. Returns the words and the stored key.
async function memberKeyWithRecovery(memberId, { recovery = true } = {}) {
  const keypair = await PKICrypto.generateMemberKeypair();
  const kek = await PKICrypto.deriveKekFromPrf(crypto.randomBytes(32));
  const key = await pki.registerMemberKey({
    memberId,
    publicKey: PKICrypto.toBase64(keypair.publicKeyRaw),
    encryptedPrivateKey: JSON.stringify({ kind: 'webauthn_prf_v1', prf_salt_b64: 'old-salt', wrapped_private_key_b64: PKICrypto.toBase64(await PKICrypto.wrapPrivateKey(keypair.privateKey, kek)) }),
    algorithm: 'x25519',
    credentialId: `old-credential-${crypto.randomUUID()}`,
    prfEnabled: true,
    protectionTier: 'hardware',
    label: 'Key from the old address',
    credentialVerified: true,
    verificationMethod: 'webauthn',
  });
  if (!recovery) return { key, words: null };
  const { mnemonic } = await PKICrypto.generateRecoveryMnemonic();
  const recoveryKek = await PKICrypto.deriveKekFromMnemonic(mnemonic);
  await pki.saveRecoveryWrap(key.id, memberId, JSON.stringify({
    kind: 'recovery_mnemonic_v1',
    wrapped_private_key_b64: PKICrypto.toBase64(await PKICrypto.wrapPrivateKey(keypair.privateKey, recoveryKek)),
  }));
  return { key, words: mnemonic };
}

// The browser's half: unlock the key with the words (extractable, so it can be wrapped again), and answer the
// possession check with it.
async function unlockWithWords(started, words) {
  const recoveryKek = await PKICrypto.deriveKekFromMnemonic(words);
  const wrapped = JSON.parse(started.recovery_wrapped_private_key);
  const privateKey = await subtle.unwrapKey('pkcs8', PKICrypto.fromBase64(wrapped.wrapped_private_key_b64), recoveryKek, 'AES-KW', { name: 'X25519' }, true, ['deriveBits']);
  const p = started.possession;
  const secret = await PKICrypto.unwrapDekAsOwner(PKICrypto.fromBase64(p.wrapped_dek_b64), PKICrypto.fromBase64(p.ephemeral_public_key_b64), PKICrypto.fromBase64(p.hkdf_salt_b64), privateKey, true);
  return { privateKey, proof: PKICrypto.toBase64(new Uint8Array(await subtle.exportKey('raw', secret))) };
}

describe('Re-protecting a member key with its recovery words', () => {
  let pool;
  let parent;
  let other;
  let parentCookie;
  let otherCookie;
  let authenticator;

  before(async () => {
    await startServer();
    pool = getPool();
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    keyPossession._pending.clear();
    parent = await createMember('Wendy', 'parent', 'pass123');
    other = await createMember('Oscar', 'parent', 'pass456');
    parentCookie = await loginAs(parent, 'pass123');
    otherCookie = await loginAs(other, 'pass456');
    authenticator = softwareAuthenticator();
  });

  const post = (path, body, cookie = parentCookie) => authedPost(path, cookie, body);
  const keyRow = async (id) => (await pool.query('SELECT * FROM encryption_keys WHERE id = $1', [id])).rows[0];

  // Registers a new credential here and asserts with it, as the settings page does. Returns what finish needs
  // but the wrap, and the PRF salt to wrap under.
  async function newCredential(requestedMethod = 'security_key') {
    const started = await (await post(`api/members/${parent.id}/keys/webauthn/options`, { requested_method: requestedMethod })).json();
    const registration = authenticator.register(started.options);
    const completed = await post(`api/members/${parent.id}/keys/webauthn/complete`, { registration_response: registration, client_authenticator_attachment: 'cross-platform', transports: ['usb'] });
    assert.equal(completed.status, 201, JSON.stringify(await completed.clone().json()));
    const asserting = await (await post(`api/members/${parent.id}/keys/webauthn/assertion-options`, { credential_id: registration.id })).json();
    return { credentialId: registration.id, assertion: authenticator.assert(asserting.options), prfSalt: asserting.prf_salt };
  }

  async function prfWrap(privateKey, prfSalt) {
    const prfOutput = crypto.randomBytes(32);
    const kek = await PKICrypto.deriveKekFromPrf(prfOutput);
    const wrapped = await PKICrypto.wrapPrivateKey(privateKey, kek);
    return { prfOutput, wrap: JSON.stringify({ kind: 'webauthn_prf_v1', prf_salt_b64: prfSalt, wrapped_private_key_b64: PKICrypto.toBase64(wrapped) }) };
  }

  async function start(keyId, cookie = parentCookie, memberId = parent.id) {
    return post(`api/members/${memberId}/keys/${keyId}/reprotect/start`, {}, cookie);
  }

  it('moves the same key to a credential registered here, leaving its recovery words working', async () => {
    const { key, words } = await memberKeyWithRecovery(parent.id);
    const before = await keyRow(key.id);

    const startRes = await start(key.id);
    assert.equal(startRes.status, 200);
    assert.equal(startRes.headers.get('cache-control'), 'no-store');
    const started = await startRes.json();
    assert.equal(started.key_fingerprint, key.key_fingerprint);
    const { privateKey, proof } = await unlockWithWords(started, words);
    const fresh = await newCredential();
    const { prfOutput, wrap } = await prfWrap(privateKey, fresh.prfSalt);

    const res = await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, { possession_proof: proof, assertion_response: fresh.assertion, encrypted_private_key: wrap });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.key.id, key.id);
    assert.equal(body.key.credential_id, fresh.credentialId);
    assert.equal(body.key.protection_tier, 'hardware');
    assert.equal(body.key.recovery_enabled, true);
    assert.equal(body.key.encrypted_private_key, undefined);

    const after = await keyRow(key.id);
    assert.equal(after.public_key, before.public_key);
    assert.equal(after.key_fingerprint, before.key_fingerprint);
    assert.equal(after.recovery_wrapped_private_key, before.recovery_wrapped_private_key);
    assert.equal(after.credential_id, fresh.credentialId);
    assert.equal(after.encrypted_private_key, wrap);
    assert.equal(after.credential_verified, true);
    assert.equal(after.verification_method, 'webauthn');
    assert.equal(after.revoked_at, null);

    // The new wrap opens under the new credential's PRF, to the same keypair: a document wrapped to the
    // stored public key opens with it.
    const reopened = await PKICrypto.unwrapPrivateKey(PKICrypto.fromBase64(JSON.parse(after.encrypted_private_key).wrapped_private_key_b64), await PKICrypto.deriveKekFromPrf(prfOutput));
    const dek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const held = await PKICrypto.wrapDekForOwner(dek, await PKICrypto.importMemberPublicKey(PKICrypto.fromBase64(after.public_key)));
    const opened = await PKICrypto.unwrapDekAsOwner(held.wrappedDek, held.ephemeralPublicKey, held.salt, reopened, true);
    assert.deepEqual(new Uint8Array(await subtle.exportKey('raw', opened)), new Uint8Array(await subtle.exportKey('raw', dek)));

    const audited = await pool.query("SELECT details FROM audit_log WHERE action = 'key.reprotected' AND entity_id = $1", [key.id]);
    assert.equal(audited.rows.length, 1);
    assert.equal(audited.rows[0].details.previous_credential_id, before.credential_id);
    assert.equal(audited.rows[0].details.credential_id, fresh.credentialId);
    assert.equal(JSON.stringify(audited.rows[0].details).includes('wrapped'), false);

    // The words still unlock it.
    const again = await (await start(key.id)).json();
    await unlockWithWords(again, words);
  });

  it('reports success once the key is saved, even if recording it fails', async (t) => {
    const audit = require('../lib/audit');
    const realLog = audit.log;
    t.mock.method(audit, 'log', async (action, ...rest) => {
      if (action === 'key.reprotected') throw new Error('audit is down');
      return realLog.call(audit, action, ...rest);
    });
    t.mock.method(console, 'error', () => {});
    const { key, words } = await memberKeyWithRecovery(parent.id);
    const { privateKey, proof } = await unlockWithWords(await (await start(key.id)).json(), words);
    const fresh = await newCredential();
    const res = await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, { possession_proof: proof, assertion_response: fresh.assertion, encrypted_private_key: (await prfWrap(privateKey, fresh.prfSalt)).wrap });
    assert.equal(res.status, 200);
    assert.equal((await keyRow(key.id)).credential_id, fresh.credentialId);
    assert.match(console.error.mock.calls[0].arguments[0], /re-protected, but recording it failed/);
  });

  it('accepts a passkey as the new protection', async () => {
    const { key, words } = await memberKeyWithRecovery(parent.id);
    const { privateKey, proof } = await unlockWithWords(await (await start(key.id)).json(), words);
    const fresh = await newCredential('passkey');
    const res = await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, { possession_proof: proof, assertion_response: fresh.assertion, encrypted_private_key: (await prfWrap(privateKey, fresh.prfSalt)).wrap });
    assert.equal(res.status, 200);
    assert.equal((await keyRow(key.id)).protection_tier, 'platform');
  });

  it('only lets members re-protect their own keys', async () => {
    const { key } = await memberKeyWithRecovery(parent.id);
    assert.equal((await start(key.id, otherCookie, parent.id)).status, 403);
    assert.equal((await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, {}, otherCookie)).status, 403);
    // Naming their own member id doesn't reach someone else's key.
    assert.equal((await start(key.id, otherCookie, other.id)).status, 404);
  });

  it('starts only over HTTPS (or on this machine)', async () => {
    const { key } = await memberKeyWithRecovery(parent.id);
    const res = await fetch(url(`api/members/${parent.id}/keys/${key.id}/reprotect/start`), {
      method: 'POST',
      headers: { Cookie: parentCookie, 'Content-Type': 'application/json', 'X-Forwarded-Host': 'vault.example.test', 'X-Forwarded-Proto': 'http' },
      body: '{}',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /HTTPS/);
    assert.equal(keyPossession._pending.size, 0);
  });

  it('refuses a key without recovery words, and a revoked key', async () => {
    const { key: bare } = await memberKeyWithRecovery(parent.id, { recovery: false });
    const res = await start(bare.id);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'PKI_KEY_NO_RECOVERY');

    const { key: revoked } = await memberKeyWithRecovery(parent.id);
    await pki.revokeMemberKey(revoked.id, parent.id, parent.id);
    assert.equal((await start(revoked.id)).status, 404);
  });

  it('changes nothing when the possession answer is wrong, and spends the check', async () => {
    const { key, words } = await memberKeyWithRecovery(parent.id);
    const before = await keyRow(key.id);
    const { privateKey, proof } = await unlockWithWords(await (await start(key.id)).json(), words);
    const fresh = await newCredential();
    const { wrap } = await prfWrap(privateKey, fresh.prfSalt);

    const wrong = await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, { possession_proof: PKICrypto.toBase64(crypto.randomBytes(32)), assertion_response: fresh.assertion, encrypted_private_key: wrap });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /did not unlock this key/);
    // The right answer no longer counts: the check was spent.
    const retry = await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, { possession_proof: proof, assertion_response: fresh.assertion, encrypted_private_key: wrap });
    assert.equal(retry.status, 400);
    assert.match((await retry.json()).error, /No key check is in progress/);
    assert.deepEqual(await keyRow(key.id), before);
  });

  it('refuses a finish with no check started, or a check made for another key', async () => {
    const { key: first, words } = await memberKeyWithRecovery(parent.id);
    const { key: second } = await memberKeyWithRecovery(parent.id);
    const fresh = await newCredential();
    const none = await post(`api/members/${parent.id}/keys/${first.id}/reprotect/finish`, { possession_proof: PKICrypto.toBase64(crypto.randomBytes(32)), assertion_response: fresh.assertion, encrypted_private_key: '{}' });
    assert.equal(none.status, 400);

    const { privateKey, proof } = await unlockWithWords(await (await start(first.id)).json(), words);
    const { wrap } = await prfWrap(privateKey, fresh.prfSalt);
    const crossed = await post(`api/members/${parent.id}/keys/${second.id}/reprotect/finish`, { possession_proof: proof, assertion_response: fresh.assertion, encrypted_private_key: wrap });
    assert.equal(crossed.status, 400);
    assert.equal((await keyRow(second.id)).credential_id, second.credential_id);
  });

  it('refuses a wrap that is not this credential\'s PRF wrap, and keeps the key as it was', async () => {
    const { key, words } = await memberKeyWithRecovery(parent.id);
    const before = await keyRow(key.id);
    for (const makeWrap of [
      // Another kind of wrap, even one naming this credential's salt.
      async (privateKey, prfSalt) => JSON.stringify({ ...JSON.parse((await prfWrap(privateKey, prfSalt)).wrap), kind: 'passphrase_pbkdf2_v1' }),
      async (privateKey) => (await prfWrap(privateKey, 'some-other-salt')).wrap,
      async () => 'not json',
    ]) {
      const { privateKey, proof } = await unlockWithWords(await (await start(key.id)).json(), words);
      const fresh = await newCredential();
      const res = await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, { possession_proof: proof, assertion_response: fresh.assertion, encrypted_private_key: await makeWrap(privateKey, fresh.prfSalt) });
      assert.equal(res.status, 400);
      assert.deepEqual(await keyRow(key.id), before);
    }
  });

  it('refuses a credential that already protects another active key', async () => {
    const { key: target, words } = await memberKeyWithRecovery(parent.id);
    const fresh = await newCredential();
    const { key: holder } = await memberKeyWithRecovery(parent.id);
    await pool.query('UPDATE encryption_keys SET credential_id = $1 WHERE id = $2', [fresh.credentialId, holder.id]);
    const before = await keyRow(target.id);
    const { privateKey, proof } = await unlockWithWords(await (await start(target.id)).json(), words);
    const res = await post(`api/members/${parent.id}/keys/${target.id}/reprotect/finish`, { possession_proof: proof, assertion_response: fresh.assertion, encrypted_private_key: (await prfWrap(privateKey, fresh.prfSalt)).wrap });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /already protects another key/);
    assert.deepEqual(await keyRow(target.id), before);
  });

  it('refuses an assertion that was already used', async () => {
    const { key, words } = await memberKeyWithRecovery(parent.id);
    const fresh = await newCredential();
    let unlocked = await unlockWithWords(await (await start(key.id)).json(), words);
    const { wrap } = await prfWrap(unlocked.privateKey, fresh.prfSalt);
    const first = await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, { possession_proof: unlocked.proof, assertion_response: fresh.assertion, encrypted_private_key: wrap });
    assert.equal(first.status, 200);
    const afterFirst = await keyRow(key.id);
    unlocked = await unlockWithWords(await (await start(key.id)).json(), words);
    const replay = await post(`api/members/${parent.id}/keys/${key.id}/reprotect/finish`, { possession_proof: unlocked.proof, assertion_response: fresh.assertion, encrypted_private_key: wrap });
    assert.equal(replay.status, 400);
    assert.deepEqual(await keyRow(key.id), afterFirst);
  });

  it('expires a possession check after ten minutes', async () => {
    const { key } = await memberKeyWithRecovery(parent.id);
    await keyPossession.issue(parent.id, key.id, key.public_key, { now: 0 });
    assert.throws(() => keyPossession.consume(parent.id, key.id, PKICrypto.toBase64(crypto.randomBytes(32)), { now: 10 * 60 * 1000 }), /No key check is in progress/);
  });
});
