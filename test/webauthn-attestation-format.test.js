'use strict';

// bugBase #151: a registration whose attestation format simplewebauthn ships roots for (apple, android-*)
// made the server fetch the CRL URL named in the client's own certificate. Only 'none' and 'packed' reach
// verification now.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const x509 = require('@peculiar/x509');
const { isoBase64URL, isoCBOR } = require('@simplewebauthn/server/helpers');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedPost, url } = require('./helpers');
const trustees = require('../lib/trustees');

x509.cryptoProvider.set(crypto.webcrypto);

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// A certificate whose CRL distribution point is the test's own listener.
async function certificateFetching(crlUrl) {
  const keys = await crypto.webcrypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'C=US, O=Test, OU=Authenticator Attestation, CN=Fetch Me',
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ECDSA,
    keys,
    extensions: [new x509.CRLDistributionPointsExtension([crlUrl])],
  });
  return Buffer.from(cert.rawData);
}

// What a browser would send for these options, with the attestation statement the test chooses.
function registrationResponse(options, { origin, fmt, attStmt = new Map() }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coseKey = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const rawId = crypto.randomBytes(16);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
  const authData = Buffer.concat([
    sha256(options.rp.id), Buffer.from([0x45]), Buffer.alloc(4), // user present + verified, attested data
    Buffer.alloc(16), Buffer.from([0, rawId.length]), rawId, Buffer.from(coseKey),
  ]);
  if (fmt === 'packed') {
    attStmt = new Map([['alg', -7], ['sig', crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey)]]);
  }
  const attestationObject = isoCBOR.encode(new Map([['fmt', fmt], ['attStmt', attStmt], ['authData', authData]]));
  const id = isoBase64URL.fromBuffer(rawId);
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: { clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON), attestationObject: isoBase64URL.fromBuffer(attestationObject), transports: ['usb'] },
    clientExtensionResults: {},
  };
}

describe('WebAuthn registration attestation formats', () => {
  let listener;
  let fetched;
  let crlCert;
  let parent;
  let parentCookie;

  before(async () => {
    await startServer();
    fetched = [];
    listener = http.createServer((req, res) => { fetched.push(req.url); res.end(); });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    crlCert = await certificateFetching(`http://127.0.0.1:${listener.address().port}/crl`);
  });

  after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    fetched.length = 0;
    parent = await createMember('Wendy', 'parent', 'pass123');
    parentCookie = await loginAs(parent, 'pass123');
  });

  const origin = () => new URL(url('')).origin;
  const certificateStatement = () => new Map([['alg', -7], ['sig', Buffer.alloc(64)], ['x5c', [crlCert]]]);

  async function memberRegistration(fmt, attStmt) {
    const started = await authedPost(`api/members/${parent.id}/keys/webauthn/options`, parentCookie, { requested_method: 'security_key' });
    const { options } = await started.json();
    return authedPost(`api/members/${parent.id}/keys/webauthn/complete`, parentCookie, {
      registration_response: registrationResponse(options, { origin: origin(), fmt, attStmt }),
    });
  }

  async function trusteeRegistration(fmt, attStmt) {
    const trustee = await trustees.createTrustee({ name: `Trustee ${fmt}`, email: `${fmt}@family.test`, createdBy: parent.id });
    const invitation = await trustees.createTrusteeInvitation({ trusteeId: trustee.id });
    const post = (path, body) => fetch(url(`api/trustee-invitations/${invitation.token}/webauthn/${path}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const { options } = await (await post('options', { requested_method: 'security_key' })).json();
    return post('complete', { registration_response: registrationResponse(options, { origin: origin(), fmt, attStmt }) });
  }

  for (const [route, register] of [['member', memberRegistration], ['trustee', trusteeRegistration]]) {
    it(`refuses other attestation formats on the ${route} route without fetching anything`, async () => {
      for (const fmt of ['apple', 'android-key', 'android-safetynet', 'tpm', 'fido-u2f']) {
        const res = await register(fmt, certificateStatement());
        assert.equal(res.status, 400, fmt);
        assert.match((await res.json()).error, /Unsupported attestation format/, fmt);
      }
      assert.deepEqual(fetched, []);
    });

    it(`still registers none and packed keys on the ${route} route`, async () => {
      for (const fmt of ['none', 'packed']) {
        const res = await register(fmt);
        assert.equal(res.status, 201, `${fmt}: ${JSON.stringify(await res.clone().json())}`);
        assert.equal((await res.json()).verification.verified, true, fmt);
      }
    });
  }

  it('refuses a registration response it cannot decode', async () => {
    const started = await authedPost(`api/members/${parent.id}/keys/webauthn/options`, parentCookie, { requested_method: 'passkey' });
    const { options } = await started.json();
    const response = registrationResponse(options, { origin: origin(), fmt: 'none' });
    response.response.attestationObject = 'AAAA';
    const res = await authedPost(`api/members/${parent.id}/keys/webauthn/complete`, parentCookie, { registration_response: response });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /malformed/);
  });
});
