'use strict';

const crypto = require('node:crypto');
const { pool, withTransaction } = require('./db');
const { getMailerConfig } = require('./mailer');

const TRUSTEE_ACTION_WINDOW_MS = 72 * 60 * 60 * 1000;
const TRUSTEE_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function asDate(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('date must be valid');
  return date;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeErrorClass(value) {
  const normalized = String(value || 'delivery_failed').toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_').slice(0, 80);
  return normalized || 'delivery_failed';
}

async function recordEvent(db, { switchId, type, cycle, details = {}, dedupeKey, occurredAt }) {
  const { rows } = await db.query(
    `INSERT INTO continuity_events
       (switch_id, event_type, schedule_cycle, details, dedupe_key, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
     RETURNING *`,
    [switchId, type, cycle, JSON.stringify(details), dedupeKey, occurredAt]
  );
  return rows[0];
}

async function initializePendingRuns(db, now = new Date()) {
  const at = asDate(now);
  const { rows: switches } = await db.query(
    `SELECT cs.*
     FROM continuity_switches cs
     WHERE cs.status = 'delivery_pending'
     ORDER BY cs.id
     FOR UPDATE OF cs SKIP LOCKED`
  );
  let created = 0;
  let transitioned = 0;
  for (const item of switches) {
    if (!item.active_packet_version_id) {
      await db.query(
        `UPDATE continuity_switches SET status = 'delivery_blocked', updated_at = $2
         WHERE id = $1`, [item.id, at]
      );
      transitioned += 1;
      continue;
    }
    const packet = await db.query(
      `SELECT id FROM continuity_packet_versions
       WHERE id = $1 AND switch_id = $2 AND status = 'active'`,
      [item.active_packet_version_id, item.id]
    );
    if (!packet.rows[0]) {
      await db.query(
        `UPDATE continuity_switches SET status = 'delivery_blocked', updated_at = $2
         WHERE id = $1`, [item.id, at]
      );
      transitioned += 1;
      continue;
    }
    const { rows: witnesses } = await db.query(
      `SELECT designation.trustee_id, trustee.status AS trustee_status,
              contact.id AS contact_channel_id, contact.normalized_address
       FROM continuity_switch_trustees designation
       JOIN vault_trustees trustee ON trustee.id = designation.trustee_id
       LEFT JOIN trustee_contact_channels contact
         ON contact.trustee_id = trustee.id AND contact.channel_type = 'email'
        AND contact.status = 'verified'
       WHERE designation.switch_id = $1
       ORDER BY designation.trustee_id`, [item.id]
    );
    const invalidWitness = witnesses.some((witness) =>
      witness.trustee_status !== 'registered' || !witness.contact_channel_id || !witness.normalized_address);
    const initialStatus = invalidWitness
      ? 'delivery_blocked'
      : witnesses.length ? 'trustee_notification_pending' : 'recipient_delivery';
    const { rows: inserted } = await db.query(
      `INSERT INTO continuity_delivery_runs
         (switch_id, schedule_cycle, packet_version_id, status, released_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4::text = 'recipient_delivery' THEN $5::timestamptz END, $5, $5)
       ON CONFLICT (switch_id, schedule_cycle) DO NOTHING
       RETURNING *`,
      [item.id, item.schedule_cycle, item.active_packet_version_id, initialStatus, at]
    );
    const run = inserted[0];
    if (!run) continue;
    created += 1;
    for (const witness of witnesses.filter((candidate) => candidate.contact_channel_id)) {
      const { rows: snapshots } = await db.query(
        `INSERT INTO continuity_delivery_run_trustees
           (delivery_run_id, trustee_id, contact_channel_id, destination_snapshot, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [run.id, witness.trustee_id, witness.contact_channel_id, witness.normalized_address, at]
      );
      if (initialStatus !== 'trustee_notification_pending') continue;
      const snapshot = snapshots[0];
      const messageId = `<continuity-trustee-${run.id}-${snapshot.id}-0@homesource.local>`;
      await db.query(
        `INSERT INTO continuity_notification_outbox
           (switch_id, schedule_cycle, notification_type, recipient_email, message_id,
            delivery_run_id, delivery_run_trustee_id, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, 'trustee_verification', $3, $4, $5, $6, $7, $7, $7)
         ON CONFLICT (delivery_run_id, delivery_run_trustee_id, notification_type)
           WHERE delivery_run_id IS NOT NULL
         DO NOTHING`,
        [item.id, item.schedule_cycle, snapshot.destination_snapshot, messageId,
          run.id, snapshot.id, at]
      );
    }
    await db.query(
      `UPDATE continuity_switches SET status = $2, updated_at = $3 WHERE id = $1`,
      [item.id, initialStatus, at]
    );
    await recordEvent(db, {
      switchId: item.id,
      type: initialStatus === 'recipient_delivery' ? 'delivery.released_without_trustees'
        : initialStatus === 'delivery_blocked' ? 'delivery.preflight_blocked' : 'delivery.trustees_queued',
      cycle: item.schedule_cycle,
      details: { delivery_run_id: run.id, packet_version_id: Number(run.packet_version_id), trustee_count: witnesses.length },
      dedupeKey: `switch:${item.id}:cycle:${item.schedule_cycle}:delivery-run`, occurredAt: at
    });
    transitioned += 1;
  }
  return { created, transitioned };
}

async function advanceRunDeadlines(db, now = new Date()) {
  const at = asDate(now);
  const { rows: runs } = await db.query(
    `SELECT run.* FROM continuity_delivery_runs run
     WHERE (run.status = 'trustee_window' AND run.trustee_action_deadline_at <= $1)
        OR (run.status = 'trustee_paused' AND run.pause_deadline_at <= $1)
     ORDER BY run.id FOR UPDATE OF run SKIP LOCKED`, [at]
  );
  for (const run of runs) {
    await db.query(
      `UPDATE continuity_delivery_runs
       SET status = 'recipient_delivery', released_at = $2, updated_at = $2 WHERE id = $1`,
      [run.id, at]
    );
    await db.query(
      `UPDATE continuity_switches SET status = 'recipient_delivery', updated_at = $2
       WHERE id = $1`, [run.switch_id, at]
    );
    await db.query(
      `UPDATE continuity_trustee_action_tokens
       SET replaced_at = COALESCE(replaced_at, $2)
       WHERE delivery_run_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
      [run.id, at]
    );
    await recordEvent(db, {
      switchId: run.switch_id, type: 'delivery.trustee_window_resolved', cycle: run.schedule_cycle,
      details: { delivery_run_id: run.id, resolution: run.status === 'trustee_paused' ? 'pause_expired' : 'window_expired' },
      dedupeKey: `delivery-run:${run.id}:recipient-delivery`, occurredAt: at
    });
  }
  return runs.length;
}

function trusteeActionUrl(token, env = process.env) {
  const raw = String(env.APP_URL || '').trim();
  if (!raw) throw new Error('APP_URL is not configured');
  const url = new URL('trustee-action.html', raw.endsWith('/') ? raw : `${raw}/`);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('APP_URL must use HTTPS except on localhost');
  }
  url.searchParams.set('token', token);
  return url.toString();
}

function trusteeNotificationMessage(item, token, messageId, env = process.env) {
  return {
    to: item.recipient_email,
    messageId,
    subject: 'A Home Source continuity check needs your attention',
    text: `You are a designated continuity witness. You may use this private link to place one 30-day pause after the shared witness window begins:\n\n${trusteeActionUrl(token, env)}\n\nThis link grants pause authority only. It does not grant access to any letter, document, file, envelope, key, recipient list, or Home Source account.`
  };
}

async function blockRunForNotification(db, runId, switchId, now, errorClass) {
  await db.query(
    `UPDATE continuity_delivery_runs
     SET status = 'trustee_notification_blocked', updated_at = $2
     WHERE id = $1 AND status IN ('trustee_notification_pending', 'trustee_notification_blocked')`,
    [runId, now]
  );
  await db.query(
    `UPDATE continuity_switches SET status = 'trustee_notification_blocked', updated_at = $2
     WHERE id = $1 AND status IN ('trustee_notification_pending', 'trustee_notification_blocked')`,
    [switchId, now]
  );
  await recordEvent(db, {
    switchId, type: 'delivery.trustee_notification_blocked',
    cycle: (await db.query('SELECT schedule_cycle FROM continuity_delivery_runs WHERE id = $1', [runId])).rows[0].schedule_cycle,
    details: { delivery_run_id: runId, error_class: safeErrorClass(errorClass) },
    dedupeKey: `delivery-run:${runId}:trustee-notification-blocked`, occurredAt: now
  });
}

async function claimTrusteeOutboxAttempt({ now = new Date(), workerId, env = process.env }) {
  const at = asDate(now);
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT outbox.*, run.status AS run_status, switch.status AS switch_status
       FROM continuity_notification_outbox outbox
       JOIN continuity_delivery_runs run ON run.id = outbox.delivery_run_id
       JOIN continuity_switches switch ON switch.id = outbox.switch_id
       WHERE outbox.notification_type = 'trustee_verification'
         AND ((outbox.status = 'pending' AND outbox.next_attempt_at <= $1)
           OR (outbox.status = 'claimed' AND outbox.claim_expires_at <= $1))
       ORDER BY outbox.next_attempt_at, outbox.id
       LIMIT 1 FOR UPDATE OF outbox, run SKIP LOCKED`, [at]
    );
    const item = rows[0];
    if (!item) return null;
    if (!['trustee_notification_pending', 'trustee_notification_blocked'].includes(item.run_status)
        || !['trustee_notification_pending', 'trustee_notification_blocked'].includes(item.switch_status)) {
      await db.query(
        `UPDATE continuity_notification_outbox
         SET status = 'superseded', superseded_at = $2, claimed_by = NULL,
             claim_expires_at = NULL, last_error_class = 'delivery_run_state_changed', updated_at = $2
         WHERE id = $1`, [item.id, at]
      );
      return { blocked: true, status: 'superseded' };
    }
    const config = getMailerConfig(env);
    if (config.transport === 'disabled') {
      await db.query(
        `UPDATE continuity_notification_outbox SET status = 'blocked_configuration', blocked_at = $2,
                claimed_by = NULL, claim_expires_at = NULL,
                last_error_class = 'mail_transport_disabled', updated_at = $2 WHERE id = $1`,
        [item.id, at]
      );
      await blockRunForNotification(db, item.delivery_run_id, item.switch_id, at, 'mail_transport_disabled');
      return { blocked: true, status: 'blocked_configuration' };
    }
    await db.query(
      `UPDATE continuity_trustee_action_tokens
       SET replaced_at = COALESCE(replaced_at, $2)
       WHERE delivery_run_trustee_id = $1 AND purpose = 'pause'
         AND consumed_at IS NULL AND replaced_at IS NULL`,
      [item.delivery_run_trustee_id, at]
    );
    const token = crypto.randomBytes(32).toString('base64url');
    const { rows: tokens } = await db.query(
      `INSERT INTO continuity_trustee_action_tokens
         (delivery_run_id, delivery_run_trustee_id, purpose, token_hash, expires_at, created_at)
       VALUES ($1, $2, 'pause', $3, $4, $5) RETURNING *`,
      [item.delivery_run_id, item.delivery_run_trustee_id, tokenHash(token),
        new Date(at.getTime() + TOKEN_STAGING_TTL_MS), at]
    );
    const attempt = Number(item.attempt_count) + 1;
    const messageId = `<continuity-trustee-${item.delivery_run_id}-${item.delivery_run_trustee_id}-${attempt}@homesource.local>`;
    const { rows: updated } = await db.query(
      `UPDATE continuity_notification_outbox
       SET status = 'claimed', attempt_count = $2, message_id = $3, trustee_action_token_id = $4,
           claimed_by = $5, claim_expires_at = $6, updated_at = $7
       WHERE id = $1 RETURNING *`,
      [item.id, attempt, messageId, tokens[0].id, workerId,
        new Date(at.getTime() + 15 * 60_000), at]
    );
    return { item: updated[0], token, messageId };
  });
}

async function completeTrusteeOutboxAttempt({ item, workerId, now = new Date(), result, maxAttempts, retryDelaysMs }) {
  const at = asDate(now);
  return withTransaction(async (db) => {
    const { rows: lockedRows } = await db.query(
      `SELECT outbox.*, run.status AS run_status
       FROM continuity_notification_outbox outbox
       JOIN continuity_delivery_runs run ON run.id = outbox.delivery_run_id
       WHERE outbox.id = $1 FOR UPDATE OF outbox, run`, [item.id]
    );
    const locked = lockedRows[0];
    if (!locked || locked.status !== 'claimed' || locked.claimed_by !== workerId) return { ignored: true };
    if (result.delivered) {
      await db.query(
        `UPDATE continuity_notification_outbox SET status = 'sent', sent_at = $2,
                claimed_by = NULL, claim_expires_at = NULL, last_error_class = NULL, updated_at = $2
         WHERE id = $1`, [locked.id, at]
      );
      await db.query(
        `UPDATE continuity_delivery_run_trustees
         SET first_successful_send_at = COALESCE(first_successful_send_at, $2)
         WHERE id = $1`, [locked.delivery_run_trustee_id, at]
      );
      const { rows: completion } = await db.query(
        `SELECT COUNT(*) FILTER (WHERE first_successful_send_at IS NULL)::int AS incomplete,
                MAX(first_successful_send_at) AS final_success_at
         FROM continuity_delivery_run_trustees WHERE delivery_run_id = $1`,
        [locked.delivery_run_id]
      );
      if (completion[0].incomplete === 0
          && ['trustee_notification_pending', 'trustee_notification_blocked'].includes(locked.run_status)) {
        const startedAt = asDate(completion[0].final_success_at);
        const deadline = new Date(startedAt.getTime() + TRUSTEE_ACTION_WINDOW_MS);
        await db.query(
          `UPDATE continuity_delivery_runs
           SET status = 'trustee_window', trustee_window_started_at = $2,
               trustee_action_deadline_at = $3, updated_at = $2 WHERE id = $1`,
          [locked.delivery_run_id, startedAt, deadline]
        );
        await db.query(
          `UPDATE continuity_switches SET status = 'trustee_window', updated_at = $2
           WHERE id = $1`, [locked.switch_id, startedAt]
        );
        await db.query(
          `UPDATE continuity_trustee_action_tokens SET expires_at = $2
           WHERE delivery_run_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
          [locked.delivery_run_id, deadline]
        );
        await recordEvent(db, {
          switchId: locked.switch_id, type: 'delivery.trustee_window_started', cycle: locked.schedule_cycle,
          details: { delivery_run_id: Number(locked.delivery_run_id), action_deadline_at: deadline },
          dedupeKey: `delivery-run:${locked.delivery_run_id}:trustee-window`, occurredAt: startedAt
        });
        return { sent: true, windowStarted: true, deadline };
      }
      return { sent: true, windowStarted: false };
    }
    const permanent = result.retryable === false || Number(locked.attempt_count) >= maxAttempts;
    const delay = retryDelaysMs[Math.min(Number(locked.attempt_count) - 1, retryDelaysMs.length - 1)];
    const errorClass = safeErrorClass(result.error_class || result.reason);
    await db.query(
      `UPDATE continuity_notification_outbox
       SET status = $2, failed_at = CASE WHEN $2::text = 'failed' THEN $3::timestamptz END,
           next_attempt_at = $4, claimed_by = NULL, claim_expires_at = NULL,
           last_error_class = $5, updated_at = $3 WHERE id = $1`,
      [locked.id, permanent ? 'failed' : 'pending', at, new Date(at.getTime() + delay), errorClass]
    );
    if (permanent) await blockRunForNotification(db, locked.delivery_run_id, locked.switch_id, at, errorClass);
    return { sent: false, permanent };
  });
}

async function getTrusteeAction(rawToken, now = new Date(), db = pool) {
  if (!rawToken) return null;
  const at = asDate(now);
  const { rows } = await db.query(
    `SELECT token.id AS token_id, token.expires_at, token.consumed_at, token.replaced_at,
            run.id AS delivery_run_id, run.status, run.trustee_action_deadline_at,
            run.pause_deadline_at
     FROM continuity_trustee_action_tokens token
     JOIN continuity_delivery_runs run ON run.id = token.delivery_run_id
     WHERE token.token_hash = $1 AND token.purpose = 'pause'`, [tokenHash(rawToken)]
  );
  const match = rows[0];
  if (!match) return null;
  if (match.status === 'trustee_paused' && match.pause_deadline_at) {
    return { status: 'paused', pause_deadline_at: match.pause_deadline_at };
  }
  if (match.status !== 'trustee_window' || match.consumed_at || match.replaced_at
      || asDate(match.expires_at) <= at || asDate(match.trustee_action_deadline_at) <= at) return null;
  return { status: 'available', action_deadline_at: match.trustee_action_deadline_at };
}

async function pauseWithTrusteeToken({ rawToken, now = new Date() }) {
  const at = asDate(now);
  if (!rawToken) return null;
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT token.id AS token_id, token.expires_at, token.consumed_at, token.replaced_at,
              run.*, snapshot.trustee_id
       FROM continuity_trustee_action_tokens token
       JOIN continuity_delivery_runs run ON run.id = token.delivery_run_id
       JOIN continuity_delivery_run_trustees snapshot ON snapshot.id = token.delivery_run_trustee_id
       WHERE token.token_hash = $1 AND token.purpose = 'pause'
       FOR UPDATE OF token, run`, [tokenHash(rawToken)]
    );
    const match = rows[0];
    if (!match) return null;
    if (match.status === 'trustee_paused' && match.pause_deadline_at) {
      return { status: 'paused', pause_deadline_at: match.pause_deadline_at, replayed: true };
    }
    if (match.status !== 'trustee_window' || match.consumed_at || match.replaced_at
        || asDate(match.expires_at) <= at || asDate(match.trustee_action_deadline_at) <= at) return null;
    const deadline = new Date(at.getTime() + TRUSTEE_PAUSE_MS);
    await db.query('UPDATE continuity_trustee_action_tokens SET consumed_at = $2 WHERE id = $1', [match.token_id, at]);
    await db.query(
      `UPDATE continuity_trustee_action_tokens
       SET replaced_at = COALESCE(replaced_at, $2)
       WHERE delivery_run_id = $1 AND id <> $3 AND consumed_at IS NULL AND replaced_at IS NULL`,
      [match.id, at, match.token_id]
    );
    await db.query(
      `UPDATE continuity_delivery_runs
       SET status = 'trustee_paused', paused_at = $2, pause_deadline_at = $3, updated_at = $2
       WHERE id = $1`, [match.id, at, deadline]
    );
    await db.query(
      `UPDATE continuity_switches SET status = 'trustee_paused', updated_at = $2
       WHERE id = $1`, [match.switch_id, at]
    );
    await recordEvent(db, {
      switchId: match.switch_id, type: 'delivery.trustee_paused', cycle: match.schedule_cycle,
      details: { delivery_run_id: match.id, trustee_id: match.trustee_id, pause_deadline_at: deadline },
      dedupeKey: `delivery-run:${match.id}:trustee-pause`, occurredAt: at
    });
    return { status: 'paused', pause_deadline_at: deadline, replayed: false };
  });
}

async function recoverOwner({ ownerId, switchId, now = new Date(), operationKey, computeNextDue = null }) {
  const at = asDate(now);
  const op = String(operationKey || crypto.randomUUID()).slice(0, 120);
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM continuity_switches WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [Number(switchId), Number(ownerId)]
    );
    const item = rows[0];
    if (!item) throw new Error('Continuity switch not found');
    const dedupeKey = `switch:${item.id}:recover:${op}`;
    const replay = await db.query('SELECT id FROM continuity_events WHERE dedupe_key = $1', [dedupeKey]);
    if (replay.rows[0]) return item;
    const allowed = ['delivery_pending', 'trustee_notification_pending', 'trustee_notification_blocked',
      'trustee_window', 'trustee_paused', 'recipient_delivery'];
    if (!allowed.includes(item.status)) throw new Error(`Cannot recover a switch in ${item.status} state`);
    const { rows: runs } = await db.query(
      `SELECT * FROM continuity_delivery_runs
       WHERE switch_id = $1 AND schedule_cycle = $2 FOR UPDATE`, [item.id, item.schedule_cycle]
    );
    const run = runs[0];
    if (run?.first_grant_activated_at || item.status === 'delivery_active') {
      throw new Error('Owner recovery is unavailable after recipient delivery activation');
    }
    if (run) {
      await db.query(
        `UPDATE continuity_delivery_runs
         SET status = 'owner_recovered', recovered_at = $2, updated_at = $2 WHERE id = $1`,
        [run.id, at]
      );
      await db.query(
        `UPDATE continuity_trustee_action_tokens
         SET replaced_at = COALESCE(replaced_at, $2)
         WHERE delivery_run_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
        [run.id, at]
      );
    }
    await db.query(
      `UPDATE continuity_notification_outbox
       SET status = 'superseded', superseded_at = $2, claimed_by = NULL,
           claim_expires_at = NULL, updated_at = $2
       WHERE switch_id = $1 AND status IN ('pending', 'claimed', 'blocked_configuration', 'failed')`,
      [item.id, at]
    );
    await db.query(
      `UPDATE continuity_brrr_outbox
       SET status = 'superseded', superseded_at = $2, claimed_by = NULL,
           claim_expires_at = NULL, updated_at = $2
       WHERE switch_id = $1 AND status IN ('pending', 'claimed', 'blocked_configuration', 'failed')`,
      [item.id, at]
    );
    const cycle = Number(item.schedule_cycle) + 1;
    const nextDue = computeNextDue
      ? asDate(computeNextDue(at, item.interval_days))
      : new Date(at.getTime() + Number(item.interval_days) * 24 * 60 * 60 * 1000);
    const { rows: updated } = await db.query(
      `UPDATE continuity_switches
       SET status = 'armed', schedule_cycle = $2, last_checkin_at = $3,
           next_checkin_due_at = $4, delivery_pending_at = NULL, updated_at = $3
       WHERE id = $1 RETURNING *`, [item.id, cycle, at, nextDue]
    );
    await recordEvent(db, {
      switchId: item.id, type: 'switch.owner_recovered', cycle,
      details: { prior_delivery_run_id: run?.id || null, next_checkin_due_at: nextDue },
      dedupeKey, occurredAt: at
    });
    return updated[0];
  });
}

async function getRunForOwner({ ownerId, switchId }, db = pool) {
  const { rows } = await db.query(
    `SELECT run.*,
            COUNT(snapshot.id)::int AS trustee_count,
            COUNT(snapshot.first_successful_send_at)::int AS trustees_notified
     FROM continuity_delivery_runs run
     JOIN continuity_switches switch ON switch.id = run.switch_id
     LEFT JOIN continuity_delivery_run_trustees snapshot ON snapshot.delivery_run_id = run.id
     WHERE run.switch_id = $1 AND switch.owner_id = $2
     GROUP BY run.id ORDER BY run.id DESC LIMIT 1`,
    [Number(switchId), Number(ownerId)]
  );
  return rows[0] || null;
}

module.exports = {
  TOKEN_STAGING_TTL_MS,
  TRUSTEE_ACTION_WINDOW_MS,
  TRUSTEE_PAUSE_MS,
  advanceRunDeadlines,
  claimTrusteeOutboxAttempt,
  completeTrusteeOutboxAttempt,
  getRunForOwner,
  getTrusteeAction,
  initializePendingRuns,
  pauseWithTrusteeToken,
  recoverOwner,
  safeErrorClass,
  tokenHash,
  trusteeActionUrl,
  trusteeNotificationMessage
};
