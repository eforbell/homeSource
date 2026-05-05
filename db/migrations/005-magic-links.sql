-- HomeSource: MagicLinks foundation

CREATE TABLE magic_links (
  id SERIAL PRIMARY KEY,
  source_document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'relates_to',
    'supersedes',
    'renews',
    'supplements',
    'same_asset',
    'same_provider',
    'same_account'
  )),
  reasoning TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent', 'user')),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'accepted', 'dismissed')),
  reviewed_by INT REFERENCES family_members(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_document_id <> target_document_id),
  UNIQUE (source_document_id, target_document_id, link_type)
);

CREATE INDEX idx_magic_links_source ON magic_links (source_document_id);
CREATE INDEX idx_magic_links_target ON magic_links (target_document_id);
CREATE INDEX idx_magic_links_status ON magic_links (status);
CREATE INDEX idx_magic_links_type ON magic_links (link_type);

CREATE TRIGGER trg_magic_links_updated_at
  BEFORE UPDATE ON magic_links
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
