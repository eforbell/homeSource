-- HomeSource Feature 13 Phase C2: immutable per-recipient delivery grants,
-- exact-item manifests, hashed access tokens, and durable recipient outbox rows.

ALTER TABLE continuity_delivery_runs
  ADD CONSTRAINT continuity_delivery_runs_id_packet_unique UNIQUE (id, packet_version_id);

CREATE TABLE continuity_delivery_grants (
  id SERIAL PRIMARY KEY,
  delivery_run_id INT NOT NULL,
  packet_version_id INT NOT NULL,
  packet_recipient_id INT NOT NULL,
  member_id INT REFERENCES family_members(id) ON DELETE RESTRICT,
  trustee_id INT REFERENCES vault_trustees(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('beneficiary', 'trustee')),
  member_contact_channel_id INT REFERENCES member_contact_channels(id) ON DELETE RESTRICT,
  trustee_contact_channel_id INT REFERENCES trustee_contact_channels(id) ON DELETE RESTRICT,
  destination_snapshot TEXT CHECK (
    destination_snapshot = LOWER(BTRIM(destination_snapshot))
    AND destination_snapshot !~ '[[:space:]]'
    AND LENGTH(destination_snapshot) BETWEEN 3 AND 320
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'expired')),
  blocked_reason_class TEXT CHECK (blocked_reason_class ~ '^[a-z0-9_]{1,80}$'),
  activated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (delivery_run_id, packet_version_id)
    REFERENCES continuity_delivery_runs(id, packet_version_id) ON DELETE CASCADE,
  FOREIGN KEY (packet_recipient_id, packet_version_id)
    REFERENCES continuity_packet_recipients(id, packet_version_id) ON DELETE RESTRICT,
  CHECK (
    (role = 'beneficiary' AND member_id IS NOT NULL AND trustee_id IS NULL
      AND trustee_contact_channel_id IS NULL)
    OR
    (role = 'trustee' AND member_id IS NULL AND trustee_id IS NOT NULL
      AND member_contact_channel_id IS NULL)
  ),
  CHECK (
    (status = 'active' AND activated_at IS NOT NULL AND expires_at IS NOT NULL
      AND destination_snapshot IS NOT NULL
      AND ((role = 'beneficiary' AND member_contact_channel_id IS NOT NULL)
        OR (role = 'trustee' AND trustee_contact_channel_id IS NOT NULL))
      AND blocked_at IS NULL AND blocked_reason_class IS NULL AND expired_at IS NULL)
    OR
    (status = 'blocked' AND activated_at IS NULL AND expires_at IS NULL
      AND blocked_at IS NOT NULL AND blocked_reason_class IS NOT NULL AND expired_at IS NULL)
    OR
    (status = 'expired' AND activated_at IS NOT NULL AND expires_at IS NOT NULL
      AND blocked_at IS NULL AND blocked_reason_class IS NULL AND expired_at IS NOT NULL)
  ),
  UNIQUE (delivery_run_id, packet_recipient_id),
  UNIQUE (id, delivery_run_id),
  UNIQUE (id, packet_version_id)
);
CREATE INDEX idx_continuity_delivery_grants_status
  ON continuity_delivery_grants (status, expires_at);

CREATE TABLE continuity_delivery_items (
  id SERIAL PRIMARY KEY,
  delivery_grant_id INT NOT NULL,
  packet_version_id INT NOT NULL,
  packet_document_id INT NOT NULL,
  item_ordinal INT NOT NULL CHECK (item_ordinal > 0),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('letter', 'selected')),
  eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('ready', 'blocked')),
  blocked_reason_class TEXT CHECK (blocked_reason_class ~ '^[a-z0-9_]{1,80}$'),
  document_file_id INT REFERENCES document_files(id) ON DELETE RESTRICT,
  designation_id INT REFERENCES document_designations(id) ON DELETE RESTRICT,
  encryption_key_id INT REFERENCES encryption_keys(id) ON DELETE RESTRICT,
  key_fingerprint TEXT,
  envelope_file_key TEXT,
  artifact_metadata JSONB,
  wrapped_dek JSONB,
  file_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (delivery_grant_id, packet_version_id)
    REFERENCES continuity_delivery_grants(id, packet_version_id) ON DELETE CASCADE,
  FOREIGN KEY (packet_document_id, packet_version_id)
    REFERENCES continuity_packet_documents(id, packet_version_id) ON DELETE RESTRICT,
  CHECK (
    (eligibility_status = 'ready' AND blocked_reason_class IS NULL
      AND document_file_id IS NOT NULL AND designation_id IS NOT NULL
      AND encryption_key_id IS NOT NULL AND key_fingerprint IS NOT NULL
      AND envelope_file_key IS NOT NULL AND artifact_metadata IS NOT NULL
      AND wrapped_dek IS NOT NULL AND file_sha256 ~ '^[a-f0-9]{64}$')
    OR
    (eligibility_status = 'blocked' AND blocked_reason_class IS NOT NULL)
  ),
  UNIQUE (delivery_grant_id, packet_document_id),
  UNIQUE (delivery_grant_id, item_ordinal)
);

CREATE TABLE continuity_delivery_tokens (
  id SERIAL PRIMARY KEY,
  delivery_grant_id INT NOT NULL REFERENCES continuity_delivery_grants(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'access' CHECK (purpose IN ('access')),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, delivery_grant_id)
);
CREATE UNIQUE INDEX idx_continuity_delivery_tokens_one_usable
  ON continuity_delivery_tokens (delivery_grant_id, purpose)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;
CREATE INDEX idx_continuity_delivery_tokens_expiry
  ON continuity_delivery_tokens (expires_at)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;

ALTER TABLE continuity_notification_outbox
  DROP CONSTRAINT continuity_outbox_trustee_shape,
  DROP CONSTRAINT continuity_notification_outbo_switch_id_schedule_cycle_noti_key,
  ADD COLUMN delivery_grant_id INT,
  ADD COLUMN delivery_token_id INT,
  ADD FOREIGN KEY (delivery_grant_id, delivery_run_id)
    REFERENCES continuity_delivery_grants(id, delivery_run_id) ON DELETE CASCADE,
  ADD FOREIGN KEY (delivery_token_id, delivery_grant_id)
    REFERENCES continuity_delivery_tokens(id, delivery_grant_id) ON DELETE SET NULL (delivery_token_id),
  ADD CONSTRAINT continuity_outbox_delivery_shape CHECK (
    (notification_type = 'trustee_verification'
      AND delivery_run_id IS NOT NULL AND delivery_run_trustee_id IS NOT NULL
      AND delivery_grant_id IS NULL AND delivery_token_id IS NULL)
    OR
    (notification_type = 'recipient_delivery'
      AND delivery_run_id IS NOT NULL AND delivery_run_trustee_id IS NULL
      AND trustee_action_token_id IS NULL AND delivery_grant_id IS NOT NULL)
    OR
    (notification_type NOT IN ('trustee_verification', 'recipient_delivery')
      AND delivery_run_id IS NULL AND delivery_run_trustee_id IS NULL
      AND trustee_action_token_id IS NULL AND delivery_grant_id IS NULL
      AND delivery_token_id IS NULL)
  );
CREATE UNIQUE INDEX idx_continuity_outbox_delivery_grant
  ON continuity_notification_outbox (delivery_grant_id, notification_type)
  WHERE delivery_grant_id IS NOT NULL;
CREATE UNIQUE INDEX idx_continuity_outbox_non_grant_dedupe
  ON continuity_notification_outbox (switch_id, schedule_cycle, notification_type, recipient_email)
  WHERE delivery_grant_id IS NULL;

CREATE FUNCTION enforce_continuity_delivery_grant_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'continuity delivery grants are durable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM continuity_packet_recipients recipient
      WHERE recipient.id = NEW.packet_recipient_id
        AND recipient.packet_version_id = NEW.packet_version_id
        AND recipient.role = NEW.role
        AND recipient.member_id IS NOT DISTINCT FROM NEW.member_id
        AND recipient.trustee_id IS NOT DISTINCT FROM NEW.trustee_id
    ) THEN
      RAISE EXCEPTION 'continuity delivery grant recipient does not match packet policy';
    END IF;
    IF NEW.member_contact_channel_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM member_contact_channels contact
      WHERE contact.id = NEW.member_contact_channel_id AND contact.member_id = NEW.member_id
        AND contact.channel_type = 'email' AND contact.status = 'verified'
        AND contact.normalized_address = NEW.destination_snapshot
    ) THEN
      RAISE EXCEPTION 'continuity delivery grant member contact does not match verified snapshot';
    END IF;
    IF NEW.trustee_contact_channel_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustee_contact_channels contact
      WHERE contact.id = NEW.trustee_contact_channel_id AND contact.trustee_id = NEW.trustee_id
        AND contact.channel_type = 'email' AND contact.status = 'verified'
        AND contact.normalized_address = NEW.destination_snapshot
    ) THEN
      RAISE EXCEPTION 'continuity delivery grant trustee contact does not match verified snapshot';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.delivery_run_id IS DISTINCT FROM OLD.delivery_run_id
     OR NEW.packet_version_id IS DISTINCT FROM OLD.packet_version_id
     OR NEW.packet_recipient_id IS DISTINCT FROM OLD.packet_recipient_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.trustee_id IS DISTINCT FROM OLD.trustee_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.member_contact_channel_id IS DISTINCT FROM OLD.member_contact_channel_id
     OR NEW.trustee_contact_channel_id IS DISTINCT FROM OLD.trustee_contact_channel_id
     OR NEW.destination_snapshot IS DISTINCT FROM OLD.destination_snapshot
     OR NEW.blocked_reason_class IS DISTINCT FROM OLD.blocked_reason_class
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.blocked_at IS DISTINCT FROM OLD.blocked_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'continuity delivery grant identity is immutable';
  END IF;
  IF NOT (NEW.status = OLD.status OR (OLD.status = 'active' AND NEW.status = 'expired')) THEN
    RAISE EXCEPTION 'invalid continuity delivery grant transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_delivery_grant_identity
  BEFORE INSERT OR UPDATE OR DELETE ON continuity_delivery_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_continuity_delivery_grant_identity();

CREATE FUNCTION reject_continuity_delivery_item_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'continuity delivery manifest items are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_delivery_items_immutable
  BEFORE UPDATE OR DELETE ON continuity_delivery_items
  FOR EACH ROW EXECUTE FUNCTION reject_continuity_delivery_item_update();
