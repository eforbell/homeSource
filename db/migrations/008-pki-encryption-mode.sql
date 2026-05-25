-- Add 'pki' to encryption_mode
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_encryption_mode_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_encryption_mode_check CHECK (
    encryption_mode IN ('plaintext', 'passphrase', 'timelock', 'pki')
  );

-- Extend encryption_keys for WebAuthn credential tracking
ALTER TABLE encryption_keys
  ADD COLUMN IF NOT EXISTS member_id INT REFERENCES family_members(id),
  ADD COLUMN IF NOT EXISTS credential_id TEXT,
  ADD COLUMN IF NOT EXISTS prf_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS key_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS protection_tier TEXT NOT NULL DEFAULT 'passphrase'
    CHECK (protection_tier IN ('hardware', 'platform', 'passphrase')),
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
