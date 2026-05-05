'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedPut, authedDel, createTestDocument } = require('./helpers');
const { canonicalizePair } = require('../lib/magic-links');

let parent;
let kid;
let parentCookie;
let kidCookie;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('LinksParent', 'parent', 'pass123');
  kid = await createMember('LinksKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass123');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('magic link canonicalization', () => {
  it('canonicalizes symmetric links by document id order', () => {
    const pair = canonicalizePair(10, 3, 'same_account');
    assert.deepEqual(pair, { sourceDocumentId: 3, targetDocumentId: 10, linkType: 'same_account' });
  });

  it('preserves direction for supersedes', () => {
    const pair = canonicalizePair(10, 3, 'supersedes');
    assert.deepEqual(pair, { sourceDocumentId: 10, targetDocumentId: 3, linkType: 'supersedes' });
  });
});

describe('magic links API and deterministic scan', () => {
  let oldPolicy;
  let newPolicy;
  let oldRegistration;
  let newRegistration;

  before(async () => {
    oldPolicy = await createTestDocument(parent.id, {
      title: 'Loggerhead Policy 2025',
      document_type: 'insurance',
      issued_date: '2025-01-14',
      expiry_date: '2026-03-15',
      metadata: {
        magicindex: {
          suggestions: {
            summary: 'Homeowners policy declarations',
            suggested_owners: [{ member_name: 'Eric Forbell', confidence: 0.95, ownership_type: 'owner' }],
            key_facts: [
              { label: 'Policy Number', key: 'policy_number', value: 'LH-FLHO30022815-03', confidence: 0.95 },
              { label: 'Renewal Term', key: 'renewal_term', value: '03/15/2025 to 03/15/2026', confidence: 0.95 }
            ]
          }
        }
      }
    });
    newPolicy = await createTestDocument(parent.id, {
      title: 'Loggerhead Renewal 2026',
      document_type: 'insurance',
      issued_date: '2026-01-14',
      expiry_date: '2027-03-15',
      metadata: {
        magicindex: {
          suggestions: {
            summary: 'Renewal offer for homeowners policy',
            suggested_owners: [{ member_name: 'Eric Forbell', confidence: 0.95, ownership_type: 'owner' }],
            key_facts: [
              { label: 'Policy Number', key: 'policy_number', value: 'LH-FLHO30022815-03', confidence: 0.95 },
              { label: 'Renewal Term', key: 'renewal_term', value: '03/15/2026 to 03/15/2027', confidence: 0.95 }
            ]
          }
        }
      }
    });
    oldRegistration = await createTestDocument(parent.id, {
      title: 'Truck Registration 2025',
      document_type: 'vehicle',
      issued_date: '2025-09-02',
      expiry_date: '2026-10-28',
      metadata: {
        magicindex: {
          suggestions: {
            summary: 'Florida vehicle registration for RAM 1500',
            key_facts: [
              { label: 'VIN', key: 'vin', value: '1C6SRFLT3NN385966', confidence: 0.95 },
              { label: 'Plate Number', key: 'plate_number', value: '40EVKJ', confidence: 0.95 }
            ]
          }
        }
      }
    });
    newRegistration = await createTestDocument(parent.id, {
      title: 'Truck Registration 2026',
      document_type: 'vehicle',
      issued_date: '2026-09-02',
      expiry_date: '2027-10-28',
      metadata: {
        magicindex: {
          suggestions: {
            summary: 'Florida vehicle registration for RAM 1500',
            key_facts: [
              { label: 'VIN', key: 'vin', value: '1C6SRFLT3NN385966', confidence: 0.95 },
              { label: 'Plate Number', key: 'plate_number', value: '40EVKJ', confidence: 0.95 }
            ]
          }
        }
      }
    });
  });

  it('creates manual accepted links and reads them back from document detail', async () => {
    const res = await authedPost(`api/documents/${oldPolicy.id}/links`, parentCookie, {
      target_document_id: oldRegistration.id,
      link_type: 'same_asset',
      reasoning: 'Insurance and registration relate to the same household asset set.'
    });
    assert.equal(res.status, 201);
    const link = await res.json();
    assert.equal(link.status, 'accepted');
    assert.equal(link.created_by, 'user');

    const detailRes = await authedGet(`api/documents/${oldPolicy.id}/links`, parentCookie);
    assert.equal(detailRes.status, 200);
    const links = await detailRes.json();
    assert.ok(links.some((item) => item.id === link.id && item.related_document_id === oldRegistration.id));
  });

  it('runs deterministic scan and suggests renewal and superseding links', async () => {
    const res = await authedPost('api/links/scan', parentCookie, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.created_or_updated >= 2);

    const policyLinks = await (await authedGet(`api/documents/${newPolicy.id}/links`, parentCookie)).json();
    const renewal = policyLinks.find((link) => link.link_type === 'renews' && link.related_document_id === oldPolicy.id);
    assert.ok(renewal);
    assert.equal(renewal.status, 'suggested');
    const policySameAccount = policyLinks.find((link) => link.link_type === 'same_account' && link.related_document_id === oldPolicy.id);
    assert.ok(policySameAccount);

    const vehicleLinks = await (await authedGet(`api/documents/${newRegistration.id}/links`, parentCookie)).json();
    const supersede = vehicleLinks.find((link) => link.link_type === 'supersedes' && link.related_document_id === oldRegistration.id);
    assert.ok(supersede);
    assert.equal(supersede.status, 'suggested');
    const vehicleSameAsset = vehicleLinks.find((link) => link.link_type === 'same_asset' && link.related_document_id === oldRegistration.id);
    assert.ok(vehicleSameAsset);
  });

  it('accepts suggested links and exposes archive suggestion context for accepted superseding links', async () => {
    const links = await (await authedGet(`api/documents/${newRegistration.id}/links`, parentCookie)).json();
    const supersede = links.find((link) => link.link_type === 'supersedes' && link.related_document_id === oldRegistration.id);
    const res = await authedPut(`api/links/${supersede.id}`, parentCookie, { status: 'accepted' });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.status, 'accepted');

    const refreshed = await (await authedGet(`api/documents/${newRegistration.id}/links`, parentCookie)).json();
    const accepted = refreshed.find((link) => link.id === supersede.id);
    assert.equal(accepted.archive_candidate_document_id, oldRegistration.id);
    assert.equal(accepted.archive_candidate_document_title, oldRegistration.title);
    assert.equal(accepted.direction, 'outgoing');
  });

  it('blocks kid writes to link routes', async () => {
    const res = await authedPost(`api/documents/${oldPolicy.id}/links`, kidCookie, {
      target_document_id: oldRegistration.id,
      link_type: 'same_asset',
      reasoning: 'Nope'
    });
    assert.equal(res.status, 403);
  });

  it('deletes links', async () => {
    const links = await (await authedGet(`api/documents/${oldPolicy.id}/links`, parentCookie)).json();
    const manualLink = links.find((link) => link.created_by === 'user');
    const res = await authedDel(`api/links/${manualLink.id}`, parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });
});
