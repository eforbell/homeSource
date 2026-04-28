'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractDatabaseName, isSafeTestDatabaseUrl } = require('../db/test-env');

describe('extractDatabaseName', () => {
  it('extracts database name from postgres URL', () => {
    assert.equal(extractDatabaseName('postgresql://user:pass@localhost:5432/homesource_test'), 'homesource_test');
  });

  it('returns empty string for invalid URL', () => {
    assert.equal(extractDatabaseName('not-a-url'), '');
  });

  it('handles URL-encoded path', () => {
    assert.equal(extractDatabaseName('postgresql://user:pass@localhost/my%20test'), 'my test');
  });
});

describe('isSafeTestDatabaseUrl', () => {
  it('accepts database names containing _test', () => {
    assert.ok(isSafeTestDatabaseUrl('postgresql://u:p@localhost/homesource_test'));
  });

  it('accepts database names starting with test_', () => {
    assert.ok(isSafeTestDatabaseUrl('postgresql://u:p@localhost/test_homesource'));
  });

  it('accepts database names ending with -test', () => {
    assert.ok(isSafeTestDatabaseUrl('postgresql://u:p@localhost/homesource-test'));
  });

  it('rejects production-looking names', () => {
    assert.ok(!isSafeTestDatabaseUrl('postgresql://u:p@localhost/homesource'));
    assert.ok(!isSafeTestDatabaseUrl('postgresql://u:p@localhost/production'));
  });

  it('rejects null/empty', () => {
    assert.ok(!isSafeTestDatabaseUrl(null));
    assert.ok(!isSafeTestDatabaseUrl(''));
  });
});
