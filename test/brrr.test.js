'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sendBrrrNotification, withIconUrl } = require('../lib/brrr');

const TARGET = 'https://api.brrr.now/v1/secret-value-1234';

describe('brrr icon_url', () => {
  it('adds a configured https icon URL', () => {
    assert.deepEqual(withIconUrl({ title: 'Test' }, ' https://cdn.example.test/hs.png '), {
      title: 'Test',
      icon_url: 'https://cdn.example.test/hs.png'
    });
  });

  it('ignores missing, malformed, or non-https icon URLs', () => {
    for (const value of [undefined, '', 'hs.png', 'https://', 'http://cdn.example.test/hs.png', 'javascript:alert(1)']) {
      assert.deepEqual(withIconUrl({ title: 'Test' }, value), { title: 'Test' }, String(value));
    }
  });

  it('keeps an explicit per-payload icon_url', () => {
    const payload = withIconUrl({ icon_url: 'https://a.test/x.png' }, 'https://b.test/y.png');
    assert.equal(payload.icon_url, 'https://a.test/x.png');
  });

  it('sends the icon URL in the brrr request body', async () => {
    let sentBody;
    const fetchImpl = async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200 };
    };
    await sendBrrrNotification(TARGET, { title: 'Test', message: 'Hi' }, {
      fetchImpl,
      iconUrl: 'https://cdn.example.test/hs.png'
    });
    assert.deepEqual(sentBody, { title: 'Test', message: 'Hi', icon_url: 'https://cdn.example.test/hs.png' });
  });

  it('falls back to BRRR_ICON_URL when no icon URL option is passed', async () => {
    const originalIcon = process.env.BRRR_ICON_URL;
    let sentBody;
    process.env.BRRR_ICON_URL = 'https://cdn.example.test/env.png';
    try {
      await sendBrrrNotification(TARGET, { title: 'Test' }, {
        fetchImpl: async (_url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200 }; }
      });
    } finally {
      if (originalIcon === undefined) delete process.env.BRRR_ICON_URL;
      else process.env.BRRR_ICON_URL = originalIcon;
    }
    assert.equal(sentBody.icon_url, 'https://cdn.example.test/env.png');
  });
});
