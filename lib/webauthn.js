'use strict';

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const { pool, withTransaction } = require('./db');
const pki = require('./pki');

const REGISTRATION_TTL_MS = 10 * 60 * 1000;
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function stripPort(host = '') {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(1, end);
  }
  return host.split(':')[0];
}

function inferRequestProtocol(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwardedProto) return forwardedProto;
  return req.protocol || 'http';
}

function inferRequestOrigin(req) {
  const proto = inferRequestProtocol(req);
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function getExpectedOrigins(req) {
  const raw = String(process.env.WEBAUTHN_ALLOWED_ORIGINS || '').trim();
  if (!raw) return [inferRequestOrigin(req)];
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function getRPID(req) {
  const configured = String(process.env.WEBAUTHN_RP_ID || '').trim();
  if (configured) return configured;
  return stripPort(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
}

function getRPName() {
  return String(process.env.WEBAUTHN_RP_NAME || 'Home Source').trim() || 'Home Source';
}

function isSecureWebAuthnContext(req) {
  const protocol = inferRequestProtocol(req);
  const host = stripPort(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return protocol === 'https' || LOCALHOST_HOSTS.has(host);
}

async function cleanExpiredChallenges() {
  const { rowCount } = await pool.query(
    `DELETE FROM webauthn_challenges
     WHERE (expires_at <= NOW()) OR used_at IS NOT NULL`
  );
  return rowCount;
}

function mapRequestedMethodToAuthenticatorPreference(requestedMethod) {
  if (requestedMethod === 'security_key') return 'securityKey';
  if (requestedMethod === 'passkey') return 'localDevice';
  return undefined;
}

function deriveVerifiedProtectionTier({ requestedMethod, authenticatorAttachment, credentialDeviceType, credentialBackedUp }) {
  if (requestedMethod === 'security_key') return 'hardware';
  if (requestedMethod === 'passkey') return 'platform';
  if (authenticatorAttachment === 'platform') return 'platform';
  if (credentialDeviceType === 'multiDevice' || credentialBackedUp === true) return 'platform';
  return 'hardware';
}

async function createMemberKeyRegistrationOptions(req, member, existingCredentialIds = [], requestedMethod) {
  const rpID = getRPID(req);
  const expectedOrigin = getExpectedOrigins(req)[0];
  const prfSaltBytes = crypto.randomBytes(32);
  const prfSalt = isoBase64URL.fromBuffer(prfSaltBytes);
  const options = await generateRegistrationOptions({
    rpName: getRPName(),
    rpID,
    userName: `member-${member.id}-${member.name}`,
    userDisplayName: member.name,
    userID: Buffer.from(`member:${member.id}`, 'utf8'),
    attestationType: 'none',
    excludeCredentials: existingCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    preferredAuthenticatorType: mapRequestedMethodToAuthenticatorPreference(requestedMethod),
    supportedAlgorithmIDs: [-7, -257],
  });
  options.extensions = {
    ...(options.extensions || {}),
    prf: {
      eval: {
        first: prfSalt,
      },
    },
  };

  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE webauthn_challenges
       SET used_at = NOW()
       WHERE member_id = $1 AND purpose = 'member_key_registration' AND used_at IS NULL`,
      [member.id]
    );
    await client.query(
      `INSERT INTO webauthn_challenges
         (member_id, purpose, challenge, rp_id, expected_origin, prf_salt, requested_method, expires_at)
       VALUES ($1, 'member_key_registration', $2, $3, $4, $5, $6, $7)`,
      [member.id, options.challenge, rpID, expectedOrigin, prfSalt, requestedMethod, expiresAt]
    );
  });

  return {
    options,
    expires_at: expiresAt.toISOString(),
    rp_id: rpID,
    expected_origin: expectedOrigin,
    prf_salt: prfSalt,
  };
}

async function getPendingChallenge(memberId, purpose) {
  const { rows } = await pool.query(
    `SELECT *
     FROM webauthn_challenges
     WHERE member_id = $1
       AND purpose = $2
       AND used_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [memberId, purpose]
  );
  return rows[0] || null;
}

async function getCredentialById(memberId, credentialId) {
  const { rows } = await pool.query(
    `SELECT *
     FROM webauthn_credentials
     WHERE member_id = $1 AND credential_id = $2`,
    [memberId, credentialId]
  );
  return rows[0] || null;
}

async function completeMemberKeyRegistration(req, member, payload = {}) {
  const pending = await getPendingChallenge(member.id, 'member_key_registration');
  if (!pending) {
    throw new Error('No pending key registration found. Start the ceremony again.');
  }

  if (!payload.registration_response) {
    throw new Error('registration_response is required');
  }

  const expectedOrigins = getExpectedOrigins(req);
  const expectedRPID = getRPID(req);

  const verification = await verifyRegistrationResponse({
    response: payload.registration_response,
    expectedChallenge: pending.challenge,
    expectedOrigin: expectedOrigins.length === 1 ? expectedOrigins[0] : expectedOrigins,
    expectedRPID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('WebAuthn registration verification failed');
  }

  const { registrationInfo } = verification;
  const transports = Array.isArray(payload.transports)
    ? payload.transports.filter((value) => typeof value === 'string' && value.trim())
    : [];
  const clientAttachment = payload.client_authenticator_attachment === 'platform'
    ? 'platform'
    : (payload.client_authenticator_attachment === 'cross-platform' ? 'cross-platform' : null);
  const requestedMethod = pending.requested_method || 'security_key';
  const protectionTier = deriveVerifiedProtectionTier({
    requestedMethod,
    authenticatorAttachment: clientAttachment,
    credentialDeviceType: registrationInfo.credentialDeviceType,
    credentialBackedUp: registrationInfo.credentialBackedUp,
  });
  const prfEnabled = payload.client_extension_results?.prf?.enabled === true
    || payload.registration_response?.clientExtensionResults?.prf?.enabled === true;

  await withTransaction(async (client) => {
    const existing = await client.query(
      'SELECT member_id FROM webauthn_credentials WHERE credential_id = $1',
      [registrationInfo.credential.id]
    );
    if (existing.rows[0]) {
      if (Number(existing.rows[0].member_id) !== Number(member.id)) {
        throw new Error('This WebAuthn credential is already registered to another household member');
      }
      throw new Error('This WebAuthn credential has already been registered for this member');
    }
    await client.query(
      `INSERT INTO webauthn_credentials
         (member_id, credential_id, credential_public_key, registration_prf_salt, counter,
          credential_device_type, credential_backed_up, credential_attachment,
          credential_transports, requested_method, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        member.id,
        registrationInfo.credential.id,
        isoBase64URL.fromBuffer(registrationInfo.credential.publicKey),
        pending.prf_salt,
        registrationInfo.credential.counter,
        registrationInfo.credentialDeviceType,
        registrationInfo.credentialBackedUp,
        clientAttachment,
        JSON.stringify(transports),
        requestedMethod,
      ]
    );
    await client.query(
      'UPDATE webauthn_challenges SET used_at = NOW() WHERE id = $1',
      [pending.id]
    );
  });

  return {
    verification: {
      verified: true,
      credential_id: registrationInfo.credential.id,
      credential_device_type: registrationInfo.credentialDeviceType,
      credential_backed_up: registrationInfo.credentialBackedUp,
      requested_method: requestedMethod,
      expected_origin: registrationInfo.origin,
      rp_id: registrationInfo.rpID || expectedRPID,
      prf_enabled_on_create: prfEnabled,
      protection_tier_hint: protectionTier,
    },
  };
}

async function createMemberKeyAssertionOptions(req, member, credentialId) {
  const credential = await getCredentialById(member.id, credentialId);
  if (!credential) {
    throw new Error('Verified WebAuthn credential not found. Start the ceremony again.');
  }
  if (!credential.registration_prf_salt) {
    throw new Error('This WebAuthn credential is missing its registration PRF salt. Re-register the key.');
  }
  const rpID = getRPID(req);
  const expectedOrigin = getExpectedOrigins(req)[0];
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: [{ id: credential.credential_id }],
    userVerification: 'required',
    extensions: {
      prf: {
        evalByCredential: {
          [credential.credential_id]: {
            first: credential.registration_prf_salt,
          },
        },
      },
    },
  });
  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE webauthn_challenges
       SET used_at = NOW()
       WHERE member_id = $1 AND purpose = 'member_key_assertion' AND used_at IS NULL`,
      [member.id]
    );
    await client.query(
      `INSERT INTO webauthn_challenges
         (member_id, purpose, challenge, rp_id, expected_origin, prf_salt, requested_method, expires_at)
       VALUES ($1, 'member_key_assertion', $2, $3, $4, $5, $6, $7)`,
      [member.id, options.challenge, rpID, expectedOrigin, credential.registration_prf_salt, credential.requested_method, expiresAt]
    );
  });
  return {
    options,
    expires_at: expiresAt.toISOString(),
    rp_id: rpID,
    expected_origin: expectedOrigin,
    prf_salt: credential.registration_prf_salt,
  };
}

async function finalizeMemberKeyRegistration(req, member, payload = {}) {
  const pending = await getPendingChallenge(member.id, 'member_key_assertion');
  if (!pending) {
    throw new Error('No pending WebAuthn assertion found. Start the ceremony again.');
  }
  if (!payload.assertion_response || !payload.public_key || !payload.encrypted_private_key) {
    throw new Error('assertion_response, public_key, and encrypted_private_key are required');
  }
  const credentialId = payload.assertion_response?.id;
  if (!credentialId) {
    throw new Error('assertion_response.id is required');
  }
  const credential = await getCredentialById(member.id, credentialId);
  if (!credential) {
    throw new Error('WebAuthn credential not found for this member');
  }
  const expectedOrigins = getExpectedOrigins(req);
  const expectedRPID = getRPID(req);
  const verification = await verifyAuthenticationResponse({
    response: payload.assertion_response,
    expectedChallenge: pending.challenge,
    expectedOrigin: expectedOrigins.length === 1 ? expectedOrigins[0] : expectedOrigins,
    expectedRPID,
    credential: {
      id: credential.credential_id,
      publicKey: isoBase64URL.toBuffer(credential.credential_public_key),
      counter: Number(credential.counter || 0),
      transports: Array.isArray(credential.credential_transports) ? credential.credential_transports : [],
    },
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.authenticationInfo) {
    throw new Error('WebAuthn assertion verification failed');
  }
  const requestedMethod = credential.requested_method || pending.requested_method || 'security_key';
  const protectionTier = deriveVerifiedProtectionTier({
    requestedMethod,
    authenticatorAttachment: credential.credential_attachment,
    credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
    credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
  });
  const key = await pki.registerMemberKey({
    memberId: member.id,
    publicKey: payload.public_key,
    encryptedPrivateKey: payload.encrypted_private_key,
    algorithm: payload.algorithm || 'x25519',
    credentialId: credential.credential_id,
    prfEnabled: true,
    protectionTier,
    label: payload.label || null,
    credentialVerified: true,
    verificationMethod: 'webauthn',
    credentialTransports: credential.credential_transports,
    credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
    credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
    credentialAttachment: credential.credential_attachment,
    verifiedAt: new Date(),
  });
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE webauthn_credentials
       SET counter = $3,
           credential_device_type = $4,
           credential_backed_up = $5,
           last_used_at = NOW()
       WHERE member_id = $1 AND credential_id = $2`,
      [
        member.id,
        credential.credential_id,
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialDeviceType,
        verification.authenticationInfo.credentialBackedUp,
      ]
    );
    await client.query('UPDATE webauthn_challenges SET used_at = NOW() WHERE id = $1', [pending.id]);
  });
  return {
    key,
    verification: {
      verified: true,
      credential_id: credential.credential_id,
      credential_device_type: verification.authenticationInfo.credentialDeviceType,
      credential_backed_up: verification.authenticationInfo.credentialBackedUp,
      requested_method: requestedMethod,
      expected_origin: verification.authenticationInfo.origin,
      rp_id: verification.authenticationInfo.rpID || expectedRPID,
    },
  };
}

module.exports = {
  REGISTRATION_TTL_MS,
  createMemberKeyRegistrationOptions,
  completeMemberKeyRegistration,
  createMemberKeyAssertionOptions,
  finalizeMemberKeyRegistration,
  deriveVerifiedProtectionTier,
  getExpectedOrigins,
  getRPID,
  inferRequestOrigin,
  isSecureWebAuthnContext,
  cleanExpiredChallenges,
};
