'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMember, getPool, resetDatabase, startServer, stopServer } = require('./helpers');
const continuity = require('../lib/continuity');
const readiness = require('../lib/continuity-readiness');

let pool;
let parent;
let kid;

async function armedSwitch() {
  const item = await continuity.saveDraft({
    ownerId: parent.id,
    reminderEmail: 'owner@family.test',
    intervalDays: 30,
    gracePeriodDays: 14,
    recipients: [{ member_id: kid.id }],
    operationKey: 'brrr-outbox-draft'
  });
  await pool.query(
    `UPDATE continuity_switches SET status = 'armed', schedule_cycle = 1,
            next_checkin_due_at = '2026-01-10T12:00:00Z' WHERE id = $1`,
    [item.id]
  );
  return item;
}

describe('continuity brrr reminder outbox', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Brrr Outbox Parent', 'parent', 'parent-pass');
    kid = await createMember('Brrr Outbox Kid', 'kid', 'kid-pass');
  });

  it('delivers an independent low-information brrr reminder when email is blocked', async () => {
    const secret = 'https://api.brrr.now/v1/independent-reminder-secret';
    const item = await armedSwitch();
    await readiness.saveBrrrChannel({ ownerId: parent.id, secret, enabled: true });

    await continuity.advanceDueSwitches({ now: new Date('2026-01-03T12:00:00Z') });
    await continuity.advanceDueSwitches({ now: new Date('2026-01-03T12:00:00Z') });

    const { rows: emailRows } = await pool.query(
      'SELECT * FROM continuity_notification_outbox WHERE switch_id = $1', [item.id]
    );
    const { rows: brrrRows } = await pool.query(
      'SELECT * FROM continuity_brrr_outbox WHERE switch_id = $1', [item.id]
    );
    assert.equal(emailRows.length, 1);
    assert.equal(brrrRows.length, 1);
    assert.equal(Number(brrrRows[0].channel_config_version), 1);
    assert.match(brrrRows[0].target_fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(brrrRows), /independent-reminder-secret/);

    const sends = [];
    const result = await continuity.dispatchOutbox({
      now: new Date('2026-01-03T12:00:00Z'),
      env: { MAIL_TRANSPORT: 'disabled' },
      brrrSender: async (target, payload) => { sends.push({ target, payload }); return { status: 202 }; }
    });

    assert.equal(result.claimed, 1);
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.channels.email.blocked, 1);
    assert.equal(result.channels.brrr.sent, 1);
    assert.deepEqual(sends, [{
      target: secret,
      payload: {
        title: 'Home Source',
        message: 'A private Home Source check-in needs your attention.'
      }
    }]);
    assert.doesNotMatch(JSON.stringify(sends[0].payload), /Brrr Outbox|owner@family|2026|armed|token/i);

    const { rows: states } = await pool.query(
      `SELECT 'email' AS channel, status FROM continuity_notification_outbox WHERE switch_id = $1
       UNION ALL
       SELECT 'brrr' AS channel, status FROM continuity_brrr_outbox WHERE switch_id = $1
       ORDER BY channel`, [item.id]
    );
    assert.deepEqual(states, [
      { channel: 'brrr', status: 'sent' },
      { channel: 'email', status: 'blocked_configuration' }
    ]);
    const { rows: tokens } = await pool.query('SELECT id FROM continuity_checkin_tokens WHERE switch_id = $1', [item.id]);
    assert.equal(tokens.length, 0, 'brrr reminders must not mint or carry check-in tokens');

    const operations = await continuity.getOperationsStatus(pool);
    assert.deepEqual(
      { pending: operations.channels.brrr.pending, failed: operations.channels.brrr.failed, blocked: operations.channels.brrr.blocked },
      { pending: 0, failed: 0, blocked: 0 }
    );
    assert.equal(operations.channels.email.blocked, 1);
  });

  it('supersedes a queued attempt when the write-only target configuration changes', async () => {
    const item = await armedSwitch();
    await readiness.saveBrrrChannel({ ownerId: parent.id, secret: 'queued-secret-123456', enabled: true });
    await continuity.advanceDueSwitches({ now: new Date('2026-01-03T12:00:00Z') });
    await readiness.saveBrrrChannel({ ownerId: parent.id, secret: 'replacement-secret-654321', enabled: true });

    let brrrCalls = 0;
    await continuity.dispatchOutbox({
      now: new Date('2026-01-03T12:00:00Z'),
      env: { MAIL_TRANSPORT: 'disabled' },
      brrrSender: async () => { brrrCalls += 1; }
    });

    assert.equal(brrrCalls, 0);
    const { rows } = await pool.query(
      'SELECT status, last_error_class FROM continuity_brrr_outbox WHERE switch_id = $1', [item.id]
    );
    assert.deepEqual(rows, [{ status: 'superseded', last_error_class: 'channel_configuration_changed' }]);
  });

  it('retries failed email and brrr attempts without coupling their outcomes', async () => {
    const item = await armedSwitch();
    await readiness.saveBrrrChannel({ ownerId: parent.id, secret: 'retry-secret-123456', enabled: true });
    const now = new Date('2026-01-03T12:00:00Z');
    await continuity.advanceDueSwitches({ now });

    await continuity.dispatchOutbox({
      now,
      env: { MAIL_TRANSPORT: 'disabled' },
      brrrSender: async () => { throw new TypeError('invalid local brrr configuration'); }
    });
    const retried = await continuity.retryOutboxForOwner({ ownerId: parent.id, switchId: item.id, now });
    assert.equal(retried, 2);

    let sends = 0;
    const result = await continuity.dispatchOutbox({
      now,
      env: { MAIL_TRANSPORT: 'disabled' },
      brrrSender: async () => { sends += 1; return { status: 202 }; }
    });
    assert.equal(sends, 1);
    assert.equal(result.channels.email.blocked, 1);
    assert.equal(result.channels.brrr.sent, 1);
    const { rows } = await pool.query(
      'SELECT status, attempt_count FROM continuity_brrr_outbox WHERE switch_id = $1', [item.id]
    );
    assert.deepEqual(rows, [{ status: 'sent', attempt_count: 2 }]);
  });
});
