'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  createMember, createTestDocument, getPool, loginAs, resetDatabase, startServer, stopServer, url
} = require('./helpers');
const continuity = require('../lib/continuity');
const continuityDelivery = require('../lib/continuity-delivery');
const continuityRecipient = require('../lib/continuity-recipient');
const { withTransaction } = require('../lib/db');
const { saveFileRecord, storeFile } = require('../lib/files');

let pool;
let parent;
let kidOne;
let kidTwo;

function wrapped(value) {
  return {
    kind: 'pki_x25519', ephemeral_public_key_b64: `ephemeral-${value}`,
    hkdf_salt_b64: `salt-${value}`, wrapped_dek_b64: `wrapped-${value}`
  };
}

async function createKey(member, fingerprint) {
  const { rows } = await pool.query(
    `INSERT INTO encryption_keys
       (key_type, member_id, public_key, encrypted_private_key, algorithm, key_fingerprint, protection_tier)
     VALUES ('member', $1, $2, 'wrapped-private', 'x25519', $3, 'passphrase') RETURNING *`,
    [member.id, Buffer.from(`public-${fingerprint}`).toString('base64'), fingerprint]
  );
  return rows[0];
}

function envelope(ownerKey, recipientKeys) {
  return {
    version: 2, mode: 'pki', files: { upload: {
      cipher: 'aes-256-gcm', iv_b64: 'delivery-iv', tag_length_bits: 128,
      holders: [
        { member_id: parent.id, role: 'owner', encryption_key_id: ownerKey.id,
          key_fingerprint: ownerKey.key_fingerprint, wrapped_dek: wrapped('owner') },
        ...recipientKeys.map(({ member, key }) => ({
          member_id: member.id, role: 'beneficiary', sealed: true,
          sealed_until: 'deadman_trigger', encryption_key_id: key.id,
          key_fingerprint: key.key_fingerprint, wrapped_dek: wrapped(`member-${member.id}`)
        }))
      ]
    } }
  };
}

async function createPacketDocument({ title, ownerKey, recipients, letter = false }) {
  const document = await createTestDocument(parent.id, {
    title, document_type: 'legal', source_type: letter ? 'authored' : 'upload', status: 'active',
    metadata: letter ? { continuity_letter: true } : {}, is_encrypted: true,
    encryption_mode: 'pki', encryption_key_id: ownerKey.id,
    encryption_metadata: envelope(ownerKey, recipients)
  });
  const file = await saveFileRecord(
    document.id,
    await storeFile(Buffer.from(`ciphertext-${title}`), `${title}.enc`, 'application/octet-stream')
  );
  const designations = new Map();
  for (const { member, key } of recipients) {
    const { rows } = await pool.query(
      `INSERT INTO document_designations
         (document_id, member_id, role, sealed, sealed_until, encryption_key_id)
       VALUES ($1, $2, 'beneficiary', TRUE, 'deadman_trigger', $3) RETURNING *`,
      [document.id, member.id, key.id]
    );
    designations.set(member.id, rows[0]);
  }
  return { document, file, designations };
}

async function createReleasedPacket() {
  const ownerKey = await createKey(parent, 'grant-owner-key');
  const keyOne = await createKey(kidOne, 'grant-kid-one-key');
  const keyTwo = await createKey(kidTwo, 'grant-kid-two-key');
  for (const [member, address] of [[kidOne, 'one@family.test'], [kidTwo, 'two@family.test']]) {
    await pool.query(
      `INSERT INTO member_contact_channels
         (member_id, channel_type, normalized_address, status, created_by, verified_at)
       VALUES ($1, 'email', $2, 'verified', $3, $4)`,
      [member.id, address, parent.id, new Date('2026-03-01T12:00:00Z')]
    );
  }
  const letter = await createPacketDocument({
    title: 'Grant Letter', ownerKey,
    recipients: [{ member: kidOne, key: keyOne }, { member: kidTwo, key: keyTwo }], letter: true
  });
  const selected = await createPacketDocument({
    title: 'Grant Selected Item', ownerKey, recipients: [{ member: kidOne, key: keyOne }]
  });
  const item = await continuity.saveDraft({
    ownerId: parent.id, reminderEmail: 'owner@family.test', intervalDays: 30,
    gracePeriodDays: 14, recipients: [{ member_id: kidOne.id }, { member_id: kidTwo.id }],
    operationKey: 'grant-draft'
  });
  const { rows: versions } = await pool.query(
    `INSERT INTO continuity_packet_versions
       (switch_id, version_number, status, letter_document_id, policy_hash,
        operation_key, created_by, activated_at)
     VALUES ($1, 1, 'active', $2, $3, 'grant-active-packet', $4, $5) RETURNING *`,
    [item.id, letter.document.id, 'b'.repeat(64), parent.id, new Date('2026-03-01T12:00:00Z')]
  );
  const version = versions[0];
  const packetDocuments = [];
  for (const [index, entry] of [letter, selected].entries()) {
    const { rows } = await pool.query(
      `INSERT INTO continuity_packet_documents
         (packet_version_id, document_id, item_kind, packet_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [version.id, entry.document.id, index === 0 ? 'letter' : 'selected', index + 1]
    );
    packetDocuments.push(rows[0]);
  }
  const packetRecipients = [];
  for (const [index, member] of [kidOne, kidTwo].entries()) {
    const { rows } = await pool.query(
      `INSERT INTO continuity_packet_recipients
         (packet_version_id, member_id, role, packet_order)
       VALUES ($1, $2, 'beneficiary', $3) RETURNING *`, [version.id, member.id, index + 1]
    );
    packetRecipients.push(rows[0]);
  }
  for (const recipient of packetRecipients) {
    for (const [index, entry] of [letter, selected].entries()) {
      const designation = entry.designations.get(recipient.member_id);
      await pool.query(
        `INSERT INTO continuity_packet_recipient_documents
           (packet_version_id, packet_recipient_id, packet_document_id, coverage_status,
            designation_id, encryption_key_id, key_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [version.id, recipient.id, packetDocuments[index].id,
          designation ? 'covered' : 'not_designated', designation?.id || null,
          designation?.encryption_key_id || null,
          designation ? (recipient.member_id === kidOne.id ? keyOne.key_fingerprint : keyTwo.key_fingerprint) : null]
      );
    }
  }
  await pool.query(
    `UPDATE continuity_switches
     SET status = 'delivery_pending', schedule_cycle = 1, letter_document_id = $2,
         active_packet_version_id = $3, delivery_pending_at = $4
     WHERE id = $1`,
    [item.id, letter.document.id, version.id, new Date('2026-04-01T12:00:00Z')]
  );
  return { item, version, letter, selected, keyOne, keyTwo };
}

describe('Phase C2 recipient grants and manifests', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Grant Parent', 'parent', 'parent-pass');
    kidOne = await createMember('Grant Kid One', 'kid', 'kid-one-pass');
    kidTwo = await createMember('Grant Kid Two', 'kid', 'kid-two-pass');
  });

  it('atomically activates immutable exact-item grants and the owner recovery cutoff', async () => {
    const fixture = await createReleasedPacket();
    const at = new Date('2027-04-01T12:00:00Z');
    const result = await continuity.advanceDueSwitches({ now: at });
    assert.equal(result.grants_created, 2);
    assert.equal(result.active_grants, 2);
    assert.equal(result.blocked_grants, 0);

    const { rows: grants } = await pool.query(
      'SELECT * FROM continuity_delivery_grants ORDER BY packet_recipient_id'
    );
    assert.deepEqual(grants.map((grant) => grant.status), ['active', 'active']);
    assert.equal(new Date(grants[0].expires_at).toISOString(), '2028-04-01T12:00:00.000Z');
    const { rows: items } = await pool.query(
      `SELECT item.id, grant_row.member_id, item.item_ordinal, item.item_kind, item.eligibility_status,
              item.artifact_metadata, item.wrapped_dek, item.file_sha256
       FROM continuity_delivery_items item
       JOIN continuity_delivery_grants grant_row ON grant_row.id = item.delivery_grant_id
       ORDER BY grant_row.member_id, item.item_ordinal`
    );
    assert.deepEqual(items.map((row) => [Number(row.member_id), row.item_ordinal, row.item_kind]), [
      [kidOne.id, 1, 'letter'], [kidOne.id, 2, 'selected'], [kidTwo.id, 1, 'letter']
    ]);
    assert.equal(items.every((row) => row.eligibility_status === 'ready'), true);
    assert.equal(items.every((row) => !Object.hasOwn(row.artifact_metadata, 'holders')), true);
    assert.equal(items.every((row) => row.wrapped_dek.kind === 'pki_x25519'), true);
    assert.equal(items.every((row) => /^[a-f0-9]{64}$/.test(row.file_sha256)), true);

    const { rows: runs } = await pool.query('SELECT * FROM continuity_delivery_runs');
    assert.equal(runs[0].status, 'delivery_active');
    assert.equal(new Date(runs[0].first_grant_activated_at).toISOString(), at.toISOString());
    const { rows: switches } = await pool.query('SELECT status FROM continuity_switches WHERE id = $1', [fixture.item.id]);
    assert.equal(switches[0].status, 'delivery_active');
    const ownerView = await continuity.getSwitchForOwner(parent.id);
    assert.equal(ownerView.delivery_run.active_grant_count, 2);
    assert.equal(ownerView.delivery_run.blocked_grant_count, 0);
    assert.equal(Object.hasOwn(ownerView.delivery_run, 'grants'), false);
    assert.equal((await pool.query('SELECT * FROM continuity_delivery_tokens')).rows.length, 2);
    assert.equal((await pool.query("SELECT * FROM continuity_notification_outbox WHERE notification_type = 'recipient_delivery'")).rows.length, 2);
    await assert.rejects(
      continuity.recoverOwner({ ownerId: parent.id, switchId: fixture.item.id, operationKey: 'too-late' }),
      /after recipient delivery activation/
    );
    await assert.rejects(
      pool.query('UPDATE continuity_delivery_items SET item_ordinal = 9 WHERE id = $1', [items[0].id]),
      /immutable/i
    );
  });

  it('blocks one recipient complete packet while activating and queuing the healthy recipient', async () => {
    const fixture = await createReleasedPacket();
    await pool.query(
      'UPDATE encryption_keys SET revoked_at = $2 WHERE id = $1',
      [fixture.keyTwo.id, new Date('2026-04-01T11:00:00Z')]
    );
    const result = await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    assert.equal(result.active_grants, 1);
    assert.equal(result.blocked_grants, 1);
    const { rows: grants } = await pool.query(
      'SELECT member_id, status, blocked_reason_class FROM continuity_delivery_grants ORDER BY member_id'
    );
    assert.deepEqual(grants, [
      { member_id: kidOne.id, status: 'active', blocked_reason_class: null },
      { member_id: kidTwo.id, status: 'blocked', blocked_reason_class: 'key_unavailable' }
    ]);
    const { rows: blockedItems } = await pool.query(
      `SELECT item.eligibility_status, item.blocked_reason_class
       FROM continuity_delivery_items item
       JOIN continuity_delivery_grants grant_row ON grant_row.id = item.delivery_grant_id
       WHERE grant_row.member_id = $1`, [kidTwo.id]
    );
    assert.deepEqual(blockedItems, [{ eligibility_status: 'blocked', blocked_reason_class: 'key_unavailable' }]);
    const { rows: outbox } = await pool.query(
      "SELECT recipient_email FROM continuity_notification_outbox WHERE notification_type = 'recipient_delivery'"
    );
    assert.deepEqual(outbox, [{ recipient_email: 'one@family.test' }]);
  });

  it('keeps all-blocked delivery recoverable and promotes C3 recipient rows only through the scoped delivery path', async () => {
    const fixture = await createReleasedPacket();
    await pool.query(
      'UPDATE encryption_keys SET revoked_at = $2 WHERE id = ANY($1::int[])',
      [[fixture.keyOne.id, fixture.keyTwo.id], new Date('2026-04-01T11:00:00Z')]
    );
    const first = await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    const second = await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:01:00Z') });
    assert.equal(first.blocked_grants, 2);
    assert.equal(second.grants_created, 0);
    assert.equal((await pool.query('SELECT first_grant_activated_at FROM continuity_delivery_runs')).rows[0].first_grant_activated_at, null);
    const recovered = await continuity.recoverOwner({
      ownerId: parent.id, switchId: fixture.item.id, operationKey: 'all-blocked-recovery',
      now: new Date('2026-04-01T12:02:00Z')
    });
    assert.equal(recovered.status, 'armed');

    await resetDatabase();
    parent = await createMember('Grant Dispatch Parent', 'parent', 'parent-pass');
    kidOne = await createMember('Grant Dispatch Kid One', 'kid', 'kid-one-pass');
    kidTwo = await createMember('Grant Dispatch Kid Two', 'kid', 'kid-two-pass');
    await createReleasedPacket();
    await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    let mailCalls = 0;
    const dispatch = await continuity.dispatchOutbox({
      now: new Date('2026-04-01T12:01:00Z'),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async () => { mailCalls += 1; return { delivered: true }; } }
    });
    assert.equal(mailCalls, 2);
    assert.equal(dispatch.claimed, 2);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM continuity_notification_outbox WHERE notification_type = 'recipient_delivery' AND status = 'sent'")).rows[0].count, 2);
    const operations = await continuity.getOperationsStatus(pool);
    assert.equal(operations.channels.recipient_delivery.deferred, 0);
    assert.equal(operations.outbox.deferred, 0);
  });

  it('exchanges a replaceable recipient link into a one-hour exact-grant session without document semantics', async () => {
    await createReleasedPacket();
    const at = new Date('2026-04-01T12:00:00Z');
    await continuity.advanceDueSwitches({ now: at });
    const sent = [];
    await continuity.dispatchOutbox({
      now: at, env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => { sent.push(message); return { delivered: true }; } }
    });
    const rawToken = sent[0].text.match(/[?&]token=([^\s]+)/)[1];
    const exchanged = await continuityRecipient.exchangeAccessToken(rawToken, { now: at });
    assert.equal(exchanged.items.length, 2);
    assert.deepEqual(exchanged.items, [
      { ordinal: 1, label: 'Private document 1' }, { ordinal: 2, label: 'Private document 2' }
    ]);
    assert.equal(JSON.stringify(exchanged.items).includes('Grant'), false);
    const normalCookie = await loginAs(parent, 'parent-pass');
    const normalSessionOnly = await fetch(url('api/continuity/recipient/manifest'), { headers: { Cookie: normalCookie } });
    assert.equal(normalSessionOnly.status, 404, 'a normal Home Source session is never a recipient session');
    await assert.rejects(() => continuityRecipient.exchangeAccessToken(rawToken, { now: at }), /private delivery/i);

    const item = await continuityRecipient.getRecipientItem(exchanged.bearer, 1, { now: at });
    assert.deepEqual(Object.keys(item).sort(), ['artifact', 'key_material', 'label', 'ordinal']);
    assert.equal(item.label, 'Private document 1');
    assert.equal(Object.hasOwn(item, 'title'), false);
    assert.equal(Object.hasOwn(item.artifact, 'holders'), false);
    await assert.rejects(
      () => continuityRecipient.getRecipientItem(exchanged.bearer, 2, { now: new Date('2026-04-01T13:00:01Z') }),
      /private delivery/i
    );
  });

  it('fails closed when canonical holder evidence changes after a grant is issued', async () => {
    const fixture = await createReleasedPacket();
    const at = new Date('2026-04-01T12:00:00Z');
    await continuity.advanceDueSwitches({ now: at });
    const sent = [];
    await continuity.dispatchOutbox({
      now: at, env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => { sent.push(message); return { delivered: true }; } }
    });
    const rawToken = sent[0].text.match(/[?&]token=([^\s]+)/)[1];
    const exchanged = await continuityRecipient.exchangeAccessToken(rawToken, { now: at });
    await pool.query('UPDATE encryption_keys SET revoked_at = $2 WHERE id = $1', [fixture.keyOne.id, at]);
    await assert.rejects(
      () => continuityRecipient.getRecipientItem(exchanged.bearer, 1, { now: at }),
      /private delivery/i
    );
  });

  it('reissues only to the immutable grant destination and expires all online recipient access at one year', async () => {
    await createReleasedPacket();
    const activatedAt = new Date('2026-04-01T12:00:00Z');
    await continuity.advanceDueSwitches({ now: activatedAt });
    const firstMessages = [];
    await continuity.dispatchOutbox({
      now: activatedAt, env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => { firstMessages.push(message); return { delivered: true }; } }
    });
    const originalToken = firstMessages[0].text.match(/[?&]token=([^\s]+)/)[1];
    const reissueAt = new Date('2026-04-02T12:00:00Z');
    const unknownReissue = await fetch(url('api/continuity/recipient/reissue'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'not-a-delivery-token' })
    });
    assert.equal(unknownReissue.status, 202);
    assert.deepEqual(await unknownReissue.json(), { ok: true });
    const reissue = await fetch(url('api/continuity/recipient/reissue'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: originalToken })
    });
    assert.equal(reissue.status, 202);
    assert.deepEqual(await reissue.json(), { ok: true });
    const { rows: reissueRow } = await pool.query(
      `SELECT status, delivery_token_id, recipient_email, next_attempt_at FROM continuity_notification_outbox
       WHERE notification_type = 'recipient_delivery' ORDER BY id LIMIT 1`
    );
    assert.equal(reissueRow[0].status, 'pending');
    assert.equal(reissueRow[0].delivery_token_id, null);
    assert.equal(reissueRow[0].recipient_email, 'one@family.test');
    const dispatchedAt = new Date(reissueRow[0].next_attempt_at);
    await assert.rejects(() => continuityRecipient.exchangeAccessToken(originalToken, { now: dispatchedAt }), /private delivery/i);
    const replacementMessages = [];
    await continuity.dispatchOutbox({
      now: dispatchedAt, env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => { replacementMessages.push(message); return { delivered: true }; } }
    });
    assert.equal(replacementMessages.length, 1);
    assert.equal(replacementMessages[0].to, 'one@family.test');
    const replacementToken = replacementMessages[0].text.match(/[?&]token=([^\s]+)/)[1];
    const session = await continuityRecipient.exchangeAccessToken(replacementToken, { now: dispatchedAt });

    for (let attempt = 0; attempt < 18; attempt += 1) {
      const throttledUnknown = await fetch(url('api/continuity/recipient/reissue'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: `unknown-${attempt}` })
      });
      assert.equal(throttledUnknown.status, 202);
      assert.deepEqual(await throttledUnknown.json(), { ok: true });
    }
    const throttledKnown = await fetch(url('api/continuity/recipient/reissue'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: originalToken })
    });
    assert.equal(throttledKnown.status, 202);
    assert.deepEqual(await throttledKnown.json(), { ok: true });
    const { rows: rateLimitedOutbox } = await pool.query(
      "SELECT status FROM continuity_notification_outbox WHERE notification_type = 'recipient_delivery' ORDER BY id LIMIT 1"
    );
    assert.equal(rateLimitedOutbox[0].status, 'sent');

    const expiry = await continuity.advanceDueSwitches({ now: new Date('2027-04-01T12:00:00Z') });
    assert.equal(expiry.grants_expired, 2);
    assert.equal(expiry.runs_completed, 1);
    await assert.rejects(() => continuityRecipient.getRecipientManifest(session.bearer, { now: new Date('2027-04-01T12:00:00Z') }), /private delivery/i);
    const { rows: grants } = await pool.query('SELECT status, expired_at FROM continuity_delivery_grants ORDER BY id');
    assert.equal(grants.every((grant) => grant.status === 'expired' && grant.expired_at), true);
    const { rows: sessions } = await pool.query('SELECT revoked_at FROM continuity_delivery_sessions');
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0].revoked_at);
    const { rows: events } = await pool.query("SELECT event_type, details FROM continuity_events WHERE event_type LIKE 'delivery.recipient_%' ORDER BY id");
    assert.equal(events.some((event) => event.event_type === 'delivery.recipient_reissue_queued'), true);
    const ownerCookie = await loginAs(parent, 'parent-pass');
    const switchId = (await pool.query('SELECT id FROM continuity_switches')).rows[0].id;
    const timeline = await fetch(url(`api/continuity/switch/${switchId}/timeline`), { headers: { Cookie: ownerCookie } });
    assert.equal(timeline.status, 200);
    assert.equal((await timeline.json()).some((event) => event.event_type === 'delivery.recipient_reissue_queued'), true);
    assert.equal(events.filter((event) => event.event_type === 'delivery.recipient_grant_expired').length, 2);
    assert.equal(JSON.stringify(events).includes(originalToken), false);
    assert.equal(JSON.stringify(events).includes(replacementToken), false);
  });

  it('hashes each stored artifact once before taking delivery activation locks', async () => {
    await createReleasedPacket();
    const at = new Date('2026-04-01T12:00:00Z');
    await withTransaction((db) => continuityDelivery.initializePendingRuns(db, at));
    const hashedPaths = [];
    const preparedBatch = await continuityDelivery.prepareRecipientGrantArtifacts(pool, {
      hashFile: async (filePath) => {
        hashedPaths.push(filePath);
        const bytes = await fs.promises.readFile(filePath);
        return {
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        };
      }
    });
    const result = await withTransaction((db) =>
      continuityDelivery.activateRecipientGrants(db, at, preparedBatch));
    assert.equal(result.active_grants, 2);
    assert.equal(hashedPaths.length, 2, 'the shared letter must not be re-hashed per recipient');
    assert.equal(new Set(hashedPaths).size, 2);
  });

  it('backs up grant manifests and token hashes without inventing recipient access', async () => {
    await createReleasedPacket();
    const at = new Date('2026-04-01T12:00:00Z');
    await continuity.advanceDueSwitches({ now: at });
    const sent = [];
    await continuity.dispatchOutbox({
      now: at, env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => { sent.push(message); return { delivered: true }; } }
    });
    await continuityRecipient.exchangeAccessToken(sent[0].text.match(/[?&]token=([^\s]+)/)[1], { now: at });
    const { createBackup } = require('../lib/backup');
    const backup = await createBackup({ encrypted: false });
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-c2-backup-'));
    try {
      execFileSync('tar', ['-xzf', path.join(process.env.STORAGE_PATH, 'exports', backup.file), '-C', extracted]);
      const root = fs.readdirSync(extracted)[0];
      const database = JSON.parse(fs.readFileSync(path.join(extracted, root, 'database.json'), 'utf8'));
      assert.equal(database.continuity_delivery_grants.length, 2);
      assert.equal(database.continuity_delivery_items.length, 3);
      assert.equal(database.continuity_delivery_tokens.length, 4);
      assert.equal(database.continuity_delivery_tokens.filter((row) => row.replaced_at === null && row.consumed_at === null).length, 1);
      assert.equal(database.continuity_delivery_tokens.every((row) => /^[a-f0-9]{64}$/.test(row.token_hash)), true);
      assert.equal(database.continuity_delivery_tokens.every((row) => !Object.hasOwn(row, 'token')), true);
      assert.equal(database.continuity_delivery_sessions.length, 1);
      assert.equal(/^[a-f0-9]{64}$/.test(database.continuity_delivery_sessions[0].bearer_hash), true);
      assert.equal(Object.hasOwn(database.continuity_delivery_sessions[0], 'bearer'), false);
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
    }
  });
});
