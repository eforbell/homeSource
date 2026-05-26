-- HomeSource: WebAuthn-backed key registration ceremony support

ALTER TABLE encryption_keys
  ADD COLUMN IF NOT EXISTS credential_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verification_method TEXT NOT NULL DEFAULT 'manual'
    CHECK (verification_method IN ('manual', 'webauthn', 'passphrase')),
  ADD COLUMN IF NOT EXISTS credential_transports JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS credential_device_type TEXT
    CHECK (credential_device_type IN ('singleDevice', 'multiDevice')),
  ADD COLUMN IF NOT EXISTS credential_backed_up BOOLEAN,
  ADD COLUMN IF NOT EXISTS credential_attachment TEXT
    CHECK (credential_attachment IN ('platform', 'cross-platform')),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_wrapped_private_key TEXT,
  ADD COLUMN IF NOT EXISTS recovery_type TEXT
    CHECK (recovery_type IN ('mnemonic_bip39'));

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('member_key_registration')),
  challenge TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  expected_origin TEXT NOT NULL,
  prf_salt TEXT,
  requested_method TEXT
    CHECK (requested_method IN ('security_key', 'passkey')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_member_purpose
  ON webauthn_challenges (member_id, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires
  ON webauthn_challenges (expires_at);
