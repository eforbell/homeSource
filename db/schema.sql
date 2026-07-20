-- HomeSource: Sovereign Family Document Vault — Initial Schema

-- ── Family members (suite standard) ─────────────────────────────────────────

CREATE TABLE family_members (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  avatar_emoji TEXT NOT NULL DEFAULT '👤',
  color TEXT,
  passphrase_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Auth sessions (suite standard) ──────────────────────────────────────────

CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions (token);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- ── App config (suite standard) ─────────────────────────────────────────────

CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ── Continuity trustees (external principals; no standing app sessions) ──────

CREATE TABLE vault_trustees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  relationship TEXT,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'registered', 'revoked')),
  created_by INT NOT NULL REFERENCES family_members(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registered_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_vault_trustees_email ON vault_trustees (LOWER(email));

CREATE TABLE trustee_invitations (
  id SERIAL PRIMARY KEY,
  trustee_id INT NOT NULL REFERENCES vault_trustees(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trustee_invitations_active
  ON trustee_invitations (trustee_id, expires_at)
  WHERE used_at IS NULL;

-- ── Encryption keys (day 2 — schema present from day 1) ─────────────────────

CREATE TABLE encryption_keys (
  id SERIAL PRIMARY KEY,
  key_type TEXT NOT NULL CHECK (key_type IN ('document', 'member', 'recovery', 'trustee')),
  public_key TEXT,
  encrypted_private_key TEXT,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  member_id INT REFERENCES family_members(id),
  trustee_id INT REFERENCES vault_trustees(id),
  credential_id TEXT,
  prf_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  key_fingerprint TEXT,
  protection_tier TEXT NOT NULL DEFAULT 'passphrase' CHECK (protection_tier IN ('hardware', 'platform', 'passphrase')),
  label TEXT,
  last_used_at TIMESTAMPTZ,
  credential_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_method TEXT NOT NULL DEFAULT 'manual' CHECK (verification_method IN ('manual', 'webauthn', 'passphrase')),
  credential_transports JSONB NOT NULL DEFAULT '[]'::jsonb,
  credential_device_type TEXT CHECK (credential_device_type IN ('singleDevice', 'multiDevice')),
  credential_backed_up BOOLEAN,
  credential_attachment TEXT CHECK (credential_attachment IN ('platform', 'cross-platform')),
  verified_at TIMESTAMPTZ,
  recovery_wrapped_private_key TEXT,
  recovery_type TEXT CHECK (recovery_type IN ('mnemonic_bip39')),
  CHECK (
    (key_type = 'member' AND member_id IS NOT NULL AND trustee_id IS NULL)
    OR (key_type = 'trustee' AND member_id IS NULL AND trustee_id IS NOT NULL)
    OR (key_type IN ('document', 'recovery') AND trustee_id IS NULL)
  )
);

CREATE UNIQUE INDEX idx_encryption_keys_member_fingerprint
  ON encryption_keys (member_id, key_fingerprint)
  WHERE key_type = 'member' AND revoked_at IS NULL;

CREATE UNIQUE INDEX idx_encryption_keys_trustee_fingerprint
  ON encryption_keys (trustee_id, key_fingerprint)
  WHERE key_type = 'trustee' AND revoked_at IS NULL;

CREATE TABLE webauthn_challenges (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES family_members(id) ON DELETE CASCADE,
  trustee_id INT REFERENCES vault_trustees(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('member_key_registration', 'member_key_assertion', 'trustee_key_registration', 'trustee_key_assertion')),
  challenge TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  expected_origin TEXT NOT NULL,
  prf_salt TEXT,
  requested_method TEXT CHECK (requested_method IN ('security_key', 'passkey')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((member_id IS NOT NULL AND trustee_id IS NULL) OR (member_id IS NULL AND trustee_id IS NOT NULL))
);

CREATE INDEX idx_webauthn_challenges_member_purpose
  ON webauthn_challenges (member_id, purpose, created_at DESC);

CREATE INDEX idx_webauthn_challenges_expires
  ON webauthn_challenges (expires_at);

CREATE INDEX idx_webauthn_challenges_trustee_purpose
  ON webauthn_challenges (trustee_id, purpose, created_at DESC)
  WHERE trustee_id IS NOT NULL;

CREATE TABLE webauthn_credentials (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES family_members(id) ON DELETE CASCADE,
  trustee_id INT REFERENCES vault_trustees(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  credential_public_key TEXT NOT NULL,
  registration_prf_salt TEXT,
  counter BIGINT NOT NULL DEFAULT 0,
  credential_device_type TEXT NOT NULL CHECK (credential_device_type IN ('singleDevice', 'multiDevice')),
  credential_backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  credential_attachment TEXT CHECK (credential_attachment IN ('platform', 'cross-platform')),
  credential_transports JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_method TEXT CHECK (requested_method IN ('security_key', 'passkey')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  CHECK ((member_id IS NOT NULL AND trustee_id IS NULL) OR (member_id IS NULL AND trustee_id IS NOT NULL))
);

CREATE INDEX idx_webauthn_credentials_member
  ON webauthn_credentials (member_id, created_at DESC);

CREATE INDEX idx_webauthn_credentials_trustee
  ON webauthn_credentials (trustee_id, created_at DESC)
  WHERE trustee_id IS NOT NULL;

-- ── Documents ───────────────────────────────────────────────────────────────

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'warranty', 'insurance', 'certificate', 'manual',
    'receipt', 'contract', 'medical', 'legal', 'tax',
    'identification', 'property', 'vehicle', 'notice', 'employment', 'other'
  )),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'scan', 'upload', 'url_import', 'authored'
  )),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'staged')),
  issued_date DATE,
  expiry_date DATE,
  metadata JSONB NOT NULL DEFAULT '{}',
  search_vector TSVECTOR,
  encryption_key_id INT REFERENCES encryption_keys(id),
  is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  encryption_mode TEXT NOT NULL DEFAULT 'plaintext' CHECK (encryption_mode IN ('plaintext', 'passphrase', 'timelock', 'pki')),
  encryption_metadata JSONB NOT NULL DEFAULT '{}',
  created_by INT REFERENCES family_members(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_type ON documents (document_type);
CREATE INDEX idx_documents_status ON documents (status);
CREATE INDEX idx_documents_expiry ON documents (expiry_date) WHERE expiry_date IS NOT NULL;
CREATE INDEX idx_documents_search ON documents USING GIN (search_vector);
CREATE INDEX idx_documents_created_by ON documents (created_by);

-- Auto-maintain search_vector
CREATE OR REPLACE FUNCTION documents_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.metadata::text, '')), 'C');
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_search
  BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_search_trigger();

-- ── Document files ──────────────────────────────────────────────────────────

CREATE TABLE document_files (
  id SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  file_type TEXT NOT NULL CHECK (file_type IN ('original', 'processed', 'thumbnail')),
  stored_filename TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  page_count INT,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_document_files_doc ON document_files (document_id);

-- ── Document owners (joint ownership model) ─────────────────────────────────

CREATE TABLE document_owners (
  id SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  ownership_type TEXT NOT NULL DEFAULT 'owner' CHECK (ownership_type IN (
    'owner', 'joint', 'beneficiary', 'custodian'
  )),
  UNIQUE (document_id, member_id)
);

CREATE INDEX idx_document_owners_member ON document_owners (member_id);

-- ── Continuity designation projection (envelope remains canonical) ──────────

CREATE TABLE document_designations (
  id SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  member_id INT REFERENCES family_members(id),
  trustee_id INT REFERENCES vault_trustees(id),
  role TEXT NOT NULL CHECK (role IN ('beneficiary', 'trustee')),
  sealed BOOLEAN NOT NULL DEFAULT TRUE,
  sealed_until TEXT NOT NULL DEFAULT 'deadman_trigger',
  encryption_key_id INT REFERENCES encryption_keys(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (role = 'beneficiary' AND member_id IS NOT NULL AND trustee_id IS NULL)
    OR (role = 'trustee' AND member_id IS NULL AND trustee_id IS NOT NULL)
  ),
  UNIQUE (document_id, encryption_key_id)
);

CREATE INDEX idx_document_designations_member ON document_designations (member_id)
  WHERE member_id IS NOT NULL;
CREATE INDEX idx_document_designations_trustee ON document_designations (trustee_id)
  WHERE trustee_id IS NOT NULL;

-- ── Continuity letter and check-in switch ───────────────────────────────────

CREATE TABLE continuity_switches (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  reminder_email TEXT NOT NULL,
  letter_document_id INT REFERENCES documents(id),
  staged_letter_document_id INT REFERENCES documents(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'armed', 'paused', 'delivery_pending',
    'trustee_notification_pending', 'trustee_notification_blocked',
    'trustee_window', 'trustee_paused', 'recipient_delivery',
    'delivery_active', 'delivery_complete', 'delivery_blocked', 'cancelled'
  )),
  interval_days INT NOT NULL CHECK (interval_days IN (30, 90, 180)),
  grace_period_days INT NOT NULL DEFAULT 14 CHECK (grace_period_days >= 7 AND grace_period_days < interval_days),
  schedule_cycle BIGINT NOT NULL DEFAULT 0 CHECK (schedule_cycle >= 0),
  last_checkin_at TIMESTAMPTZ,
  next_checkin_due_at TIMESTAMPTZ,
  delivery_pending_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (letter_document_id IS NULL OR letter_document_id <> staged_letter_document_id)
);
CREATE UNIQUE INDEX idx_continuity_switches_one_active_owner ON continuity_switches (owner_id) WHERE status <> 'cancelled';
CREATE INDEX idx_continuity_switches_due ON continuity_switches (next_checkin_due_at) WHERE status = 'armed';

CREATE TABLE continuity_recipients (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  member_id INT REFERENCES family_members(id),
  trustee_id INT REFERENCES vault_trustees(id),
  role TEXT NOT NULL CHECK (role IN ('beneficiary', 'trustee')),
  notification_order INT NOT NULL DEFAULT 1 CHECK (notification_order > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((role = 'beneficiary' AND member_id IS NOT NULL AND trustee_id IS NULL) OR (role = 'trustee' AND member_id IS NULL AND trustee_id IS NOT NULL))
);
CREATE UNIQUE INDEX idx_continuity_recipients_member ON continuity_recipients (switch_id, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX idx_continuity_recipients_trustee ON continuity_recipients (switch_id, trustee_id) WHERE trustee_id IS NOT NULL;

CREATE TABLE continuity_checkin_tokens (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  schedule_cycle BIGINT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_continuity_tokens_one_usable ON continuity_checkin_tokens (switch_id) WHERE consumed_at IS NULL AND replaced_at IS NULL;

CREATE TABLE continuity_events (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id INT REFERENCES family_members(id),
  schedule_cycle BIGINT NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_continuity_events_switch ON continuity_events (switch_id, occurred_at DESC);

CREATE TABLE continuity_notification_outbox (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  event_id INT REFERENCES continuity_events(id) ON DELETE SET NULL,
  schedule_cycle BIGINT NOT NULL,
  notification_type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'blocked_configuration', 'superseded')),
  message_id TEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by TEXT,
  claim_expires_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  last_error_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (switch_id, schedule_cycle, notification_type, recipient_email)
);
CREATE INDEX idx_continuity_outbox_due ON continuity_notification_outbox (next_attempt_at, id) WHERE status IN ('pending', 'claimed');

CREATE TABLE continuity_scheduler_runs (
  id SERIAL PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('state_advance', 'outbox_dispatch')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  claimed_count INT NOT NULL DEFAULT 0,
  transition_count INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  error_class TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_continuity_scheduler_runs_latest ON continuity_scheduler_runs (job_type, started_at DESC);

-- ── Verified continuity beneficiary contacts ───────────────────────────────

CREATE TABLE member_contact_channels (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email')),
  normalized_address TEXT NOT NULL CHECK (
    normalized_address = LOWER(BTRIM(normalized_address))
    AND normalized_address !~ '[[:space:]]'
    AND LENGTH(normalized_address) BETWEEN 3 AND 320
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'revoked')),
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
CREATE UNIQUE INDEX idx_member_contact_channels_one_current ON member_contact_channels (member_id, channel_type) WHERE status <> 'revoked';
CREATE UNIQUE INDEX idx_member_contact_channels_unique_current_address ON member_contact_channels (channel_type, normalized_address) WHERE status <> 'revoked';
CREATE INDEX idx_member_contact_channels_member_history ON member_contact_channels (member_id, created_at DESC);

CREATE TABLE member_contact_verification_tokens (
  id SERIAL PRIMARY KEY,
  contact_channel_id INT NOT NULL REFERENCES member_contact_channels(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'email_control' CHECK (purpose IN ('email_control')),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_member_contact_tokens_one_usable ON member_contact_verification_tokens (contact_channel_id, purpose) WHERE consumed_at IS NULL AND replaced_at IS NULL;
CREATE INDEX idx_member_contact_tokens_expiry ON member_contact_verification_tokens (expires_at) WHERE consumed_at IS NULL AND replaced_at IS NULL;

CREATE TABLE trustee_contact_channels (
  id SERIAL PRIMARY KEY,
  trustee_id INT NOT NULL REFERENCES vault_trustees(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email')),
  normalized_address TEXT NOT NULL CHECK (normalized_address = LOWER(BTRIM(normalized_address)) AND normalized_address !~ '[[:space:]]' AND LENGTH(normalized_address) BETWEEN 3 AND 320),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'revoked')),
  verification_source TEXT CHECK (verification_source IN ('trustee_registration', 'contact_verification')),
  verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'pending' AND verified_at IS NULL AND revoked_at IS NULL) OR (status = 'verified' AND verified_at IS NOT NULL AND revoked_at IS NULL AND verification_source IS NOT NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX idx_trustee_contact_channels_one_verified ON trustee_contact_channels (trustee_id, channel_type) WHERE status = 'verified';
CREATE UNIQUE INDEX idx_trustee_contact_channels_one_pending ON trustee_contact_channels (trustee_id, channel_type) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_trustee_contact_channels_unique_active_address ON trustee_contact_channels (channel_type, normalized_address) WHERE status <> 'revoked';
CREATE INDEX idx_trustee_contact_channels_history ON trustee_contact_channels (trustee_id, created_at DESC);

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
CREATE UNIQUE INDEX idx_trustee_contact_tokens_one_usable ON trustee_contact_verification_tokens (contact_channel_id, purpose) WHERE consumed_at IS NULL AND replaced_at IS NULL;
CREATE INDEX idx_trustee_contact_tokens_expiry ON trustee_contact_verification_tokens (expires_at) WHERE consumed_at IS NULL AND replaced_at IS NULL;

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
CREATE UNIQUE INDEX idx_continuity_operator_attestations_one_current ON continuity_operator_channel_attestations (switch_id, channel_type) WHERE replaced_at IS NULL;
CREATE INDEX idx_continuity_operator_attestations_expiry ON continuity_operator_channel_attestations (expires_at) WHERE replaced_at IS NULL AND acknowledged_at IS NULL;

CREATE TABLE continuity_brrr_outbox (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  event_id INT REFERENCES continuity_events(id) ON DELETE SET NULL,
  notification_channel_id INT REFERENCES member_notification_channels(id) ON DELETE SET NULL,
  schedule_cycle BIGINT NOT NULL,
  notification_type TEXT NOT NULL,
  channel_config_version BIGINT NOT NULL CHECK (channel_config_version > 0),
  target_fingerprint TEXT NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'blocked_configuration', 'superseded')),
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by TEXT,
  claim_expires_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  last_error_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (switch_id, schedule_cycle, notification_type, notification_channel_id)
);
CREATE INDEX idx_continuity_brrr_outbox_due ON continuity_brrr_outbox (next_attempt_at, id) WHERE status IN ('pending', 'claimed');

CREATE TABLE continuity_packet_versions (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  version_number BIGINT NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'active', 'superseded')),
  letter_document_id INT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  operation_key TEXT NOT NULL CHECK (LENGTH(operation_key) BETWEEN 1 AND 120),
  created_by INT NOT NULL REFERENCES family_members(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), activated_at TIMESTAMPTZ, superseded_at TIMESTAMPTZ,
  UNIQUE (switch_id, version_number), UNIQUE (switch_id, operation_key),
  CHECK ((status = 'staged' AND activated_at IS NULL AND superseded_at IS NULL) OR (status = 'active' AND activated_at IS NOT NULL AND superseded_at IS NULL) OR (status = 'superseded' AND superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX idx_continuity_packet_one_staged ON continuity_packet_versions (switch_id) WHERE status = 'staged';
CREATE UNIQUE INDEX idx_continuity_packet_one_active ON continuity_packet_versions (switch_id) WHERE status = 'active';

CREATE TABLE continuity_packet_documents (
  id SERIAL PRIMARY KEY, packet_version_id INT NOT NULL REFERENCES continuity_packet_versions(id) ON DELETE CASCADE,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('letter', 'selected')), packet_order INT NOT NULL CHECK (packet_order > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (packet_version_id, document_id), UNIQUE (packet_version_id, packet_order), UNIQUE (id, packet_version_id)
);
CREATE UNIQUE INDEX idx_continuity_packet_one_letter ON continuity_packet_documents (packet_version_id) WHERE item_kind = 'letter';

CREATE TABLE continuity_packet_recipients (
  id SERIAL PRIMARY KEY, packet_version_id INT NOT NULL REFERENCES continuity_packet_versions(id) ON DELETE CASCADE,
  member_id INT REFERENCES family_members(id), trustee_id INT REFERENCES vault_trustees(id),
  role TEXT NOT NULL CHECK (role IN ('beneficiary', 'trustee')), packet_order INT NOT NULL CHECK (packet_order > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((role = 'beneficiary' AND member_id IS NOT NULL AND trustee_id IS NULL) OR (role = 'trustee' AND member_id IS NULL AND trustee_id IS NOT NULL)),
  UNIQUE (packet_version_id, packet_order), UNIQUE (id, packet_version_id)
);
CREATE UNIQUE INDEX idx_continuity_packet_recipient_member ON continuity_packet_recipients (packet_version_id, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX idx_continuity_packet_recipient_trustee ON continuity_packet_recipients (packet_version_id, trustee_id) WHERE trustee_id IS NOT NULL;

CREATE TABLE continuity_packet_recipient_documents (
  id SERIAL PRIMARY KEY,
  packet_version_id INT NOT NULL REFERENCES continuity_packet_versions(id) ON DELETE CASCADE,
  packet_recipient_id INT NOT NULL, packet_document_id INT NOT NULL,
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('covered', 'not_designated')),
  designation_id INT REFERENCES document_designations(id) ON DELETE RESTRICT,
  encryption_key_id INT REFERENCES encryption_keys(id) ON DELETE RESTRICT, key_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (packet_recipient_id, packet_document_id),
  FOREIGN KEY (packet_recipient_id, packet_version_id) REFERENCES continuity_packet_recipients(id, packet_version_id) ON DELETE CASCADE,
  FOREIGN KEY (packet_document_id, packet_version_id) REFERENCES continuity_packet_documents(id, packet_version_id) ON DELETE CASCADE,
  CHECK ((coverage_status = 'covered' AND designation_id IS NOT NULL AND encryption_key_id IS NOT NULL AND key_fingerprint IS NOT NULL) OR (coverage_status = 'not_designated' AND designation_id IS NULL AND encryption_key_id IS NULL AND key_fingerprint IS NULL))
);

CREATE TABLE continuity_switch_trustees (
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  trustee_id INT NOT NULL REFERENCES vault_trustees(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (switch_id, trustee_id)
);

ALTER TABLE continuity_switches ADD COLUMN staged_packet_version_id INT REFERENCES continuity_packet_versions(id) ON DELETE SET NULL;
ALTER TABLE continuity_switches ADD COLUMN active_packet_version_id INT REFERENCES continuity_packet_versions(id) ON DELETE SET NULL;
ALTER TABLE continuity_switches ADD CONSTRAINT continuity_switch_packet_pointer_check CHECK (staged_packet_version_id IS NULL OR staged_packet_version_id <> active_packet_version_id);

CREATE FUNCTION reject_continuity_packet_child_update() RETURNS trigger AS $$ BEGIN IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF; RAISE EXCEPTION 'continuity packet policy rows are immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_packet_documents_immutable BEFORE UPDATE OR DELETE ON continuity_packet_documents FOR EACH ROW EXECUTE FUNCTION reject_continuity_packet_child_update();
CREATE TRIGGER trg_continuity_packet_recipients_immutable BEFORE UPDATE OR DELETE ON continuity_packet_recipients FOR EACH ROW EXECUTE FUNCTION reject_continuity_packet_child_update();
CREATE TRIGGER trg_continuity_packet_coverage_immutable BEFORE UPDATE OR DELETE ON continuity_packet_recipient_documents FOR EACH ROW EXECUTE FUNCTION reject_continuity_packet_child_update();

CREATE FUNCTION enforce_continuity_packet_version_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF; RAISE EXCEPTION 'continuity packet versions are immutable'; END IF;
  IF NEW.switch_id IS DISTINCT FROM OLD.switch_id OR NEW.version_number IS DISTINCT FROM OLD.version_number OR NEW.letter_document_id IS DISTINCT FROM OLD.letter_document_id OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash OR NEW.operation_key IS DISTINCT FROM OLD.operation_key OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'continuity packet version identity is immutable'; END IF;
  IF NOT ((OLD.status = 'staged' AND NEW.status IN ('active', 'superseded')) OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN RAISE EXCEPTION 'invalid continuity packet version transition'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_packet_version_transition BEFORE UPDATE OR DELETE ON continuity_packet_versions FOR EACH ROW EXECUTE FUNCTION enforce_continuity_packet_version_transition();

-- ── Continuity trustee verification window ─────────────────────────────────

CREATE TABLE continuity_delivery_runs (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  schedule_cycle BIGINT NOT NULL CHECK (schedule_cycle >= 0),
  packet_version_id INT NOT NULL REFERENCES continuity_packet_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('trustee_notification_pending', 'trustee_notification_blocked', 'trustee_window', 'trustee_paused', 'recipient_delivery', 'delivery_active', 'delivery_complete', 'delivery_blocked', 'owner_recovered')),
  trustee_window_started_at TIMESTAMPTZ, trustee_action_deadline_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ, pause_deadline_at TIMESTAMPTZ, released_at TIMESTAMPTZ,
  first_grant_activated_at TIMESTAMPTZ, recovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (switch_id, schedule_cycle),
  CHECK (trustee_action_deadline_at IS NULL OR trustee_window_started_at IS NOT NULL),
  CHECK (pause_deadline_at IS NULL OR paused_at IS NOT NULL),
  CHECK (recovered_at IS NULL OR status = 'owner_recovered')
);
CREATE INDEX idx_continuity_delivery_runs_due ON continuity_delivery_runs (status, trustee_action_deadline_at, pause_deadline_at);

CREATE TABLE continuity_delivery_run_trustees (
  id SERIAL PRIMARY KEY,
  delivery_run_id INT NOT NULL REFERENCES continuity_delivery_runs(id) ON DELETE CASCADE,
  trustee_id INT NOT NULL REFERENCES vault_trustees(id) ON DELETE RESTRICT,
  contact_channel_id INT NOT NULL REFERENCES trustee_contact_channels(id) ON DELETE RESTRICT,
  destination_snapshot TEXT NOT NULL CHECK (destination_snapshot = LOWER(BTRIM(destination_snapshot)) AND destination_snapshot !~ '[[:space:]]' AND LENGTH(destination_snapshot) BETWEEN 3 AND 320),
  first_successful_send_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_run_id, trustee_id), UNIQUE (id, delivery_run_id)
);

CREATE TABLE continuity_trustee_action_tokens (
  id SERIAL PRIMARY KEY,
  delivery_run_id INT NOT NULL REFERENCES continuity_delivery_runs(id) ON DELETE CASCADE,
  delivery_run_trustee_id INT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'pause' CHECK (purpose IN ('pause')),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (delivery_run_trustee_id, delivery_run_id) REFERENCES continuity_delivery_run_trustees(id, delivery_run_id) ON DELETE CASCADE,
  UNIQUE (id, delivery_run_id, delivery_run_trustee_id)
);
CREATE UNIQUE INDEX idx_continuity_trustee_tokens_one_usable ON continuity_trustee_action_tokens (delivery_run_trustee_id, purpose) WHERE consumed_at IS NULL AND replaced_at IS NULL;
CREATE INDEX idx_continuity_trustee_tokens_expiry ON continuity_trustee_action_tokens (expires_at) WHERE consumed_at IS NULL AND replaced_at IS NULL;

ALTER TABLE continuity_notification_outbox
  ADD COLUMN delivery_run_id INT REFERENCES continuity_delivery_runs(id) ON DELETE CASCADE,
  ADD COLUMN delivery_run_trustee_id INT,
  ADD COLUMN trustee_action_token_id INT,
  ADD FOREIGN KEY (delivery_run_trustee_id, delivery_run_id) REFERENCES continuity_delivery_run_trustees(id, delivery_run_id) ON DELETE CASCADE,
  ADD FOREIGN KEY (trustee_action_token_id, delivery_run_id, delivery_run_trustee_id) REFERENCES continuity_trustee_action_tokens(id, delivery_run_id, delivery_run_trustee_id) ON DELETE SET NULL (trustee_action_token_id),
  ADD CONSTRAINT continuity_outbox_trustee_shape CHECK (
    (notification_type = 'trustee_verification' AND delivery_run_id IS NOT NULL AND delivery_run_trustee_id IS NOT NULL)
    OR (notification_type <> 'trustee_verification' AND delivery_run_id IS NULL AND delivery_run_trustee_id IS NULL AND trustee_action_token_id IS NULL)
  );
CREATE UNIQUE INDEX idx_continuity_outbox_run_trustee ON continuity_notification_outbox (delivery_run_id, delivery_run_trustee_id, notification_type) WHERE delivery_run_id IS NOT NULL;

CREATE FUNCTION enforce_continuity_delivery_run_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.switch_id IS DISTINCT FROM OLD.switch_id OR NEW.schedule_cycle IS DISTINCT FROM OLD.schedule_cycle OR NEW.packet_version_id IS DISTINCT FROM OLD.packet_version_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'continuity delivery run identity is immutable'; END IF;
  IF OLD.first_grant_activated_at IS NOT NULL AND NEW.first_grant_activated_at IS DISTINCT FROM OLD.first_grant_activated_at THEN RAISE EXCEPTION 'continuity first grant activation boundary is immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_delivery_run_identity BEFORE UPDATE ON continuity_delivery_runs FOR EACH ROW EXECUTE FUNCTION enforce_continuity_delivery_run_identity();

CREATE FUNCTION enforce_continuity_run_trustee_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW.delivery_run_id IS DISTINCT FROM OLD.delivery_run_id OR NEW.trustee_id IS DISTINCT FROM OLD.trustee_id OR NEW.contact_channel_id IS DISTINCT FROM OLD.contact_channel_id OR NEW.destination_snapshot IS DISTINCT FROM OLD.destination_snapshot OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'continuity delivery trustee snapshot is immutable'; END IF;
  IF OLD.first_successful_send_at IS NOT NULL AND NEW.first_successful_send_at IS DISTINCT FROM OLD.first_successful_send_at THEN RAISE EXCEPTION 'continuity trustee notification success is immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_run_trustee_snapshot BEFORE UPDATE ON continuity_delivery_run_trustees FOR EACH ROW EXECUTE FUNCTION enforce_continuity_run_trustee_snapshot();

-- ── Tags ────────────────────────────────────────────────────────────────────

CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#6b7280'
);

CREATE TABLE document_tags (
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);

-- ── Share links ─────────────────────────────────────────────────────────────

CREATE TABLE share_links (
  id SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by INT NOT NULL REFERENCES family_members(id),
  access_level TEXT NOT NULL DEFAULT 'view' CHECK (access_level IN ('view', 'download')),
  pin_hash TEXT,
  expires_at TIMESTAMPTZ,
  max_uses INT,
  use_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_share_links_token ON share_links (token);
CREATE INDEX idx_share_links_doc ON share_links (document_id);

-- ── Backup log ──────────────────────────────────────────────────────────────

CREATE TABLE backup_log (
  id SERIAL PRIMARY KEY,
  backup_type TEXT NOT NULL CHECK (backup_type IN ('full', 'metadata_only')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  file_path TEXT,
  file_size_bytes BIGINT,
  document_count INT,
  encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

-- ── Audit log ───────────────────────────────────────────────────────────────

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INT,
  actor_id INT REFERENCES family_members(id),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_action ON audit_log (action);
CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_log_actor ON audit_log (actor_id);

-- ── Default backup policy ───────────────────────────────────────────────────

INSERT INTO app_config (key, value) VALUES
  ('backup_policy', '{"frequency_days": 30, "notify_overdue_days": 7, "encrypt_backups": false}');

-- ── Smart Batch Import + MagicIndex foundation ──────────────────────────────

CREATE TABLE import_batches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('browser_files','browser_directory','server_folder','url_list')),
  source_label TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','completed','completed_with_errors','failed','cancelled')),
  options JSONB NOT NULL DEFAULT '{}',
  created_by INT REFERENCES family_members(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE import_items (
  id SERIAL PRIMARY KEY,
  batch_id INT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  document_id INT REFERENCES documents(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  relative_path TEXT,
  source_uri TEXT,
  mime_type TEXT,
  file_size_bytes BIGINT,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN (
    'staged','queued','stored','thumbnail_pending','thumbnail_done','magicindex_pending',
    'magicindex_done','review_ready','imported','skipped_duplicate','failed','cancelled'
  )),
  error_message TEXT,
  magicindex_result JSONB,
  magicindex_confidence NUMERIC(4,3),
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, relative_path, original_filename)
);

ALTER TABLE document_files ADD COLUMN IF NOT EXISTS sha256 TEXT;
CREATE INDEX idx_document_files_sha256 ON document_files (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_import_items_batch_status ON import_items (batch_id, status);
CREATE INDEX idx_import_items_sha256 ON import_items (sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE processing_jobs (
  id SERIAL PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('store_import_item','thumbnail','magicindex')),
  import_item_id INT REFERENCES import_items(id) ON DELETE CASCADE,
  document_id INT REFERENCES documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  payload JSONB NOT NULL DEFAULT '{}',
  attempts INT NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_processing_jobs_pickup ON processing_jobs (status, run_after, id);
CREATE INDEX idx_processing_jobs_item ON processing_jobs (import_item_id);
CREATE INDEX idx_processing_jobs_document ON processing_jobs (document_id);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_import_batches_updated_at
  BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_import_items_updated_at
  BEFORE UPDATE ON import_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_processing_jobs_updated_at
  BEFORE UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
