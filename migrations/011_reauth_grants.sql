-- 011_reauth_grants: Spec 06a §3.7 (signing-PIN re-auth grants) and §3.12 / R6-14 (the PIN
-- pepper census). The PIN machinery of PR 3.

CREATE TABLE reauth_grants (
  org_id        uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  session_id    uuid        NOT NULL,
  staff_user_id uuid        NOT NULL,
  purpose       text        NOT NULL,
  entity_id     uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz NULL,
  CONSTRAINT reauth_grants_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT reauth_grants_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT reauth_grants_session_fk FOREIGN KEY (org_id, session_id) REFERENCES sessions (org_id, id),
  CONSTRAINT reauth_grants_staff_fk FOREIGN KEY (org_id, staff_user_id) REFERENCES staff_users (org_id, id),
  -- The closed list of 06a §3.7. Adding a purpose is a migration and a code change together.
  CONSTRAINT reauth_grants_purpose CHECK (purpose IN (
    'prescription.verify', 'container.lapse_override', 'stock.reverse', 'stock.backdate', 'stock.writeoff',
    'stock.adjust', 'stock.import_commit', 'premises.legal_settings', 'register.export', 'staff.manage',
    'roles.manage', 'devices.register', 'org.settings', 'patients.merge')),
  -- §3.7: grants live 2 minutes; the database caps any grant at 10 (06b DPN-09).
  CONSTRAINT reauth_grants_expiry_cap CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT reauth_grants_used_after_created CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX reauth_grants_session ON reauth_grants (org_id, session_id);

ALTER TABLE reauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE reauth_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reauth_grants
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON reauth_grants TO pharmacy_app;

-- R6-14: a global count of PIN hashes per kind and pepper version. No organisation, person or
-- hash is in it, so the web app can read it before any session exists (the startup check,
-- §3.12) without a new door past RLS. Only the trigger below writes it.
CREATE TABLE pin_pepper_census (
  kind    text    NOT NULL,
  version integer NOT NULL,
  hashes  bigint  NOT NULL DEFAULT 0,
  CONSTRAINT pin_pepper_census_pkey PRIMARY KEY (kind, version),
  CONSTRAINT pin_pepper_census_kind CHECK (kind IN ('switch', 'signing')),
  CONSTRAINT pin_pepper_census_version CHECK (version BETWEEN 1 AND 999),
  CONSTRAINT pin_pepper_census_hashes CHECK (hashes >= 0)
);

CREATE FUNCTION pin_hash_version(h text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT (substring(h from '^scrypt\$15\$8\$1\$p([0-9]{1,3})\$'))::integer
$$;

CREATE FUNCTION pin_pepper_census_bump(p_kind text, p_hash text, p_delta integer) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v integer := pin_hash_version(p_hash);
BEGIN
  IF v IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO pin_pepper_census AS c (kind, version, hashes) VALUES (p_kind, v, GREATEST(p_delta, 0))
  ON CONFLICT (kind, version) DO UPDATE SET hashes = c.hashes + p_delta;
END $$;

-- SECURITY DEFINER, owned by the migrator: the app role cannot write the census itself.
CREATE FUNCTION pin_pepper_census_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pin_pepper_census_bump('switch', NEW.switch_pin_hash, 1);
    PERFORM pin_pepper_census_bump('signing', NEW.signing_pin_hash, 1);
  ELSE
    IF NEW.switch_pin_hash IS DISTINCT FROM OLD.switch_pin_hash THEN
      PERFORM pin_pepper_census_bump('switch', OLD.switch_pin_hash, -1);
      PERFORM pin_pepper_census_bump('switch', NEW.switch_pin_hash, 1);
    END IF;
    IF NEW.signing_pin_hash IS DISTINCT FROM OLD.signing_pin_hash THEN
      PERFORM pin_pepper_census_bump('signing', OLD.signing_pin_hash, -1);
      PERFORM pin_pepper_census_bump('signing', NEW.signing_pin_hash, 1);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER staff_users_pin_census AFTER INSERT OR UPDATE OF switch_pin_hash, signing_pin_hash ON staff_users
  FOR EACH ROW EXECUTE FUNCTION pin_pepper_census_apply();

REVOKE ALL ON FUNCTION pin_pepper_census_bump(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION pin_pepper_census_apply() FROM PUBLIC;
GRANT SELECT ON pin_pepper_census TO pharmacy_app, pharmacy_jobs;
