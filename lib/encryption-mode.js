'use strict';

const ENCRYPTION_MODES = new Set(['plaintext', 'passphrase', 'timelock']);

function normalizeEncryptionInput(input = {}) {
  const requestedMode = String(input.encryption_mode || 'plaintext').trim().toLowerCase();
  const encryptionMode = ENCRYPTION_MODES.has(requestedMode) ? requestedMode : null;
  if (!encryptionMode) {
    throw new Error('Invalid encryption_mode (expected plaintext, passphrase, or timelock)');
  }

  const metadata = input.encryption_metadata && typeof input.encryption_metadata === 'object'
    ? input.encryption_metadata
    : {};

  const modeFromMetadata = typeof metadata.mode === 'string' ? metadata.mode.trim().toLowerCase() : null;
  if (modeFromMetadata && modeFromMetadata !== encryptionMode) {
    throw new Error('encryption_mode must match encryption_metadata.mode');
  }

  const isEncrypted = encryptionMode !== 'plaintext';
  if (isEncrypted) {
    if (!metadata || typeof metadata !== 'object' || Number(metadata.version) !== 1) {
      throw new Error('encryption_metadata.version = 1 is required for encrypted uploads');
    }
  }
  return {
    is_encrypted: isEncrypted,
    encryption_mode: encryptionMode,
    encryption_metadata: isEncrypted ? metadata : {}
  };
}

function isEncryptedDocument(doc) {
  if (!doc) return false;
  return doc.is_encrypted === true || (typeof doc.encryption_mode === 'string' && doc.encryption_mode !== 'plaintext');
}

module.exports = {
  ENCRYPTION_MODES,
  normalizeEncryptionInput,
  isEncryptedDocument
};
