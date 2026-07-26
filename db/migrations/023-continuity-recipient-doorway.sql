-- HomeSource Feature 13 Phase C3: recipient-scoped bearer sessions and delivery promotion.

CREATE TABLE continuity_delivery_sessions (
  id SERIAL PRIMARY KEY,
  delivery_grant_id INT NOT NULL REFERENCES continuity_delivery_grants(id) ON DELETE CASCADE,
  bearer_hash TEXT NOT NULL UNIQUE CHECK (bearer_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_continuity_delivery_sessions_active
  ON continuity_delivery_sessions (bearer_hash, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_continuity_delivery_sessions_grant
  ON continuity_delivery_sessions (delivery_grant_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE FUNCTION enforce_continuity_delivery_session() RETURNS trigger AS $$
DECLARE grant_row continuity_delivery_grants%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO grant_row FROM continuity_delivery_grants WHERE id = NEW.delivery_grant_id;
  IF NOT FOUND OR grant_row.status <> 'active' OR grant_row.expires_at <= NEW.created_at
     OR NEW.expires_at > grant_row.expires_at THEN
    RAISE EXCEPTION 'continuity delivery session must remain within an active grant';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.delivery_grant_id IS DISTINCT FROM OLD.delivery_grant_id
      OR NEW.bearer_hash IS DISTINCT FROM OLD.bearer_hash
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
    RAISE EXCEPTION 'continuity delivery session identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_continuity_delivery_session
  BEFORE INSERT OR UPDATE OR DELETE ON continuity_delivery_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_continuity_delivery_session();
