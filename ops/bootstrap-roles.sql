-- ops/bootstrap-roles.sql: Spec 06a §2.2, §18.
--
-- Run ONCE per database, by the platform superuser (e.g. Railway's `postgres`),
-- BEFORE migration 001. After this, no service holds a superuser DSN (06b DS-12).
--
-- Idempotent: safe to re-run. It sets NO passwords; set them out of band with
--   ALTER ROLE pharmacy_app PASSWORD '…';
-- and keep them in the platform's secret store, never in this repo.
--
-- Roles (all NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; only the migrator owns objects):
--   pharmacy_migrator  the migration runner (MIGRATION_DATABASE_URL); owns every table
--   pharmacy_app       the web app (DATABASE_URL); owns nothing; RLS applies to it
--   pharmacy_jobs      the cron service (later milestones)
--   pharmacy_ops       founder CLIs: create an organisation and its first owner
--   pharmacy_curator   master-data tooling (medicine_master)
--   pharmacy_resolver  NOLOGIN; owns only auth_resolve_org() (06a §2.4)

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pharmacy_migrator', 'pharmacy_app', 'pharmacy_jobs', 'pharmacy_ops', 'pharmacy_curator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
    -- Force the safe attributes even if the role already existed with others.
    EXECUTE format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION', r);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pharmacy_resolver') THEN
    CREATE ROLE pharmacy_resolver NOLOGIN;
  END IF;
  ALTER ROLE pharmacy_resolver NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
END $$;

-- The migrator hands ownership of auth_resolve_org() to pharmacy_resolver, which
-- requires membership in that role.
GRANT pharmacy_resolver TO pharmacy_migrator;

-- The migrator owns the database, so it owns the public schema's objects and can
-- install the trusted extensions (pg_trgm, btree_gist) without being a superuser.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO pharmacy_migrator', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO pharmacy_migrator, pharmacy_app, pharmacy_jobs, pharmacy_ops, pharmacy_curator',
                 current_database());
END $$;

ALTER SCHEMA public OWNER TO pharmacy_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pharmacy_app, pharmacy_jobs, pharmacy_ops, pharmacy_curator, pharmacy_resolver;
-- A new function owner needs CREATE on the function's schema. pharmacy_resolver
-- cannot log in, so this is usable only through the migrator's membership.
GRANT CREATE ON SCHEMA public TO pharmacy_resolver;
