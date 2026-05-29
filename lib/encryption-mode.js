'use strict';

const ENCRYPTION_MODES = new Set(['plaintext', 'passphrase', 'timelock', 'pki']);

function normalizeEncryptionInput(input = {}) {
  const requestedMode = String(input.encryption_mode || 'plaintext').trim().toLowerCase();
  const encryptionMode = ENCRYPTION_MODES.has(requestedMode) ? requestedMode : null;
  if (!encryptionMode) {
    throw new Error('Invalid encryption_mode (expected plaintext, passphrase, timelock, or pki)');
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

  if (encryptionMode === 'pki') {
    const files = metadata.files;
    if (!files || typeof files !== 'object') {
      throw new Error('PKI envelope requires encryption_metadata.files');
    }
    const fileKeys = Object.keys(files);
    if (fileKeys.length === 0) {
      throw new Error('PKI envelope requires at least one file entry in encryption_metadata.files');
    }
    for (const key of fileKeys) {
      const entry = files[key];
      if (!Array.isArray(entry.holders) || entry.holders.length === 0) {
        throw new Error('PKI envelope requires a non-empty holders array for each file');
      }
      const hasLegacyWrappedDek = !!(entry.wrapped_dek && entry.wrapped_dek.kind === 'pki_x25519');
      const hasHolderLocalWrappedDek = entry.holders.every((holder) => holder?.wrapped_dek?.kind === 'pki_x25519');
      if (entry.holders.length === 1) {
        if (!hasLegacyWrappedDek && !hasHolderLocalWrappedDek) {
          throw new Error('PKI envelope requires wrapped_dek.kind = "pki_x25519" for single-holder entries');
        }
      } else if (!hasHolderLocalWrappedDek) {
        throw new Error('PKI envelope requires holder-local wrapped_dek.kind = "pki_x25519" for multi-holder entries');
      }
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
