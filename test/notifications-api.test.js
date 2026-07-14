'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { authedDel, authedPost, createMember, getPool, loginAs, resetDatabase, startServer, stopServer } = require('./helpers');

let pool;
let parent;
let parentCookie;

describe('key-event notification dispatch', () => {
  before(async () => {
    await startServer();
    pool = getPool();
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('NotifyParent', 'parent', 'notify-pass');
    parentCookie = await loginAs(parent, 'notify-pass');
  });

  it('records notification dispatches for direct key registration and revocation without requiring SMTP', async () => {
    const registration = await authedPost(`api/members/${parent.id}/keys`, parentCookie, {
      public_key: Buffer.from('notification-key').toString('base64'),
      encrypted_private_key: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"def"}',
      algorithm: 'x25519',
      protection_tier: 'passphrase',
      label: 'Notification Test Key'
    });
    assert.equal(registration.status, 201);
    const key = await registration.json();

    const revocation = await authedDel(`api/members/${parent.id}/keys/${key.id}`, parentCookie);
    assert.equal(revocation.status, 200);

    const { rows } = await pool.query(
      `SELECT details
       FROM audit_log
       WHERE action = 'notification.key_event' AND entity_id = $1
       ORDER BY id`,
      [parent.id]
    );
    assert.deepEqual(rows.map((row) => row.details.event), ['key.registered', 'key.revoked']);
    assert.ok(rows.every((row) => row.details.delivered === false));
    assert.ok(rows.every((row) => row.details.reason === 'NOTIFICATION_TO is not configured'));
  });
});
