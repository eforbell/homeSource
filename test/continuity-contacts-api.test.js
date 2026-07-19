'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  authedDel, authedGet, authedPost, createMember, getPool, loginAs, resetDatabase, startServer, stopServer, url
} = require('./helpers');
const continuity = require('../lib/continuity');
const contacts = require('../lib/continuity-contacts');

let pool;
let parent;
let otherParent;
let kid;
let parentCookie;
let otherParentCookie;
let kidCookie;
let switchItem;
let previousEnv;

describe('continuity beneficiary contact ceremony', () => {
  before(async () => {
    previousEnv = {
      APP_URL: process.env.APP_URL,
      MAIL_TRANSPORT: process.env.MAIL_TRANSPORT,
      SMTP_FROM: process.env.SMTP_FROM
    };
    process.env.APP_URL = 'https://home.family.test';
    process.env.MAIL_TRANSPORT = 'disabled';
    process.env.SMTP_FROM = 'Home Source <home@family.test>';
    await startServer();
    pool = getPool();
  });

  after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Contact Parent', 'parent', 'parent-pass');
    otherParent = await createMember('Other Contact Parent', 'parent', 'other-pass');
    kid = await createMember('Contact Kid', 'kid', 'kid-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
    otherParentCookie = await loginAs(otherParent, 'other-pass');
    kidCookie = await loginAs(kid, 'kid-pass');
    switchItem = await continuity.saveDraft({
      ownerId: parent.id,
      reminderEmail: 'owner@family.test',
      intervalDays: 30,
      gracePeriodDays: 14,
      recipients: [{ member_id: kid.id }],
      operationKey: 'contact-draft'
    });
  });

  it('lets only the switch owner start a normalized, non-authorizing contact verification', async () => {
    const created = await authedPost(
      `api/continuity/switch/${switchItem.id}/contacts/members/${kid.id}/email`,
      parentCookie,
      { email: '  Kid.Contact@Example.Test  ' }
    );
    assert.equal(created.status, 201);
    const payload = await created.json();
    assert.equal(payload.contact.normalized_address, 'kid.contact@example.test');
    assert.equal(payload.contact.status, 'pending');
    assert.equal(payload.verification.delivered, false);
    assert.equal(payload.verification.token, undefined);

    const { rows: tokens } = await pool.query(
      'SELECT token_hash FROM member_contact_verification_tokens WHERE contact_channel_id = $1',
      [payload.contact.id]
    );
    assert.equal(tokens.length, 1);
    assert.match(tokens[0].token_hash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(payload), /Kid\.Contact@Example\.Test/);

    const listed = await authedGet(`api/continuity/switch/${switchItem.id}/contacts`, parentCookie);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).contacts[0].status, 'pending');

    const kidAttempt = await authedPost(
      `api/continuity/switch/${switchItem.id}/contacts/members/${kid.id}/email`,
      kidCookie,
      { email: 'kid@example.test' }
    );
    assert.equal(kidAttempt.status, 403);

    const otherParentList = await authedGet(`api/continuity/switch/${switchItem.id}/contacts`, otherParentCookie);
    assert.equal(otherParentList.status, 404);

    const parentSubject = await authedPost(
      `api/continuity/switch/${switchItem.id}/contacts/members/${otherParent.id}/email`,
      parentCookie,
      { email: 'not-a-beneficiary@example.test' }
    );
    assert.equal(parentSubject.status, 400);
  });

  it('replaces usable tokens and verifies exactly one contact once', async () => {
    const first = await contacts.startMemberEmailVerification({
      ownerId: parent.id,
      switchId: switchItem.id,
      memberId: kid.id,
      email: 'kid@example.test',
      now: new Date('2026-07-19T12:00:00Z')
    });
    assert.equal(first.contact.status, 'pending');
    assert.ok(first.token);
    assert.equal((await contacts.getValidMemberEmailVerification(first.token, new Date('2026-07-20T12:00:00Z'))).contact_id, first.contact.id);

    const replacement = await contacts.resendMemberEmailVerification({
      ownerId: parent.id,
      switchId: switchItem.id,
      contactId: first.contact.id,
      now: new Date('2026-07-20T12:00:00Z')
    });
    assert.notEqual(replacement.token, first.token);
    assert.equal(await contacts.getValidMemberEmailVerification(first.token, new Date('2026-07-20T12:00:01Z')), null);

    const verified = await contacts.verifyMemberEmail({
      token: replacement.token,
      now: new Date('2026-07-20T12:01:00Z')
    });
    assert.equal(verified.status, 'verified');
    assert.ok(verified.verified_at);
    assert.equal(await contacts.verifyMemberEmail({ token: replacement.token, now: new Date('2026-07-20T12:02:00Z') }), null);
  });

  it('expires and revokes verification material without leaving a usable link', async () => {
    const expired = await contacts.startMemberEmailVerification({
      ownerId: parent.id,
      switchId: switchItem.id,
      memberId: kid.id,
      email: 'expires@example.test',
      now: new Date('2026-07-01T12:00:00Z')
    });
    assert.equal(await contacts.getValidMemberEmailVerification(expired.token, new Date('2026-07-08T12:00:01Z')), null);

    const replacement = await contacts.startMemberEmailVerification({
      ownerId: parent.id,
      switchId: switchItem.id,
      memberId: kid.id,
      email: 'replacement@example.test'
    });
    const revoked = await authedDel(
      `api/continuity/switch/${switchItem.id}/contacts/${replacement.contact.id}`,
      parentCookie
    );
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).contact.status, 'revoked');
    assert.equal(await contacts.getValidMemberEmailVerification(replacement.token), null);
  });

  it('rejects malformed and multiply assigned active recipient addresses', async () => {
    await assert.rejects(
      contacts.startMemberEmailVerification({
        ownerId: parent.id, switchId: switchItem.id, memberId: kid.id, email: 'not-an-email'
      }),
      /valid email/i
    );
    const secondKid = await createMember('Second Contact Kid', 'kid', 'second-pass');
    await continuity.saveDraft({
      ownerId: parent.id,
      reminderEmail: 'owner@family.test',
      intervalDays: 30,
      gracePeriodDays: 14,
      recipients: [{ member_id: kid.id }, { member_id: secondKid.id }],
      operationKey: 'contact-draft-two-kids'
    });
    await contacts.startMemberEmailVerification({
      ownerId: parent.id, switchId: switchItem.id, memberId: kid.id, email: 'shared@example.test'
    });
    await assert.rejects(
      contacts.startMemberEmailVerification({
        ownerId: parent.id, switchId: switchItem.id, memberId: secondKid.id, email: 'shared@example.test'
      }),
      /already assigned/i
    );
  });

  it('confirms through a sessionless public route without issuing vault authority', async () => {
    const started = await contacts.startMemberEmailVerification({
      ownerId: parent.id,
      switchId: switchItem.id,
      memberId: kid.id,
      email: 'kid@example.test'
    });

    const inspected = await fetch(url('api/continuity/contact-verification/validate'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: started.token })
    });
    assert.equal(inspected.status, 200);
    const inspection = await inspected.json();
    assert.equal(inspection.recipient_name, kid.name);
    assert.match(inspection.masked_address, /^k\*\*@example\.test$/);
    assert.equal(inspection.normalized_address, undefined);

    const confirmed = await fetch(url('api/continuity/contact-verification/confirm'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: started.token })
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.headers.get('set-cookie'), null);
    assert.deepEqual(await confirmed.json(), { verified: true });

    const replay = await fetch(url('api/continuity/contact-verification/confirm'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: started.token })
    });
    assert.equal(replay.status, 404);
    const unauthenticated = await fetch(url('api/auth/me'));
    assert.equal(unauthenticated.status, 401);

    const page = await fetch(url('continuity-contact.html'));
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /grants no document access/i);
    assert.doesNotMatch(html, /nav\.js/);
  });

  it('backs up contact state and token hashes without the usable token', async () => {
    const started = await contacts.startMemberEmailVerification({
      ownerId: parent.id,
      switchId: switchItem.id,
      memberId: kid.id,
      email: 'backup-kid@example.test'
    });
    const backup = await authedPost('api/backup/export', parentCookie, { encrypted: false });
    assert.equal(backup.status, 200);
    const result = await backup.json();
    const archive = path.join(process.env.STORAGE_PATH, 'exports', result.file);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-contact-backup-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', extracted]);
      const root = fs.readdirSync(extracted)
        .map(name => path.join(extracted, name))
        .find(candidate => fs.statSync(candidate).isDirectory());
      const database = JSON.parse(fs.readFileSync(path.join(root, 'database.json'), 'utf8'));
      assert.equal(database.member_contact_channels.length, 1);
      assert.equal(database.member_contact_verification_tokens.length, 1);
      assert.match(database.member_contact_verification_tokens[0].token_hash, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(database), new RegExp(started.token));
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
    }
  });
});
