-- HomeSource: persist registration PRF salt with verified WebAuthn credentials

ALTER TABLE webauthn_credentials
  ADD COLUMN IF NOT EXISTS registration_prf_salt TEXT;
