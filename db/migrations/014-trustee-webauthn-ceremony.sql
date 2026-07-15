-- HomeSource: allow sessionless trustee invitations to complete the same
-- WebAuthn registration / PRF assertion ceremony as household members.

ALTER TABLE webauthn_challenges
  ALTER COLUMN member_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS trustee_id INT REFERENCES vault_trustees(id) ON DELETE CASCADE;

ALTER TABLE webauthn_challenges
  DROP CONSTRAINT IF EXISTS webauthn_challenges_principal_check;
ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_principal_check CHECK (
    (member_id IS NOT NULL AND trustee_id IS NULL)
    OR (member_id IS NULL AND trustee_id IS NOT NULL)
  );

ALTER TABLE webauthn_challenges
  DROP CONSTRAINT IF EXISTS webauthn_challenges_purpose_check;
ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_purpose_check
  CHECK (purpose IN (
    'member_key_registration', 'member_key_assertion',
    'trustee_key_registration', 'trustee_key_assertion'
  ));

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_trustee_purpose
  ON webauthn_challenges (trustee_id, purpose, created_at DESC)
  WHERE trustee_id IS NOT NULL;

ALTER TABLE webauthn_credentials
  ALTER COLUMN member_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS trustee_id INT REFERENCES vault_trustees(id) ON DELETE CASCADE;

ALTER TABLE webauthn_credentials
  DROP CONSTRAINT IF EXISTS webauthn_credentials_principal_check;
ALTER TABLE webauthn_credentials
  ADD CONSTRAINT webauthn_credentials_principal_check CHECK (
    (member_id IS NOT NULL AND trustee_id IS NULL)
    OR (member_id IS NULL AND trustee_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_trustee
  ON webauthn_credentials (trustee_id, created_at DESC)
  WHERE trustee_id IS NOT NULL;
