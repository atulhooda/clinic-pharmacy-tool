-- 003_roles_and_grants: Spec 06a §4.1 (roles as data, defaults in code), §6.1.
-- Built-in roles (owner, doctor, reception) are rows in every organisation; their default
-- grants live in code (lib/auth/permissions.ts). role_grants holds per-organisation
-- overrides and the grants of custom roles.

CREATE TABLE org_roles (
  org_id     uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  key        text        NOT NULL,
  name       text        NOT NULL,
  builtin    boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_roles_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT org_roles_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT org_roles_key UNIQUE (org_id, key),
  CONSTRAINT org_roles_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT org_roles_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT org_roles_builtin_keys CHECK (NOT builtin OR key IN ('owner', 'doctor', 'reception'))
);

-- Built-in roles cannot be deleted or renamed; no role key ever changes (grants and staff
-- reference the key).
CREATE FUNCTION org_roles_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.builtin THEN
      RAISE EXCEPTION 'built-in role % cannot be deleted', OLD.key USING ERRCODE = 'P0001', HINT = 'BUILTIN_ROLE';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'role keys are immutable' USING ERRCODE = 'P0001', HINT = 'ROLE_KEY_IMMUTABLE';
  END IF;
  IF OLD.builtin AND (NEW.name <> OLD.name OR NOT NEW.builtin) THEN
    RAISE EXCEPTION 'built-in role % cannot be changed', OLD.key USING ERRCODE = 'P0001', HINT = 'BUILTIN_ROLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER org_roles_guard BEFORE UPDATE OR DELETE ON org_roles
  FOR EACH ROW EXECUTE FUNCTION org_roles_guard();

CREATE TABLE role_grants (
  org_id     uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  role_key   text        NOT NULL,
  permission text        NOT NULL,
  allowed    boolean     NOT NULL,
  updated_by uuid        NULL,   -- FK to staff_users added in 005
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_grants_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT role_grants_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT role_grants_role_fk FOREIGN KEY (org_id, role_key) REFERENCES org_roles (org_id, key),
  CONSTRAINT role_grants_role_permission_key UNIQUE (org_id, role_key, permission),
  -- The service also checks the key against the catalogue in code.
  CONSTRAINT role_grants_permission_format CHECK (permission ~ '^[a-z]+(\.[a-z_]+)+$')
);

ALTER TABLE org_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_roles
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE role_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_grants
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON org_roles, role_grants TO pharmacy_app;
GRANT SELECT, INSERT ON org_roles TO pharmacy_ops;
