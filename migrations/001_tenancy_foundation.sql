-- 001_tenancy_foundation: Spec 06a §2 (tenancy and isolation), §2.6 (tenant integrity),
-- §5 (conventions), §18 (R6-7: one "tenancy foundation" change).
--
-- Applied by scripts/migrate.cjs as pharmacy_migrator, inside one transaction.
-- The roles themselves come from ops/bootstrap-roles.sql (a non-superuser cannot create roles).

-- ---------------------------------------------------------------- extensions
-- Trusted extensions: the database owner (the migrator) can install them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- helpers
-- L-1: attached to append-only tables by later migrations.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001', HINT = 'LEDGER_APPEND_ONLY';
END $$;

-- The IST business date of a timestamp (06a §5). Asia/Kolkata has no DST.
CREATE FUNCTION ist_date(ts timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (ts AT TIME ZONE 'Asia/Kolkata')::date
$$;

-- ---------------------------------------------------------------- organisations (the tenant root)
CREATE TABLE organisations (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  slug         text        NOT NULL,
  display_name text        NOT NULL,
  legal_name   text        NULL,
  status       text        NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organisations_pkey PRIMARY KEY (id),
  CONSTRAINT organisations_slug_key UNIQUE (slug),
  CONSTRAINT organisations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  CONSTRAINT organisations_display_name_len CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT organisations_status CHECK (status IN ('ACTIVE', 'SUSPENDED'))
);

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
-- The tenant root compares id (not org_id) with the transaction's setting.
CREATE POLICY tenant_isolation ON organisations
  USING      (id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::uuid);
-- 06a §2.4: the only cross-tenant read. The resolver function and the jobs service
-- see the organisation list; nobody else does.
CREATE POLICY org_directory ON organisations FOR SELECT
  TO pharmacy_resolver, pharmacy_jobs
  USING (true);

-- ---------------------------------------------------------------- premises (the legal unit)
CREATE TABLE premises (
  org_id     uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  address    text        NOT NULL,
  state_code char(2)     NOT NULL,
  gstin      text        NULL,
  legal_name text        NULL,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- §2.6: the primary key is (org_id, id); there is no single-column key on id.
  CONSTRAINT premises_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT premises_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT premises_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT premises_address_len CHECK (length(btrim(address)) BETWEEN 1 AND 500),
  CONSTRAINT premises_state_code CHECK (state_code ~ '^[0-9]{2}$'),
  CONSTRAINT premises_gstin CHECK (
    gstin IS NULL OR (gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$' AND left(gstin, 2) = state_code))
);
-- §2.6: every unique includes org_id.
CREATE UNIQUE INDEX premises_name_key ON premises (org_id, lower(name));

ALTER TABLE premises ENABLE ROW LEVEL SECURITY;
ALTER TABLE premises FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON premises
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- ---------------------------------------------------------------- the slug resolver (06a §2.4)
-- Before sign-in there is no organisation in the session. This is the only lookup that
-- crosses tenants: it returns an ACTIVE organisation's id and display name for a slug.
-- Owned by the NOLOGIN pharmacy_resolver, which can read four columns of organisations
-- through the org_directory policy and nothing else.
CREATE FUNCTION auth_resolve_org(p_slug text) RETURNS TABLE (id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT o.id, o.display_name
    FROM public.organisations o
   WHERE o.slug = lower(p_slug) AND o.status = 'ACTIVE'
$$;
GRANT SELECT (id, slug, display_name, status) ON organisations TO pharmacy_resolver;
ALTER FUNCTION auth_resolve_org(text) OWNER TO pharmacy_resolver;
REVOKE ALL ON FUNCTION auth_resolve_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_org(text) TO pharmacy_app;

-- ---------------------------------------------------------------- grants (06a §18)
-- The app never inserts organisations (the founder CLI does, as pharmacy_ops) and never deletes.
GRANT SELECT ON organisations TO pharmacy_app;
GRANT SELECT, INSERT, UPDATE ON premises TO pharmacy_app;

GRANT SELECT, INSERT ON organisations TO pharmacy_ops;
GRANT SELECT, INSERT ON premises TO pharmacy_ops;

GRANT SELECT ON organisations, premises TO pharmacy_jobs;

-- The app's startup self-check compares the applied migrations with the build (06a §2.5).
GRANT SELECT ON schema_migrations TO pharmacy_app;
