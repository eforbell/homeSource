-- HomeSource Feature 13 Phase C0.3: immutable packet policy, roster, coverage,
-- and switch-level trustee witness designations.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM continuity_switches
    WHERE status IN ('armed', 'paused', 'delivery_pending')
  ) THEN
    RAISE EXCEPTION 'Phase C packet migration requires zero armed-or-later continuity switches';
  END IF;
END;
$$;

CREATE TABLE continuity_packet_versions (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  version_number BIGINT NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'active', 'superseded')),
  letter_document_id INT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  operation_key TEXT NOT NULL CHECK (LENGTH(operation_key) BETWEEN 1 AND 120),
  created_by INT NOT NULL REFERENCES family_members(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  UNIQUE (switch_id, version_number),
  UNIQUE (switch_id, operation_key),
  CHECK (
    (status = 'staged' AND activated_at IS NULL AND superseded_at IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_continuity_packet_one_staged ON continuity_packet_versions (switch_id) WHERE status = 'staged';
CREATE UNIQUE INDEX idx_continuity_packet_one_active ON continuity_packet_versions (switch_id) WHERE status = 'active';

CREATE TABLE continuity_packet_documents (
  id SERIAL PRIMARY KEY,
  packet_version_id INT NOT NULL REFERENCES continuity_packet_versions(id) ON DELETE CASCADE,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('letter', 'selected')),
  packet_order INT NOT NULL CHECK (packet_order > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (packet_version_id, document_id),
  UNIQUE (packet_version_id, packet_order),
  UNIQUE (id, packet_version_id)
);
CREATE UNIQUE INDEX idx_continuity_packet_one_letter ON continuity_packet_documents (packet_version_id) WHERE item_kind = 'letter';

CREATE TABLE continuity_packet_recipients (
  id SERIAL PRIMARY KEY,
  packet_version_id INT NOT NULL REFERENCES continuity_packet_versions(id) ON DELETE CASCADE,
  member_id INT REFERENCES family_members(id),
  trustee_id INT REFERENCES vault_trustees(id),
  role TEXT NOT NULL CHECK (role IN ('beneficiary', 'trustee')),
  packet_order INT NOT NULL CHECK (packet_order > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (role = 'beneficiary' AND member_id IS NOT NULL AND trustee_id IS NULL)
    OR (role = 'trustee' AND member_id IS NULL AND trustee_id IS NOT NULL)
  ),
  UNIQUE (packet_version_id, packet_order),
  UNIQUE (id, packet_version_id)
);
CREATE UNIQUE INDEX idx_continuity_packet_recipient_member ON continuity_packet_recipients (packet_version_id, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX idx_continuity_packet_recipient_trustee ON continuity_packet_recipients (packet_version_id, trustee_id) WHERE trustee_id IS NOT NULL;

CREATE TABLE continuity_packet_recipient_documents (
  id SERIAL PRIMARY KEY,
  packet_version_id INT NOT NULL REFERENCES continuity_packet_versions(id) ON DELETE CASCADE,
  packet_recipient_id INT NOT NULL,
  packet_document_id INT NOT NULL,
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('covered', 'not_designated')),
  designation_id INT REFERENCES document_designations(id) ON DELETE RESTRICT,
  encryption_key_id INT REFERENCES encryption_keys(id) ON DELETE RESTRICT,
  key_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (packet_recipient_id, packet_document_id),
  FOREIGN KEY (packet_recipient_id, packet_version_id) REFERENCES continuity_packet_recipients(id, packet_version_id) ON DELETE CASCADE,
  FOREIGN KEY (packet_document_id, packet_version_id) REFERENCES continuity_packet_documents(id, packet_version_id) ON DELETE CASCADE,
  CHECK (
    (coverage_status = 'covered' AND designation_id IS NOT NULL AND encryption_key_id IS NOT NULL AND key_fingerprint IS NOT NULL)
    OR (coverage_status = 'not_designated' AND designation_id IS NULL AND encryption_key_id IS NULL AND key_fingerprint IS NULL)
  )
);

CREATE TABLE continuity_switch_trustees (
  switch_id INT NOT NULL REFERENCES continuity_switches(id) ON DELETE CASCADE,
  trustee_id INT NOT NULL REFERENCES vault_trustees(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (switch_id, trustee_id)
);

ALTER TABLE continuity_switches
  ADD COLUMN staged_packet_version_id INT REFERENCES continuity_packet_versions(id) ON DELETE SET NULL,
  ADD COLUMN active_packet_version_id INT REFERENCES continuity_packet_versions(id) ON DELETE SET NULL,
  ADD CONSTRAINT continuity_switch_packet_pointer_check CHECK (
    staged_packet_version_id IS NULL OR staged_packet_version_id <> active_packet_version_id
  );

CREATE FUNCTION reject_continuity_packet_child_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'continuity packet policy rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_continuity_packet_documents_immutable BEFORE UPDATE OR DELETE ON continuity_packet_documents
  FOR EACH ROW EXECUTE FUNCTION reject_continuity_packet_child_update();
CREATE TRIGGER trg_continuity_packet_recipients_immutable BEFORE UPDATE OR DELETE ON continuity_packet_recipients
  FOR EACH ROW EXECUTE FUNCTION reject_continuity_packet_child_update();
CREATE TRIGGER trg_continuity_packet_coverage_immutable BEFORE UPDATE OR DELETE ON continuity_packet_recipient_documents
  FOR EACH ROW EXECUTE FUNCTION reject_continuity_packet_child_update();

CREATE FUNCTION enforce_continuity_packet_version_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'continuity packet versions are immutable';
  END IF;
  IF NEW.switch_id IS DISTINCT FROM OLD.switch_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.letter_document_id IS DISTINCT FROM OLD.letter_document_id
     OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'continuity packet version identity is immutable';
  END IF;
  IF NOT ((OLD.status = 'staged' AND NEW.status IN ('active', 'superseded'))
          OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'invalid continuity packet version transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_continuity_packet_version_transition BEFORE UPDATE OR DELETE ON continuity_packet_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_continuity_packet_version_transition();
