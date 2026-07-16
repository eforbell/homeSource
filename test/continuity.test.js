'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMember, getPool, resetDatabase, startServer, stopServer } = require('./helpers');
const continuity = require('../lib/continuity');

let pool;
let parent;
let kid;

async function draft(overrides = {}) {
  return continuity.saveDraft({
    ownerId: parent.id,
    reminderEmail: 'owner@family.test',
    intervalDays: 30,
    gracePeriodDays: 14,
    recipients: [{ member_id: kid.id }],
    operationKey: overrides.operationKey || 'draft-1',
    ...overrides
  });
}

describe('continuity switch domain', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Continuity Parent', 'parent', 'parent-pass');
    kid = await createMember('Continuity Kid', 'kid', 'kid-pass');
  });

  it('validates cadence and keeps one resumable draft per owner', async () => {
    const first = await draft();
    const second = await draft({ intervalDays: 90, operationKey: 'draft-2' });
    assert.equal(first.id, second.id);
    assert.equal(second.interval_days, 90);
    assert.equal(second.recipients.length, 1);
    await assert.rejects(draft({ gracePeriodDays: 30 }), /shorter than interval/);
  });

  it('preserves local wall-clock time across daylight-saving changes', () => {
    const beforeSpring = new Date('2026-03-07T15:30:00.000Z'); // 10:30 EST
    assert.equal(
      continuity.addCalendarDays(beforeSpring, 1, 'America/New_York').toISOString(),
      '2026-03-08T14:30:00.000Z'
    );
  });

  it('checks in through one locked transition and makes the token single-use', async () => {
    const item = await draft();
    const now = new Date('2026-01-01T15:00:00Z');
    await pool.query(
      `UPDATE continuity_switches SET status = 'armed', schedule_cycle = 1,
              next_checkin_due_at = $2 WHERE id = $1`, [item.id, new Date('2026-01-31T15:00:00Z')]
    );
    const token = 'single-purpose-token';
    await pool.query(
      `INSERT INTO continuity_checkin_tokens (switch_id, schedule_cycle, token_hash, expires_at)
       VALUES ($1, 1, $2, $3)`,
      [item.id, continuity.tokenHash(token), new Date('2026-01-08T15:00:00Z')]
    );
    const checked = await continuity.checkIn({ switchId: item.id, rawToken: token, now });
    assert.equal(Number(checked.schedule_cycle), 2);
    assert.equal(new Date(checked.next_checkin_due_at).toISOString(), '2026-01-31T15:00:00.000Z');
    await assert.rejects(continuity.checkIn({ switchId: item.id, rawToken: token, now }), /not available/);
  });

  it('replays an app check-in operation without advancing the cycle twice', async () => {
    const item = await draft();
    await pool.query(
      `UPDATE continuity_switches SET status = 'armed', schedule_cycle = 1,
              next_checkin_due_at = '2026-01-31T15:00:00Z' WHERE id = $1`, [item.id]
    );
    const input = {
      switchId: item.id, ownerId: parent.id, operationKey: 'checkin-replay-1',
      now: new Date('2026-01-01T15:00:00Z')
    };
    const first = await continuity.checkIn(input);
    const replay = await continuity.checkIn(input);
    assert.equal(Number(first.schedule_cycle), 2);
    assert.equal(Number(replay.schedule_cycle), 2);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM continuity_events
       WHERE switch_id = $1 AND event_type = 'switch.checked_in'`, [item.id]
    );
    assert.equal(rows[0].count, 1);
  });

  it('pauses, resumes from the resume instant, and cancels terminally', async () => {
    const item = await draft();
    await pool.query(
      `UPDATE continuity_switches SET status = 'armed', schedule_cycle = 1,
              next_checkin_due_at = '2026-02-01T12:00:00Z' WHERE id = $1`, [item.id]
    );
    const paused = await continuity.transitionOwnerAction({ switchId: item.id, ownerId: parent.id, action: 'pause', now: new Date('2026-01-05T12:00:00Z') });
    assert.equal(paused.status, 'paused');
    const resumed = await continuity.transitionOwnerAction({ switchId: item.id, ownerId: parent.id, action: 'resume', now: new Date('2026-01-10T12:00:00Z') });
    assert.equal(resumed.status, 'armed');
    assert.equal(new Date(resumed.next_checkin_due_at).toISOString(), '2026-02-09T12:00:00.000Z');
    const cancelled = await continuity.transitionOwnerAction({ switchId: item.id, ownerId: parent.id, action: 'cancel' });
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(continuity.transitionOwnerAction({ switchId: item.id, ownerId: parent.id, action: 'resume' }), /Cannot resume/);
  });

  it('replays owner actions before validating the resulting state', async () => {
    const item = await draft();
    await pool.query(
      `UPDATE continuity_switches SET status = 'armed', schedule_cycle = 1,
              next_checkin_due_at = '2026-02-01T12:00:00Z' WHERE id = $1`, [item.id]
    );
    const input = {
      switchId: item.id, ownerId: parent.id, action: 'pause',
      operationKey: 'pause-replay-1', now: new Date('2026-01-05T12:00:00Z')
    };
    const first = await continuity.transitionOwnerAction(input);
    const replay = await continuity.transitionOwnerAction(input);
    assert.equal(first.status, 'paused');
    assert.equal(replay.status, 'paused');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM continuity_events
       WHERE switch_id = $1 AND event_type = 'switch.paused'`, [item.id]
    );
    assert.equal(rows[0].count, 1);
  });

  it('coalesces missed milestones and stops at delivery_pending without recipient mail', async () => {
    const item = await draft();
    await pool.query(
      `UPDATE continuity_switches SET status = 'armed', schedule_cycle = 1,
              next_checkin_due_at = '2026-01-10T12:00:00Z' WHERE id = $1`, [item.id]
    );
    const result = await continuity.advanceDueSwitches({ now: new Date('2026-01-25T12:00:00Z') });
    assert.equal(result.claimed, 1);
    assert.equal(result.transitions, 4);
    const { rows: switches } = await pool.query('SELECT status FROM continuity_switches WHERE id = $1', [item.id]);
    assert.equal(switches[0].status, 'delivery_pending');
    const { rows: outbox } = await pool.query('SELECT notification_type, recipient_email FROM continuity_notification_outbox WHERE status = $1', ['pending']);
    assert.deepEqual(outbox, [{ notification_type: 'delivery_pending_owner_notice', recipient_email: 'owner@family.test' }]);
    const repeated = await continuity.advanceDueSwitches({ now: new Date('2026-01-25T12:00:00Z') });
    assert.equal(repeated.transitions, 0);
  });

  it('mints raw check-in tokens only for a claimed dispatch and stores only the hash', async () => {
    const item = await draft();
    await pool.query(
      `UPDATE continuity_switches SET status = 'armed', schedule_cycle = 1,
              next_checkin_due_at = '2026-01-10T12:00:00Z' WHERE id = $1`, [item.id]
    );
    await continuity.advanceDueSwitches({ now: new Date('2026-01-03T12:00:00Z') });
    const messages = [];
    const result = await continuity.dispatchOutbox({
      now: new Date('2026-01-03T12:00:00Z'),
      env: { MAIL_TRANSPORT: 'file', SMTP_FROM: 'Home Source <home@family.test>', APP_URL: 'https://home.family.test' },
      mailer: { sendMail: async (message) => { messages.push(message); return { delivered: true, transport: 'file' }; } }
    });
    assert.equal(result.sent, 1);
    assert.match(messages[0].text, /check-in\.html\?token=/);
    const raw = new URL(messages[0].text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
    const { rows: tokens } = await pool.query('SELECT token_hash FROM continuity_checkin_tokens');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token_hash, continuity.tokenHash(raw));
    assert.doesNotMatch(JSON.stringify(tokens), new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
