-- HomeSource Feature 13 Phase C0.2b: durable, configuration-bound brrr
-- reminder attempts that remain independent from the Phase B email outbox.

CREATE TABLE continuity_brrr_outbox (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  event_id INT REFERENCES continuity_events(id) ON DELETE SET NULL,
  notification_channel_id INT REFERENCES member_notification_channels(id) ON DELETE SET NULL,
  schedule_cycle BIGINT NOT NULL,
  notification_type TEXT NOT NULL,
  channel_config_version BIGINT NOT NULL CHECK (channel_config_version > 0),
  target_fingerprint TEXT NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'blocked_configuration', 'superseded')),
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

CREATE INDEX idx_continuity_brrr_outbox_due
  ON continuity_brrr_outbox (next_attempt_at, id)
  WHERE status IN ('pending', 'claimed');
