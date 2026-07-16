-- HomeSource Feature 13 Phase B: authored continuity letter, check-in switch,
-- crash-safe scheduling, and operator-only reminder outbox.

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_type_check
  CHECK (source_type IN ('scan', 'upload', 'url_import', 'authored'));

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('active', 'archived', 'staged'));

CREATE TABLE continuity_switches (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  reminder_email TEXT NOT NULL,
  letter_document_id INT REFERENCES documents(id),
  staged_letter_document_id INT REFERENCES documents(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'armed', 'paused', 'delivery_pending', 'cancelled')),
  interval_days INT NOT NULL CHECK (interval_days IN (30, 90, 180)),
  grace_period_days INT NOT NULL DEFAULT 14
    CHECK (grace_period_days >= 7 AND grace_period_days < interval_days),
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

CREATE UNIQUE INDEX idx_continuity_switches_one_active_owner
  ON continuity_switches (owner_id) WHERE status <> 'cancelled';
CREATE INDEX idx_continuity_switches_due
  ON continuity_switches (next_checkin_due_at) WHERE status = 'armed';

CREATE TABLE continuity_recipients (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  member_id INT REFERENCES family_members(id),
  trustee_id INT REFERENCES vault_trustees(id),
  role TEXT NOT NULL CHECK (role IN ('beneficiary', 'trustee')),
  notification_order INT NOT NULL DEFAULT 1 CHECK (notification_order > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (role = 'beneficiary' AND member_id IS NOT NULL AND trustee_id IS NULL)
    OR (role = 'trustee' AND member_id IS NULL AND trustee_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_continuity_recipients_member
  ON continuity_recipients (switch_id, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX idx_continuity_recipients_trustee
  ON continuity_recipients (switch_id, trustee_id) WHERE trustee_id IS NOT NULL;

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
CREATE UNIQUE INDEX idx_continuity_tokens_one_usable
  ON continuity_checkin_tokens (switch_id)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;

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
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'blocked_configuration', 'superseded')),
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
CREATE INDEX idx_continuity_outbox_due
  ON continuity_notification_outbox (next_attempt_at, id)
  WHERE status IN ('pending', 'claimed');

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
CREATE INDEX idx_continuity_scheduler_runs_latest
  ON continuity_scheduler_runs (job_type, started_at DESC);
