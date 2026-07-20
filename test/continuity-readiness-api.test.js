'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  authedGet, authedPost, authedPut, createMember, getPool, loginAs, resetDatabase, startServer, stopServer
} = require('./helpers');
const continuity = require('../lib/continuity');
const readinessDomain = require('../lib/continuity-readiness');
const trustees = require('../lib/trustees');
const brrr = require('../lib/brrr');

let pool;
let parent;
let kid;
let parentCookie;
let switchItem;
let originalBrrrSend;
let lastBrrrPayload;

describe('continuity operator reachability readiness', () => {
  before(async () => {
    originalBrrrSend = brrr.sendBrrrNotification;
    brrr.sendBrrrNotification = async (_target, payload) => {
      lastBrrrPayload = payload;
      return { status: 202 };
    };
    await startServer();
    pool = getPool();
  });

  after(async () => {
    brrr.sendBrrrNotification = originalBrrrSend;
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    lastBrrrPayload = null;
    parent = await createMember('Readiness Parent', 'parent', 'parent-pass');
    kid = await createMember('Readiness Kid', 'kid', 'kid-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
    switchItem = await continuity.saveDraft({
      ownerId: parent.id,
      reminderEmail: 'owner@family.test',
      intervalDays: 30,
      gracePeriodDays: 14,
      recipients: [{ member_id: kid.id }],
      operationKey: 'readiness-draft'
    });
  });

  it('seeds a reusable verified trustee contact when invitation registration proves control', async () => {
    const trustee = await trustees.createTrustee({
      name: 'Readiness Trustee', email: 'TRUSTEE@Family.Test', createdBy: parent.id
    });
    const invitation = await trustees.createTrusteeInvitation({ trusteeId: trustee.id });
    await trustees.registerTrusteeFromInvitation({
      token: invitation.token,
      publicKey: Buffer.from('trustee-public-key').toString('base64'),
      encryptedPrivateKey: 'client-wrapped-private-key'
    });
    const { rows } = await pool.query(
      'SELECT trustee_id, normalized_address, status, verification_source FROM trustee_contact_channels'
    );
    assert.deepEqual(rows, [{
      trustee_id: trustee.id,
      normalized_address: 'trustee@family.test',
      status: 'verified',
      verification_source: 'trustee_registration'
    }]);
  });

  it('stores a write-only brrr target and exposes only masked, versioned readiness state', async () => {
    const target = 'https://api.brrr.now/v1/readiness-secret-123456';
    const saved = await authedPut('api/continuity/notification-channels/brrr', parentCookie, {
      enabled: true, label: 'My phone', secret: target
    });
    assert.equal(saved.status, 200);
    const channel = await saved.json();
    assert.equal(channel.enabled, true);
    assert.equal(channel.has_secret, true);
    assert.match(channel.secret_mask, /3456$/);
    assert.equal(channel.config_version, 1);
    assert.doesNotMatch(JSON.stringify(channel), /readiness-secret/);

    const { rows } = await pool.query('SELECT target_secret, target_fingerprint FROM member_notification_channels');
    assert.equal(rows[0].target_secret, target);
    assert.match(rows[0].target_fingerprint, /^[a-f0-9]{64}$/);
  });

  it('keeps transport acceptance distinct from authenticated reachability acknowledgement', async () => {
    await authedPut('api/continuity/notification-channels/brrr', parentCookie, {
      enabled: true, secret: 'readiness-secret-abcdef'
    });
    const challenged = await authedPost(
      `api/continuity/switch/${switchItem.id}/readiness/brrr/challenge`, parentCookie, {}
    );
    const challengePayload = await challenged.json();
    assert.equal(challenged.status, 201, JSON.stringify(challengePayload));
    assert.equal(challengePayload.challenge.delivered, true);
    assert.equal(challengePayload.challenge.code, undefined);
    assert.ok(lastBrrrPayload);
    assert.equal(lastBrrrPayload.title, 'Home Source');
    assert.doesNotMatch(JSON.stringify(lastBrrrPayload), /Readiness Parent|Readiness Kid|owner@family/i);
    const code = lastBrrrPayload.message.match(/code:\s*([A-Z0-9-]+)/i)?.[1];
    assert.ok(code);

    const beforeAck = await (await authedGet(`api/continuity/switch/${switchItem.id}/readiness`, parentCookie)).json();
    assert.equal(beforeAck.channels.brrr.transport_tested, true);
    assert.equal(beforeAck.channels.brrr.reachability_acknowledged, false);

    const wrong = await authedPost(
      `api/continuity/switch/${switchItem.id}/readiness/brrr/acknowledge`, parentCookie, { code: 'WRONG-CODE' }
    );
    assert.equal(wrong.status, 400);
    const acknowledged = await authedPost(
      `api/continuity/switch/${switchItem.id}/readiness/brrr/acknowledge`, parentCookie, { code }
    );
    assert.equal(acknowledged.status, 200);
    const readiness = await acknowledged.json();
    assert.equal(readiness.channels.brrr.reachability_acknowledged, true);
    assert.equal(readiness.ready_to_arm, false, 'email reachability remains independently required');

    const { rows: attestations } = await pool.query(
      'SELECT challenge_hash, acknowledged_at, attempt_count FROM continuity_operator_channel_attestations'
    );
    assert.match(attestations[0].challenge_hash, /^[a-f0-9]{64}$/);
    assert.ok(attestations[0].acknowledged_at);
    assert.equal(Number(attestations[0].attempt_count), 1);
    assert.doesNotMatch(JSON.stringify(attestations), new RegExp(code));

    await authedPut('api/continuity/notification-channels/brrr', parentCookie, {
      enabled: true, secret: 'replacement-secret-uvwxyz'
    });
    const invalidated = await (await authedGet(`api/continuity/switch/${switchItem.id}/readiness`, parentCookie)).json();
    assert.equal(invalidated.channels.brrr.reachability_acknowledged, false);
  });

  it('binds mandatory email acknowledgement to the switch address and mail configuration', async () => {
    const env = {
      MAIL_TRANSPORT: 'file',
      SMTP_FROM: 'Home Source <home@family.test>',
      APP_URL: 'https://home.family.test'
    };
    const created = await readinessDomain.createReachabilityChallenge({
      ownerId: parent.id, switchId: switchItem.id, channelType: 'email', env
    });
    assert.equal(created.config.target, 'owner@family.test');
    assert.match(created.code, /^[A-F0-9]{10}$/);
    await readinessDomain.recordChallengeTransport({ attestationId: created.attestation.id, accepted: true });
    const acknowledged = await readinessDomain.acknowledgeReachability({
      ownerId: parent.id, switchId: switchItem.id, channelType: 'email', code: created.code, env
    });
    assert.equal(acknowledged.channels.email.transport_tested, true);
    assert.equal(acknowledged.channels.email.reachability_acknowledged, true);
    assert.equal(acknowledged.ready_to_arm, true);

    await pool.query('UPDATE continuity_switches SET reminder_email = $2 WHERE id = $1', [switchItem.id, 'changed@family.test']);
    const changed = await readinessDomain.getReadiness({
      ownerId: parent.id, switchId: switchItem.id, env
    });
    assert.equal(changed.channels.email.reachability_acknowledged, false);
    assert.equal(changed.ready_to_arm, false);
    const { rows } = await pool.query('SELECT challenge_hash FROM continuity_operator_channel_attestations');
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(created.code));
  });

  it('redacts reusable brrr secrets from app backups and restores the exported row disabled', async () => {
    const secret = 'backup-secret-should-never-appear';
    await authedPut('api/continuity/notification-channels/brrr', parentCookie, { enabled: true, secret });
    const backup = await authedPost('api/backup/export', parentCookie, { encrypted: false });
    assert.equal(backup.status, 200);
    const result = await backup.json();
    const archive = path.join(process.env.STORAGE_PATH, 'exports', result.file);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-readiness-backup-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', extracted]);
      const root = fs.readdirSync(extracted).map(name => path.join(extracted, name))
        .find(candidate => fs.statSync(candidate).isDirectory());
      const database = JSON.parse(fs.readFileSync(path.join(root, 'database.json'), 'utf8'));
      assert.equal(database.member_notification_channels[0].target_secret, null);
      assert.equal(database.member_notification_channels[0].enabled, false);
      assert.doesNotMatch(JSON.stringify(database), new RegExp(secret));
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
    }
  });
});
