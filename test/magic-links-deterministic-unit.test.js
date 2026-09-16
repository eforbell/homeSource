'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  factMap,
  candidateVehicleSupersede,
  candidateStatementSupersede,
  candidateSameAsset
} = require('../lib/scanners/magic-links-deterministic');

function doc(id, { title, type = 'vehicle', issued, expiry, facts, source }) {
  return {
    id,
    title,
    document_type: type,
    issued_date: issued,
    expiry_date: expiry,
    metadata: { magicindex: { suggestions: {
      key_facts: facts,
      extraction_evidence: source ? { source } : undefined
    } } }
  };
}

test('legacy MagicIndex labels still reveal a shared vehicle without asserting supersession', () => {
  const facts = [
    { label: 'vin_number', value: 'TEST-VIN-123' },
    { label: 'plate_number', value: 'PLATE-16' },
    { label: 'registration_expires', value: '2026-10-28' }
  ];
  const a = doc(158, { title: 'Vehicle Registration', issued: '2022-04-01', expiry: '2026-10-28', facts });
  const b = doc(195, { title: 'Vehicle Registration', issued: '2022-04-01', expiry: '2026-10-28', facts });
  assert.equal(factMap(a).get('vin'), 'TEST-VIN-123');
  assert.equal(candidateSameAsset(a, b)?.linkType, 'same_asset');
  assert.equal(candidateVehicleSupersede(a, b), null);
});

test('later registration for the same VIN can supersede the older one', () => {
  const facts = [{ label: 'vin_number', value: 'TEST-VIN-123' }];
  const a = doc(1, { title: '2026 registration', issued: '2026-01-01', expiry: '2027-01-01', facts });
  const b = doc(2, { title: '2025 registration', issued: '2025-01-01', expiry: '2026-01-01', facts });
  assert.equal(candidateVehicleSupersede(a, b)?.sourceDocumentId, 1);
  assert.equal(candidateVehicleSupersede(a, b)?.targetDocumentId, 2);
});

test('same plate with conflicting VINs cannot establish supersession', () => {
  const a = doc(1, { title: 'Registration A', issued: '2026-01-01', expiry: '2027-01-01', facts: [
    { label: 'vin_number', value: 'VIN-A' }, { label: 'plate_number', value: 'SAME-PLATE' }
  ] });
  const b = doc(2, { title: 'Registration B', issued: '2025-01-01', expiry: '2026-01-01', facts: [
    { label: 'vin_number', value: 'VIN-B' }, { label: 'plate_number', value: 'SAME-PLATE' }
  ] });
  assert.equal(candidateVehicleSupersede(a, b), null);
});

test('vehicle title does not supersede a registration merely because it is newer', () => {
  const facts = [{ label: 'vin_number', value: 'TEST-VIN-123' }];
  const title = doc(1, { title: 'Vehicle Title', issued: '2026-01-01', expiry: '2027-01-01', facts });
  const registration = doc(2, { title: 'Vehicle Registration', issued: '2025-01-01', expiry: '2026-01-01', facts });
  assert.equal(candidateVehicleSupersede(title, registration), null);
});

test('matching plate plus a one-character OCR VIN insertion supports a reviewable newer registration', () => {
  const oldDoc = doc(158, {
    title: 'Florida Vehicle Registration', issued: '2022-04-01', expiry: '2026-10-28',
    source: 'pdf_ocr_preview',
    facts: [{ label: 'vin_number', value: '123456789ABCDEFGH' }, { label: 'plate_number', value: 'PLATE-16' }]
  });
  const newDoc = doc(195, {
    title: 'Florida Vehicle Registration', issued: '2026-08-21', expiry: '2027-10-28',
    source: 'image_ocr_preview',
    facts: [{ key: 'vin', value: '1234556789ABCDEFGH' }, { key: 'plate_number', value: 'PLATE-16' }]
  });
  const suggested = candidateVehicleSupersede(newDoc, oldDoc);
  assert.equal(suggested?.sourceDocumentId, 195);
  assert.equal(suggested?.targetDocumentId, 158);
  assert.equal(suggested?.confidence, 0.75);
  assert.match(suggested?.reasoning, /Verify the VIN/);
  assert.equal(candidateSameAsset(newDoc, oldDoc)?.linkType, 'same_asset');

  newDoc.metadata.magicindex.suggestions.extraction_evidence.source = 'pdf_text_preview';
  assert.equal(candidateVehicleSupersede(newDoc, oldDoc), null);
});

test('later statement period is history, not a superseding version', () => {
  const a = doc(1, { title: 'March statement', type: 'other', issued: '2026-04-02', facts: [
    { label: 'account_number', value: '1234' },
    { label: 'statement_period', value: '2026-03-01 to 2026-03-31' }
  ] });
  const b = doc(2, { title: 'February statement', type: 'other', issued: '2026-03-02', facts: [
    { label: 'account_number', value: '1234' },
    { label: 'statement_period', value: '2026-02-01 to 2026-02-28' }
  ] });
  assert.equal(candidateStatementSupersede(a, b), null);
});

test('corrected statement for the same account and period can supersede', () => {
  const facts = [
    { label: 'account_number', value: '1234' },
    { label: 'statement_period', value: '2026-03-01 to 2026-03-31' }
  ];
  const a = doc(1, { title: 'Corrected March statement', type: 'other', issued: '2026-04-05', facts });
  const b = doc(2, { title: 'March statement', type: 'other', issued: '2026-04-02', facts });
  assert.equal(candidateStatementSupersede(a, b)?.sourceDocumentId, 1);
  assert.equal(candidateStatementSupersede(a, b)?.linkType, 'supersedes');
});
