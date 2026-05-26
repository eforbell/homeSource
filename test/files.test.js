'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_MIME, isImageMime } = require('../lib/files');

describe('ALLOWED_MIME', () => {
  it('includes PDF', () => {
    assert.ok(ALLOWED_MIME.has('application/pdf'));
  });

  it('includes opaque ciphertext blobs for encrypted uploads', () => {
    assert.ok(ALLOWED_MIME.has('application/octet-stream'));
  });

  it('includes common image types', () => {
    assert.ok(ALLOWED_MIME.has('image/jpeg'));
    assert.ok(ALLOWED_MIME.has('image/png'));
    assert.ok(ALLOWED_MIME.has('image/webp'));
  });

  it('includes HEIC for iPhone', () => {
    assert.ok(ALLOWED_MIME.has('image/heic'));
    assert.ok(ALLOWED_MIME.has('image/heif'));
  });

  it('rejects arbitrary types', () => {
    assert.ok(!ALLOWED_MIME.has('text/plain'));
    assert.ok(!ALLOWED_MIME.has('application/zip'));
    assert.ok(!ALLOWED_MIME.has('video/mp4'));
  });
});

describe('isImageMime', () => {
  it('returns true for image types', () => {
    assert.ok(isImageMime('image/jpeg'));
    assert.ok(isImageMime('image/png'));
    assert.ok(isImageMime('image/heic'));
  });

  it('returns false for non-image types', () => {
    assert.ok(!isImageMime('application/pdf'));
    assert.ok(!isImageMime('text/plain'));
  });
});
