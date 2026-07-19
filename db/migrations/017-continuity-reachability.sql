-- HomeSource Feature 13 Phase C0.2: reusable trustee contacts, write-only
-- operator brrr targets, and configuration-bound reachability evidence.

CREATE TABLE trustee_contact_channels (
  id SERIAL PRIMARY KEY,
  trustee_id INT NOT NULL REFERENCES vault_trustees(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email')),
  normalized_address TEXT NOT NULL CHECK (
    normalized_address = LOWER(BTRIM(normalized_address))
    AND normalized_address !~ '[[:space:]]'
    AND LENGTH(normalized_address) BETWEEN 3 AND 320
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'revoked')),
  verification_source TEXT CHECK (verification_source IN ('trustee_registration', 'contact_verification')),
  verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'pending' AND verified_at IS NULL AND revoked_at IS NULL)
    OR (status = 'verified' AND verified_at IS NOT NULL AND revoked_at IS NULL AND verification_source IS NOT NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_trustee_contact_channels_one_current
  ON trustee_contact_channels (trustee_id, channel_type) WHERE status <> 'revoked';

CREATE TABLE member_notification_channels (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('brrr')),
  label TEXT,
  target_secret TEXT,
  target_fingerprint TEXT CHECK (target_fingerprint IS NULL OR target_fingerprint ~ '^[a-f0-9]{64}$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config_version BIGINT NOT NULL DEFAULT 1 CHECK (config_version > 0),
  transport_tested_at TIMESTAMPTZ,
  last_transport_status TEXT CHECK (last_transport_status IN ('accepted', 'failed')),
  last_transport_error_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (member_id, channel_type),
  CHECK (NOT enabled OR (target_secret IS NOT NULL AND target_fingerprint IS NOT NULL))
);

CREATE TABLE continuity_operator_channel_attestations (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  owner_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email', 'brrr')),
  configuration_version TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  challenge_hash TEXT NOT NULL UNIQUE CHECK (challenge_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  transport_accepted_at TIMESTAMPTZ,
  transport_error_class TEXT,
  acknowledged_at TIMESTAMPTZ,
  replaced_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_continuity_operator_attestations_one_current
  ON continuity_operator_channel_attestations (switch_id, channel_type)
  WHERE replaced_at IS NULL;
CREATE INDEX idx_continuity_operator_attestations_expiry
  ON continuity_operator_channel_attestations (expires_at)
  WHERE replaced_at IS NULL AND acknowledged_at IS NULL;

