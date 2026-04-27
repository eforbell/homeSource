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

-- ── Encryption keys (day 2 — schema present from day 1) ─────────────────────

CREATE TABLE encryption_keys (
  id SERIAL PRIMARY KEY,
  key_type TEXT NOT NULL CHECK (key_type IN ('document', 'member', 'recovery')),
  public_key TEXT,
  encrypted_private_key TEXT,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

-- ── Key holders (multi-sig support, day 2) ──────────────────────────────────

CREATE TABLE key_holders (
  id SERIAL PRIMARY KEY,
  encryption_key_id INT NOT NULL REFERENCES encryption_keys(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'cosigner', 'recovery')),
  encrypted_key_share TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (encryption_key_id, member_id)
);

-- ── Documents ───────────────────────────────────────────────────────────────

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'warranty', 'insurance', 'certificate', 'manual',
    'receipt', 'contract', 'medical', 'legal', 'tax',
    'identification', 'property', 'vehicle', 'other'
  )),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'scan', 'upload', 'url_import'
  )),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  issued_date DATE,
  expiry_date DATE,
  metadata JSONB NOT NULL DEFAULT '{}',
  search_vector TSVECTOR,
  encryption_key_id INT REFERENCES encryption_keys(id),
  is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
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
