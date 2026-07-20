'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildAppUrl } = require('../lib/app-url');

describe('canonical application links', () => {
  it('preserves the documented nginx subpath for every ceremony page', () => {
    const env = { APP_URL: 'https://home.family.test/source/' };
    for (const page of [
      'trustee-invite.html', 'trustee-contact.html', 'continuity-contact.html',
      'check-in.html', 'trustee-action.html', 'continuity.html'
    ]) {
      assert.equal(buildAppUrl(page, { env }), `https://home.family.test/source/${page}`);
    }
  });

  it('normalizes a subpath base without a trailing slash and attaches tokens', () => {
    assert.equal(
      buildAppUrl('trustee-action.html', {
        env: { APP_URL: 'https://home.family.test/source' }, token: 'pause-token'
      }),
      'https://home.family.test/source/trustee-action.html?token=pause-token'
    );
  });

  it('rejects non-http and insecure non-local application URLs', () => {
    assert.throws(() => buildAppUrl('check-in.html', { env: { APP_URL: 'file:///tmp/source/' } }), /absolute http/);
    assert.throws(() => buildAppUrl('check-in.html', { env: { APP_URL: 'http://home.family.test/source/' } }), /HTTPS/);
    assert.equal(
      buildAppUrl('check-in.html', { env: { APP_URL: 'http://localhost:3008/source/' } }),
      'http://localhost:3008/source/check-in.html'
    );
  });
});
