'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedDel, createTestDocument, url, getPool } = require('./helpers');

let parent, kid, parentCookie, kidCookie;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('ShareParent', 'parent', 'pass');
  kid = await createMember('ShareKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('share link lifecycle', () => {
  let doc, shareToken, shareId;

  before(async () => {
    doc = await createTestDocument(parent.id, { title: 'Shareable Doc' });
  });

  it('creates a view-only share link', async () => {
    const res = await authedPost(`api/documents/${doc.id}/share`, parentCookie, {
      access_level: 'view'
    });
    assert.equal(res.status, 201);
    const link = await res.json();
    assert.ok(link.token);
    assert.equal(link.access_level, 'view');
    assert.equal(link.pin_hash, null);
    shareToken = link.token;
    shareId = link.id;
  });

  it('accesses share link without auth', async () => {
    const res = await fetch(url(`api/share/${shareToken}`));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.document.title, 'Shareable Doc');
    assert.equal(data.access_level, 'view');
  });

  it('lists share links for document', async () => {
    const res = await authedGet(`api/documents/${doc.id}/shares`, parentCookie);
    assert.equal(res.status, 200);
    const shares = await res.json();
    assert.ok(shares.length >= 1);
    assert.equal(shares[0].token, shareToken);
  });

  it('revokes share link', async () => {
    const res = await authedDel(`api/shares/${shareId}`, parentCookie);
    assert.equal(res.status, 200);

    const accessRes = await fetch(url(`api/share/${shareToken}`));
    assert.equal(accessRes.status, 404);
  });

  it('kid cannot create share links', async () => {
    const res = await authedPost(`api/documents/${doc.id}/share`, kidCookie, {
      access_level: 'view'
    });
    assert.equal(res.status, 403);
  });
});

describe('PIN-protected share links', () => {
  let doc, shareToken;

  before(async () => {
    doc = await createTestDocument(parent.id, { title: 'PIN Protected Doc' });
    const res = await authedPost(`api/documents/${doc.id}/share`, parentCookie, {
      access_level: 'download',
      pin: '1234'
    });
    const link = await res.json();
    shareToken = link.token;
  });

  it('returns needs_pin without revealing document', async () => {
    const res = await fetch(url(`api/share/${shareToken}`));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.needs_pin, true);
    assert.ok(data.document_title);
    assert.equal(data.document, undefined, 'should not expose document data');
  });

  it('rejects wrong PIN', async () => {
    const res = await fetch(url(`api/share/${shareToken}/verify`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '9999' })
    });
    assert.equal(res.status, 401);
  });

  it('accepts correct PIN', async () => {
    const res = await fetch(url(`api/share/${shareToken}/verify`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.document.title, 'PIN Protected Doc');
    assert.equal(data.access_level, 'download');
  });
});

describe('a PIN-protected link\'s files', () => {
  const { storeFile, saveFileRecord } = require('../lib/files');
  const { getShareLink, createDownloadProof, DOWNLOAD_PROOF_SECONDS } = require('../lib/share');
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  let pinned, other, open, pinnedFile, otherFile, openFile;

  async function sharedFile(title, options) {
    const doc = await createTestDocument(parent.id, { title });
    const file = await saveFileRecord(doc.id, await storeFile(PDF, `${title}.pdf`, 'application/pdf'));
    const link = await (await authedPost(`api/documents/${doc.id}/share`, parentCookie, { access_level: 'download', ...options })).json();
    return [link, file];
  }
  const verify = async (link, pin) => fetch(url(`api/share/${link.token}/verify`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin })
  });
  const download = (link, file, query = '') => fetch(url(`api/share/${link.token}/files/${file.id}/download${query}`));
  const proofQuery = (proof) => `?proof=${encodeURIComponent(proof)}`;

  before(async () => {
    [pinned, pinnedFile] = await sharedFile('Pinned Files', { pin: '2468' });
    [other, otherFile] = await sharedFile('Other Pinned Files', { pin: '1357' });
    [open, openFile] = await sharedFile('Open Files', {});
  });

  it('a correct PIN returns a proof, and the proof opens the link\'s files', async () => {
    const answer = await verify(pinned, '2468');
    assert.equal(answer.status, 200);
    const { download_proof: proof } = await answer.json();
    assert.match(proof, /^\d+\.[A-Za-z0-9_-]{43}$/);
    assert.ok(!proof.includes('2468'), 'the PIN is not in it');
    const file = await download(pinned, pinnedFile, proofQuery(proof));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  });

  it('without a proof, or with a wrong one, a PIN-protected link\'s files stay closed', async () => {
    const refused = async (query, label) => {
      const answer = await download(pinned, pinnedFile, query);
      assert.equal(answer.status, 403, label);
      assert.equal(answer.headers.get('cache-control'), 'no-store', label);
    };
    await refused('', 'no proof');
    await refused('?proof=', 'an empty proof');
    await refused('?pin=2468', 'the PIN itself');
    await refused('?proof=not-a-proof', 'not a proof');
    const { download_proof: proof } = await (await verify(pinned, '2468')).json();
    const [expires, mac] = proof.split('.');
    await refused(proofQuery(`${expires}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`), 'a changed signature');
    await refused(proofQuery(`${Number(expires) + 1}.${mac}`), 'a changed expiry');
    await refused(`${proofQuery(proof)}&proof=${encodeURIComponent(proof)}`, 'two proofs');
    const link = await getShareLink(pinned.token);
    await refused(proofQuery(createDownloadProof(link, Date.now() - (DOWNLOAD_PROOF_SECONDS + 60) * 1000)), 'an expired proof');
    await refused(proofQuery(createDownloadProof(link, Date.now() + 3600 * 1000)), 'a proof that lasts too long');
    // Another link's proof, even for the same file number on its own link, opens nothing here.
    const { download_proof: otherProof } = await (await verify(other, '1357')).json();
    await refused(proofQuery(otherProof), 'another link\'s proof');
    assert.equal((await download(other, otherFile, proofQuery(otherProof))).status, 200, 'it opens its own link\'s files');
    // Even when both links carry the very same stored PIN, a proof names its own link.
    const pool = getPool();
    const { rows: [{ pin_hash: otherPin }] } = await pool.query('SELECT pin_hash FROM share_links WHERE id = $1', [other.id]);
    const { rows: [{ pin_hash: ownPin }] } = await pool.query('SELECT pin_hash FROM share_links WHERE id = $1', [pinned.id]);
    await pool.query('UPDATE share_links SET pin_hash = $1 WHERE id = $2', [otherPin, pinned.id]);
    try {
      await refused(proofQuery(otherProof), 'another link\'s proof, same PIN');
    } finally {
      await pool.query('UPDATE share_links SET pin_hash = $1 WHERE id = $2', [ownPin, pinned.id]);
    }
    // A wrong PIN gives no proof.
    const wrong = await verify(pinned, '0000');
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).download_proof, undefined);
  });

  it('a proof stops working when the link\'s PIN changes', async () => {
    const { download_proof: proof } = await (await verify(pinned, '2468')).json();
    const pool = getPool();
    const { rows: [{ pin_hash: original }] } = await pool.query('SELECT pin_hash FROM share_links WHERE id = $1', [pinned.id]);
    await pool.query('UPDATE share_links SET pin_hash = $1 WHERE id = $2', [require('../lib/auth').hashPassphrase('9753'), pinned.id]);
    try {
      assert.equal((await download(pinned, pinnedFile, proofQuery(proof))).status, 403);
    } finally {
      await pool.query('UPDATE share_links SET pin_hash = $1 WHERE id = $2', [original, pinned.id]);
    }
  });

  it('a link without a PIN opens its files as before, with no proof', async () => {
    assert.equal((await download(open, openFile)).status, 200);
    assert.equal((await download(open, openFile, '?proof=anything')).status, 200);
    const shown = await (await fetch(url(`api/share/${open.token}`))).json();
    assert.equal(shown.download_proof, undefined);
  });
});

describe('share link edge cases', () => {
  it('returns 404 for invalid token', async () => {
    const res = await fetch(url('api/share/nonexistent-token'));
    assert.equal(res.status, 404);
  });

  it('returns 404 for archived document share link', async () => {
    const doc = await createTestDocument(parent.id, { title: 'Will Archive' });
    const createRes = await authedPost(`api/documents/${doc.id}/share`, parentCookie, {
      access_level: 'view'
    });
    const link = await createRes.json();

    await authedDel(`api/documents/${doc.id}`, parentCookie);

    const accessRes = await fetch(url(`api/share/${link.token}`));
    assert.equal(accessRes.status, 404);
  });

  it('blocks share link creation for encrypted docs', async () => {
    const doc = await createTestDocument(parent.id, {
      title: 'Encrypted Doc',
      is_encrypted: true,
      encryption_mode: 'passphrase',
      encryption_metadata: { version: 1, mode: 'passphrase' }
    });

    const res = await authedPost(`api/documents/${doc.id}/share`, parentCookie, {
      access_level: 'view'
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /unavailable for encrypted documents/i);
  });
});
