-- HomeSource: MagicInsight foundation

CREATE TABLE magic_data (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'expiry_alert',
    'renewal_reminder',
    'document_quality',
    'household_insight'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical', 'warning', 'info')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document', 'member', 'household')),
  subject_id INT,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}',
  confidence NUMERIC(4,3),
  source_document_ids INT[] NOT NULL DEFAULT '{}',
  reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'dismissed', 'stale', 'resolved')),
  action_url TEXT,
  due_date DATE,
  expires_at TIMESTAMPTZ,
  scan_id TEXT,
  reviewed_by INT REFERENCES family_members(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  UNIQUE (category, dedupe_key)
);

CREATE INDEX idx_magic_data_category ON magic_data (category);
CREATE INDEX idx_magic_data_status ON magic_data (status) WHERE status IN ('new', 'accepted');
CREATE INDEX idx_magic_data_subject ON magic_data (subject_type, subject_id);
CREATE INDEX idx_magic_data_due ON magic_data (due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_magic_data_scan ON magic_data (scan_id);

CREATE TRIGGER trg_magic_data_updated_at
  BEFORE UPDATE ON magic_data
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
