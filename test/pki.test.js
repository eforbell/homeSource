'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, getPool, resetDatabase, createMember } = require('./helpers');

let pool;
let parent;

describe('PKI key management', () => {
  before(async () => {
    await startServer();
    pool = getPool();
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Alice', 'parent', 'pass123');
  });

  describe('registerMemberKey', () => {
    it('registers a key with correct fields', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: 'pub-key-data',
        encryptedPrivateKey: 'enc-priv-key-data',
        algorithm: 'x25519',
        credentialId: 'cred-123',
        prfEnabled: true,
        keyFingerprint: 'fp-abcd1234',
        protectionTier: 'hardware',
        label: 'YubiKey 5'
      });

      assert.ok(key.id);
      assert.equal(key.key_type, 'member');
      assert.equal(key.member_id, parent.id);
      assert.equal(key.public_key, 'pub-key-data');
      assert.equal(key.algorithm, 'x25519');
      assert.equal(key.credential_id, 'cred-123');
      assert.equal(key.prf_enabled, true);
      assert.equal(key.key_fingerprint, 'fp-abcd1234');
      assert.equal(key.protection_tier, 'hardware');
      assert.equal(key.label, 'YubiKey 5');
      assert.ok(key.created_at);
      assert.equal(key.revoked_at, null);
      assert.equal(key.last_used_at, null);
    });
  });

  describe('listMemberKeys', () => {
    it('returns only non-revoked keys for the member', async () => {
      const pki = require('../lib/pki');
      const kid = await createMember('Bob', 'kid');

      const key1 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: 'pub1',
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        keyFingerprint: 'fp-1',
        protectionTier: 'passphrase',
        label: 'Key 1'
      });

      await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: 'pub2',
        encryptedPrivateKey: 'enc2',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        keyFingerprint: 'fp-2',
        protectionTier: 'passphrase',
        label: 'Key 2'
      });

      // Register a key for a different member
      await pki.registerMemberKey({
        memberId: kid.id,
        publicKey: 'pub3',
        encryptedPrivateKey: 'enc3',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        keyFingerprint: 'fp-3',
        protectionTier: 'passphrase',
        label: 'Kid Key'
      });

      // Revoke key1
      await pki.revokeMemberKey(key1.id, parent.id);

      const keys = await pki.listMemberKeys(parent.id);
      assert.equal(keys.length, 1);
      assert.equal(keys[0].label, 'Key 2');
    });
  });

  describe('getMemberKey', () => {
    it('returns key details including revoked ones', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: 'pub1',
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        keyFingerprint: 'fp-1',
        protectionTier: 'passphrase',
        label: 'Test Key'
      });

      await pki.revokeMemberKey(key.id, parent.id);

      const fetched = await pki.getMemberKey(key.id, parent.id);
      assert.ok(fetched);
      assert.equal(fetched.id, key.id);
      assert.ok(fetched.revoked_at);
      assert.equal(fetched.encrypted_private_key, 'enc1');
    });

    it('returns null for non-existent key', async () => {
      const pki = require('../lib/pki');
      const result = await pki.getMemberKey(99999, parent.id);
      assert.equal(result, null);
    });
  });

  describe('revokeMemberKey', () => {
    it('sets revoked_at and returns the key', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: 'pub1',
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        keyFingerprint: 'fp-1',
        protectionTier: 'passphrase',
        label: 'Revoke Me'
      });

      const revoked = await pki.revokeMemberKey(key.id, parent.id);
      assert.ok(revoked);
      assert.ok(revoked.revoked_at);
      assert.equal(revoked.id, key.id);
    });

    it('returns null on already-revoked key', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: 'pub1',
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        keyFingerprint: 'fp-1',
        protectionTier: 'passphrase',
        label: 'Double Revoke'
      });

      await pki.revokeMemberKey(key.id, parent.id);
      const second = await pki.revokeMemberKey(key.id, parent.id);
      assert.equal(second, null);
    });
  });

  describe('updateKeyLastUsed', () => {
    it('updates the timestamp', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: 'pub1',
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        keyFingerprint: 'fp-1',
        protectionTier: 'passphrase',
        label: 'Use Me'
      });

      assert.equal(key.last_used_at, null);

      await pki.updateKeyLastUsed(key.id);

      const fetched = await pki.getMemberKey(key.id, parent.id);
      assert.ok(fetched.last_used_at);
    });
  });
});
