-- HomeSource Feature 13 Phase C1: durable delivery runs, trustee notice
-- snapshots, purpose-bound pause tokens, and owner-recovery cutoff state.

ALTER TABLE continuity_switches DROP CONSTRAINT continuity_switches_status_check;
ALTER TABLE continuity_switches ADD CONSTRAINT continuity_switches_status_check CHECK (status IN (
  'draft', 'armed', 'paused', 'delivery_pending',
  'trustee_notification_pending', 'trustee_notification_blocked',
  'trustee_window', 'trustee_paused', 'recipient_delivery',
  'delivery_active', 'delivery_complete', 'delivery_blocked', 'cancelled'
));

CREATE TABLE continuity_delivery_runs (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  schedule_cycle BIGINT NOT NULL CHECK (schedule_cycle >= 0),
  packet_version_id INT NOT NULL REFERENCES continuity_packet_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'trustee_notification_pending', 'trustee_notification_blocked',
    'trustee_window', 'trustee_paused', 'recipient_delivery',
    'delivery_active', 'delivery_complete', 'delivery_blocked', 'owner_recovered'
  )),
  trustee_window_started_at TIMESTAMPTZ,
  trustee_action_deadline_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  pause_deadline_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  first_grant_activated_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (switch_id, schedule_cycle),
  CHECK (trustee_action_deadline_at IS NULL OR trustee_window_started_at IS NOT NULL),
  CHECK (pause_deadline_at IS NULL OR paused_at IS NOT NULL),
  CHECK (recovered_at IS NULL OR status = 'owner_recovered')
);
CREATE INDEX idx_continuity_delivery_runs_due
  ON continuity_delivery_runs (status, trustee_action_deadline_at, pause_deadline_at);

CREATE TABLE continuity_delivery_run_trustees (
  id SERIAL PRIMARY KEY,
  delivery_run_id INT NOT NULL REFERENCES continuity_delivery_runs(id) ON DELETE CASCADE,
  trustee_id INT NOT NULL REFERENCES vault_trustees(id) ON DELETE RESTRICT,
  contact_channel_id INT NOT NULL REFERENCES trustee_contact_channels(id) ON DELETE RESTRICT,
  destination_snapshot TEXT NOT NULL CHECK (
    destination_snapshot = LOWER(BTRIM(destination_snapshot))
    AND destination_snapshot !~ '[[:space:]]'
    AND LENGTH(destination_snapshot) BETWEEN 3 AND 320
  ),
  first_successful_send_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_run_id, trustee_id),
  UNIQUE (id, delivery_run_id)
);

CREATE TABLE continuity_trustee_action_tokens (
  id SERIAL PRIMARY KEY,
  delivery_run_id INT NOT NULL REFERENCES continuity_delivery_runs(id) ON DELETE CASCADE,
  delivery_run_trustee_id INT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'pause' CHECK (purpose IN ('pause')),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (delivery_run_trustee_id, delivery_run_id)
    REFERENCES continuity_delivery_run_trustees(id, delivery_run_id) ON DELETE CASCADE,
  UNIQUE (id, delivery_run_id, delivery_run_trustee_id)
);
CREATE UNIQUE INDEX idx_continuity_trustee_tokens_one_usable
  ON continuity_trustee_action_tokens (delivery_run_trustee_id, purpose)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;
CREATE INDEX idx_continuity_trustee_tokens_expiry
  ON continuity_trustee_action_tokens (expires_at)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;

ALTER TABLE continuity_notification_outbox
  ADD COLUMN delivery_run_id INT REFERENCES continuity_delivery_runs(id) ON DELETE CASCADE,
  ADD COLUMN delivery_run_trustee_id INT,
  ADD COLUMN trustee_action_token_id INT,
  ADD FOREIGN KEY (delivery_run_trustee_id, delivery_run_id)
    REFERENCES continuity_delivery_run_trustees(id, delivery_run_id) ON DELETE CASCADE,
  ADD FOREIGN KEY (trustee_action_token_id, delivery_run_id, delivery_run_trustee_id)
    REFERENCES continuity_trustee_action_tokens(id, delivery_run_id, delivery_run_trustee_id)
    ON DELETE SET NULL (trustee_action_token_id),
  ADD CONSTRAINT continuity_outbox_trustee_shape CHECK (
    (notification_type = 'trustee_verification'
      AND delivery_run_id IS NOT NULL AND delivery_run_trustee_id IS NOT NULL)
    OR
    (notification_type <> 'trustee_verification'
      AND delivery_run_id IS NULL AND delivery_run_trustee_id IS NULL
      AND trustee_action_token_id IS NULL)
  );
CREATE UNIQUE INDEX idx_continuity_outbox_run_trustee
  ON continuity_notification_outbox (delivery_run_id, delivery_run_trustee_id, notification_type)
  WHERE delivery_run_id IS NOT NULL;

CREATE FUNCTION enforce_continuity_delivery_run_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.switch_id IS DISTINCT FROM OLD.switch_id
     OR NEW.schedule_cycle IS DISTINCT FROM OLD.schedule_cycle
     OR NEW.packet_version_id IS DISTINCT FROM OLD.packet_version_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'continuity delivery run identity is immutable';
  END IF;
  IF OLD.first_grant_activated_at IS NOT NULL
     AND NEW.first_grant_activated_at IS DISTINCT FROM OLD.first_grant_activated_at THEN
    RAISE EXCEPTION 'continuity first grant activation boundary is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_delivery_run_identity
  BEFORE UPDATE ON continuity_delivery_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_continuity_delivery_run_identity();

CREATE FUNCTION enforce_continuity_run_trustee_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW.delivery_run_id IS DISTINCT FROM OLD.delivery_run_id
     OR NEW.trustee_id IS DISTINCT FROM OLD.trustee_id
     OR NEW.contact_channel_id IS DISTINCT FROM OLD.contact_channel_id
     OR NEW.destination_snapshot IS DISTINCT FROM OLD.destination_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'continuity delivery trustee snapshot is immutable';
  END IF;
  IF OLD.first_successful_send_at IS NOT NULL
     AND NEW.first_successful_send_at IS DISTINCT FROM OLD.first_successful_send_at THEN
    RAISE EXCEPTION 'continuity trustee notification success is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_run_trustee_snapshot
  BEFORE UPDATE ON continuity_delivery_run_trustees
  FOR EACH ROW EXECUTE FUNCTION enforce_continuity_run_trustee_snapshot();
