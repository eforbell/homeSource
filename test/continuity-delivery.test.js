'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  authedPost, createMember, getPool, loginAs, resetDatabase, startServer, stopServer, url
} = require('./helpers');
const continuity = require('../lib/continuity');

let pool;
let parent;
let kid;
let parentCookie;

async function createEscalatedSwitch({ witnesses = 0 } = {}) {
  const item = await continuity.saveDraft({
    ownerId: parent.id,
    reminderEmail: 'owner@family.test',
    intervalDays: 30,
    gracePeriodDays: 14,
    recipients: [{ member_id: kid.id }],
    operationKey: `c1-draft-${witnesses}`
  });
  const { rows: letters } = await pool.query(
    `INSERT INTO documents
       (title, document_type, source_type, status, is_encrypted, encryption_mode,
        encryption_metadata, created_by)
     VALUES ('The Letter', 'legal', 'authored', 'active', TRUE, 'pki', '{}', $1)
     RETURNING *`, [parent.id]
  );
  const { rows: packets } = await pool.query(
    `INSERT INTO continuity_packet_versions
       (switch_id, version_number, status, letter_document_id, policy_hash,
        operation_key, created_by, activated_at)
     VALUES ($1, 1, 'active', $2, $3, 'c1-active-packet', $4, $5)
     RETURNING *`,
    [item.id, letters[0].id, 'a'.repeat(64), parent.id, new Date('2026-03-01T12:00:00Z')]
  );
  await pool.query(
    `UPDATE continuity_switches
     SET status = 'delivery_pending', schedule_cycle = 1, letter_document_id = $2,
         active_packet_version_id = $3, delivery_pending_at = $4
     WHERE id = $1`,
    [item.id, letters[0].id, packets[0].id, new Date('2026-04-01T12:00:00Z')]
  );
  const trustees = [];
  for (let index = 1; index <= witnesses; index += 1) {
    const { rows } = await pool.query(
      `INSERT INTO vault_trustees
         (name, email, status, created_by, registered_at)
       VALUES ($1, $2, 'registered', $3, $4) RETURNING *`,
      [`Witness ${index}`, `witness${index}@family.test`, parent.id, new Date('2026-02-01T12:00:00Z')]
    );
    const trustee = rows[0];
    const { rows: contacts } = await pool.query(
      `INSERT INTO trustee_contact_channels
         (trustee_id, channel_type, normalized_address, status, verification_source,
          verified_at, created_at, updated_at)
       VALUES ($1, 'email', $2, 'verified', 'trustee_registration', $3, $3, $3)
       RETURNING *`,
      [trustee.id, trustee.email, new Date('2026-02-01T12:00:00Z')]
    );
    await pool.query(
      `INSERT INTO continuity_switch_trustees (switch_id, trustee_id) VALUES ($1, $2)`,
      [item.id, trustee.id]
    );
    trustees.push({ ...trustee, contact: contacts[0] });
  }
  return { switchItem: item, packet: packets[0], trustees };
}

function rawTokenFromMessage(message) {
  const link = message.text.match(/https:\/\/\S+/)?.[0];
  return new URL(link).searchParams.get('token');
}

describe('Phase C1 trustee verification window', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('C1 Parent', 'parent', 'parent-pass');
    kid = await createMember('C1 Kid', 'kid', 'kid-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
  });

  it('starts one shared 72-hour window only after every witness has a successful send', async () => {
    const fixture = await createEscalatedSwitch({ witnesses: 2 });
    const started = await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    assert.equal(started.delivery_runs_created, 1);

    const firstMessages = [];
    const firstDispatch = await continuity.dispatchOutbox({
      now: new Date('2026-04-01T12:05:00Z'),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => {
        firstMessages.push(message);
        return message.to === 'witness2@family.test'
          ? { delivered: false, retryable: false, reason: 'address_rejected' }
          : { delivered: true, transport: 'file' };
      } }
    });
    assert.equal(firstDispatch.sent, 1);
    assert.equal(firstDispatch.failed, 1);
    let { rows: runs } = await pool.query('SELECT * FROM continuity_delivery_runs');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'trustee_notification_blocked');
    assert.equal(runs[0].trustee_action_deadline_at, null);

    const retryCount = await continuity.retryOutboxForOwner({
      ownerId: parent.id, switchId: fixture.switchItem.id, now: new Date('2026-04-01T13:00:00Z')
    });
    assert.equal(retryCount, 1);
    const retryMessages = [];
    const retryDispatch = await continuity.dispatchOutbox({
      now: new Date('2026-04-01T13:00:00Z'),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => {
        retryMessages.push(message);
        return { delivered: true, transport: 'file' };
      } }
    });
    assert.equal(retryDispatch.sent, 1);
    runs = (await pool.query('SELECT * FROM continuity_delivery_runs')).rows;
    assert.equal(runs[0].status, 'trustee_window');
    assert.equal(new Date(runs[0].trustee_window_started_at).toISOString(), '2026-04-01T13:00:00.000Z');
    assert.equal(new Date(runs[0].trustee_action_deadline_at).toISOString(), '2026-04-04T13:00:00.000Z');
    const { rows: snapshots } = await pool.query(
      'SELECT destination_snapshot, first_successful_send_at FROM continuity_delivery_run_trustees ORDER BY trustee_id'
    );
    assert.equal(new Date(snapshots[0].first_successful_send_at).toISOString(), '2026-04-01T12:05:00.000Z');
    assert.equal(new Date(snapshots[1].first_successful_send_at).toISOString(), '2026-04-01T13:00:00.000Z');

    const firstToken = rawTokenFromMessage(firstMessages.find((message) => message.to === 'witness1@family.test'));
    const retriedToken = rawTokenFromMessage(retryMessages[0]);
    const duringWindow = new Date('2026-04-02T12:00:00Z');
    assert.deepEqual(Object.keys(await continuity.getTrusteeAction(firstToken, duringWindow)).sort(), ['action_deadline_at', 'status']);
    assert.deepEqual(Object.keys(await continuity.getTrusteeAction(retriedToken, duringWindow)).sort(), ['action_deadline_at', 'status']);
    const { rows: tokenRows } = await pool.query('SELECT token_hash FROM continuity_trustee_action_tokens');
    assert.equal(tokenRows.some((row) => row.token_hash === continuity.tokenHash(firstToken)), true);
    assert.doesNotMatch(JSON.stringify(tokenRows), new RegExp(firstToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('lets the first witness fix one 30-day pause that replay and concurrency cannot extend', async () => {
    await createEscalatedSwitch({ witnesses: 2 });
    await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    const messages = [];
    await continuity.dispatchOutbox({
      now: new Date('2026-04-01T12:05:00Z'),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => { messages.push(message); return { delivered: true }; } }
    });
    const tokens = messages.map(rawTokenFromMessage);
    const now = new Date('2026-04-02T09:30:00Z');
    const results = await Promise.all(tokens.map((rawToken) => continuity.pauseWithTrusteeToken({ rawToken, now })));
    assert.equal(results.every((result) => result.status === 'paused'), true);
    assert.equal(results.some((result) => result.replayed === false), true);
    assert.equal(results.some((result) => result.replayed === true), true);
    assert.equal(new Date(results[0].pause_deadline_at).toISOString(), '2026-05-02T09:30:00.000Z');
    assert.equal(new Date(results[1].pause_deadline_at).toISOString(), '2026-05-02T09:30:00.000Z');
    const replay = await continuity.pauseWithTrusteeToken({
      rawToken: tokens[1], now: new Date('2026-04-03T09:30:00Z')
    });
    assert.equal(replay.replayed, true);
    assert.equal(new Date(replay.pause_deadline_at).toISOString(), '2026-05-02T09:30:00.000Z');
    const { rows: events } = await pool.query(
      "SELECT * FROM continuity_events WHERE event_type = 'delivery.trustee_paused'"
    );
    assert.equal(events.length, 1);
  });

  it('exposes pause through a sessionless, content-minimal trustee route', async () => {
    await createEscalatedSwitch({ witnesses: 1 });
    const startedAt = new Date();
    await continuity.advanceDueSwitches({ now: startedAt });
    let rawToken;
    await continuity.dispatchOutbox({
      now: new Date(startedAt.getTime() + 60_000),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => {
        rawToken = rawTokenFromMessage(message);
        return { delivered: true };
      } }
    });
    const validate = await fetch(url('api/continuity/trustee-action/validate'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken })
    });
    assert.equal(validate.status, 200);
    assert.equal(validate.headers.get('set-cookie'), null);
    assert.deepEqual(Object.keys(await validate.json()).sort(), ['action_deadline_at', 'status']);
    const pause = await fetch(url('api/continuity/trustee-action/pause'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken })
    });
    assert.equal(pause.status, 200);
    assert.equal(pause.headers.get('set-cookie'), null);
    assert.deepEqual(Object.keys(await pause.json()).sort(), ['pause_deadline_at', 'replayed', 'status']);
  });

  it('releases immediately when no witness is designated and remains idempotent', async () => {
    await createEscalatedSwitch({ witnesses: 0 });
    const first = await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    const second = await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:01:00Z') });
    assert.equal(first.delivery_runs_created, 1);
    assert.equal(second.delivery_runs_created, 0);
    const { rows: runs } = await pool.query('SELECT * FROM continuity_delivery_runs');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'recipient_delivery');
    const { rows: outbox } = await pool.query(
      "SELECT * FROM continuity_notification_outbox WHERE notification_type = 'trustee_verification'"
    );
    assert.equal(outbox.length, 0);
  });

  it('releases at the fixed 72-hour boundary when no witness pauses', async () => {
    await createEscalatedSwitch({ witnesses: 1 });
    await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    await continuity.dispatchOutbox({
      now: new Date('2026-04-01T12:05:00Z'),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async () => ({ delivered: true }) }
    });
    const before = await continuity.advanceDueSwitches({ now: new Date('2026-04-04T12:04:59.999Z') });
    assert.equal(before.delivery_runs_released, 0);
    const atBoundary = await continuity.advanceDueSwitches({ now: new Date('2026-04-04T12:05:00Z') });
    assert.equal(atBoundary.delivery_runs_released, 1);
    const { rows } = await pool.query('SELECT status, released_at FROM continuity_delivery_runs');
    assert.equal(rows[0].status, 'recipient_delivery');
    assert.equal(new Date(rows[0].released_at).toISOString(), '2026-04-04T12:05:00.000Z');
  });

  it('releases at the original 30-day pause boundary without allowing an extension', async () => {
    await createEscalatedSwitch({ witnesses: 1 });
    await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    let rawToken;
    await continuity.dispatchOutbox({
      now: new Date('2026-04-01T12:05:00Z'),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => {
        rawToken = rawTokenFromMessage(message);
        return { delivered: true };
      } }
    });
    await continuity.pauseWithTrusteeToken({ rawToken, now: new Date('2026-04-02T09:30:00Z') });
    const before = await continuity.advanceDueSwitches({ now: new Date('2026-05-02T09:29:59.999Z') });
    assert.equal(before.delivery_runs_released, 0);
    const atBoundary = await continuity.advanceDueSwitches({ now: new Date('2026-05-02T09:30:00Z') });
    assert.equal(atBoundary.delivery_runs_released, 1);
    const replay = await continuity.pauseWithTrusteeToken({
      rawToken, now: new Date('2026-05-02T09:30:01Z')
    });
    assert.equal(replay, null);
  });

  it('requires same-request owner reauthentication and fails closed after the grant boundary', async () => {
    const fixture = await createEscalatedSwitch({ witnesses: 0 });
    await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    const wrong = await authedPost(`api/continuity/switch/${fixture.switchItem.id}/recover`, parentCookie, {
      current_passphrase: 'wrong-passphrase', operation_key: 'owner-recover-wrong'
    });
    assert.equal(wrong.status, 400);
    const recovered = await authedPost(`api/continuity/switch/${fixture.switchItem.id}/recover`, parentCookie, {
      current_passphrase: 'parent-pass', operation_key: 'owner-recover-valid'
    });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).status, 'armed');

    await resetDatabase();
    parent = await createMember('C1 Boundary Parent', 'parent', 'parent-pass');
    kid = await createMember('C1 Boundary Kid', 'kid', 'kid-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
    const boundary = await createEscalatedSwitch({ witnesses: 0 });
    await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    await pool.query(
      `UPDATE continuity_delivery_runs
       SET first_grant_activated_at = $2 WHERE switch_id = $1`,
      [boundary.switchItem.id, new Date('2026-04-01T12:01:00Z')]
    );
    const blocked = await authedPost(`api/continuity/switch/${boundary.switchItem.id}/recover`, parentCookie, {
      current_passphrase: 'parent-pass', operation_key: 'owner-recover-too-late'
    });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /unavailable after recipient delivery activation/);
  });

  it('backs up run history, trustee snapshots, and token hashes without the usable token', async () => {
    await createEscalatedSwitch({ witnesses: 1 });
    await continuity.advanceDueSwitches({ now: new Date('2026-04-01T12:00:00Z') });
    let rawToken;
    await continuity.dispatchOutbox({
      now: new Date('2026-04-01T12:05:00Z'),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => {
        rawToken = rawTokenFromMessage(message);
        return { delivered: true };
      } }
    });
    const response = await authedPost('api/backup/export', parentCookie, { encrypted: false });
    assert.equal(response.status, 200);
    const backup = await response.json();
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-c1-backup-'));
    try {
      execFileSync('tar', ['-xzf', path.join(process.env.STORAGE_PATH, 'exports', backup.file), '-C', extracted]);
      const root = fs.readdirSync(extracted)[0];
      const database = JSON.parse(fs.readFileSync(path.join(extracted, root, 'database.json'), 'utf8'));
      assert.equal(database.continuity_delivery_runs.length, 1);
      assert.equal(database.continuity_delivery_run_trustees.length, 1);
      assert.equal(database.continuity_trustee_action_tokens.length, 1);
      assert.equal(database.continuity_trustee_action_tokens[0].token_hash, continuity.tokenHash(rawToken));
      assert.doesNotMatch(JSON.stringify(database), new RegExp(rawToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
    }
  });
});
