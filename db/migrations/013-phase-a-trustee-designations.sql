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

ALTER TABLE encryption_keys
  ADD COLUMN trustee_id INT REFERENCES vault_trustees(id);

ALTER TABLE encryption_keys
  DROP CONSTRAINT IF EXISTS encryption_keys_key_type_check;

ALTER TABLE encryption_keys
  ADD CONSTRAINT encryption_keys_key_type_check
    CHECK (key_type IN ('document', 'member', 'recovery', 'trustee')),
  ADD CONSTRAINT encryption_keys_principal_check
    CHECK (
      (key_type = 'member' AND member_id IS NOT NULL AND trustee_id IS NULL)
      OR (key_type = 'trustee' AND member_id IS NULL AND trustee_id IS NOT NULL)
      OR (key_type IN ('document', 'recovery') AND trustee_id IS NULL)
    );

CREATE UNIQUE INDEX idx_encryption_keys_trustee_fingerprint
  ON encryption_keys (trustee_id, key_fingerprint)
  WHERE key_type = 'trustee' AND revoked_at IS NULL;

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
