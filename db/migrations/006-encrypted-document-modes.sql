ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS encryption_mode TEXT NOT NULL DEFAULT 'plaintext'
  CHECK (encryption_mode IN ('plaintext', 'passphrase', 'timelock'));

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS encryption_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
