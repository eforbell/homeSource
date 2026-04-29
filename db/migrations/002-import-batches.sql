-- HomeSource: Smart Batch Import + MagicIndex foundation

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
