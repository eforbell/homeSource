-- HomeSource Feature 13 Phase C0.2b: prove trustee email replacements before
-- switching the durable contact, while retaining the prior verified history.

DROP INDEX idx_trustee_contact_channels_one_current;

CREATE UNIQUE INDEX idx_trustee_contact_channels_one_verified
  ON trustee_contact_channels (trustee_id, channel_type)
  WHERE status = 'verified';

CREATE UNIQUE INDEX idx_trustee_contact_channels_one_pending
  ON trustee_contact_channels (trustee_id, channel_type)
  WHERE status = 'pending';

CREATE UNIQUE INDEX idx_trustee_contact_channels_unique_active_address
  ON trustee_contact_channels (channel_type, normalized_address)
  WHERE status <> 'revoked';

CREATE INDEX idx_trustee_contact_channels_history
  ON trustee_contact_channels (trustee_id, created_at DESC);

CREATE TABLE trustee_contact_verification_tokens (
  id SERIAL PRIMARY KEY,
  contact_channel_id INT NOT NULL REFERENCES trustee_contact_channels(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'email_control' CHECK (purpose IN ('email_control')),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_trustee_contact_tokens_one_usable
  ON trustee_contact_verification_tokens (contact_channel_id, purpose)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;

CREATE INDEX idx_trustee_contact_tokens_expiry
  ON trustee_contact_verification_tokens (expires_at)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;
