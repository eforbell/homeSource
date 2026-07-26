-- HomeSource Feature 13 Phase C4: allow terminal recipient-session revocation after grant expiry.

CREATE OR REPLACE FUNCTION enforce_continuity_delivery_session() RETURNS trigger AS $$
DECLARE grant_row continuity_delivery_grants%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO grant_row FROM continuity_delivery_grants WHERE id = NEW.delivery_grant_id;
    IF NOT FOUND OR grant_row.status <> 'active' OR grant_row.expires_at <= NEW.created_at
       OR NEW.expires_at > grant_row.expires_at THEN
      RAISE EXCEPTION 'continuity delivery session must remain within an active grant';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.delivery_grant_id IS DISTINCT FROM OLD.delivery_grant_id
     OR NEW.bearer_hash IS DISTINCT FROM OLD.bearer_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'continuity delivery session identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
