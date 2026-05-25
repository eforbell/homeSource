-- HomeSource: split WebAuthn credential registration from PRF assertion-time key finalization

ALTER TABLE webauthn_challenges
  DROP CONSTRAINT IF EXISTS webauthn_challenges_purpose_check;

ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_purpose_check
  CHECK (purpose IN ('member_key_registration', 'member_key_assertion'));

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  credential_public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  credential_device_type TEXT NOT NULL CHECK (credential_device_type IN ('singleDevice', 'multiDevice')),
  credential_backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  credential_attachment TEXT CHECK (credential_attachment IN ('platform', 'cross-platform')),
  credential_transports JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_method TEXT CHECK (requested_method IN ('security_key', 'passkey')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_member
  ON webauthn_credentials (member_id, created_at DESC);
