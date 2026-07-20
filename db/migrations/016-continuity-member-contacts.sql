-- HomeSource Feature 13 Phase C0.1: verified beneficiary email contacts.
-- These rows prove control of a delivery destination but grant no document access.

CREATE TABLE member_contact_channels (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email')),
  normalized_address TEXT NOT NULL CHECK (
    normalized_address = LOWER(BTRIM(normalized_address))
    AND normalized_address !~ '[[:space:]]'
    AND LENGTH(normalized_address) BETWEEN 3 AND 320
  ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'revoked')),
  created_by INT NOT NULL REFERENCES family_members(id),
  verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'pending' AND verified_at IS NULL AND revoked_at IS NULL)
    OR (status = 'verified' AND verified_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_member_contact_channels_one_current
  ON member_contact_channels (member_id, channel_type)
  WHERE status <> 'revoked';

CREATE UNIQUE INDEX idx_member_contact_channels_unique_current_address
  ON member_contact_channels (channel_type, normalized_address)
  WHERE status <> 'revoked';

CREATE INDEX idx_member_contact_channels_member_history
  ON member_contact_channels (member_id, created_at DESC);

CREATE TABLE member_contact_verification_tokens (
  id SERIAL PRIMARY KEY,
  contact_channel_id INT NOT NULL REFERENCES member_contact_channels(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'email_control'
    CHECK (purpose IN ('email_control')),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_member_contact_tokens_one_usable
  ON member_contact_verification_tokens (contact_channel_id, purpose)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;

CREATE INDEX idx_member_contact_tokens_expiry
  ON member_contact_verification_tokens (expires_at)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;

