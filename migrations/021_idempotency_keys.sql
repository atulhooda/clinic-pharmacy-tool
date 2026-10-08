-- 021_idempotency_keys: Spec 06a §12.2 (rule 11), 06 R7-2. One row per successful write
-- request, keyed per organisation. The row is inserted FIRST, inside the business transaction,
-- so a concurrent request with the same key waits on it; a failed request rolls its row back,
-- so only successes are remembered. It holds the status and the resource id, never a
-- response body (06b DK-09): a replay re-reads the resource.

CREATE TABLE idempotency_keys (
  org_id         uuid        NOT NULL,
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  key            text        NOT NULL,
  request_sha256 text        NOT NULL,
  method         text        NOT NULL,
  path           text        NOT NULL,
  staff_user_id  uuid        NOT NULL,
  status         integer     NULL,
  resource_id    uuid        NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz NULL,
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT idempotency_keys_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_keys_staff_fk FOREIGN KEY (org_id, staff_user_id) REFERENCES staff_users (org_id, id),
  CONSTRAINT idempotency_keys_key UNIQUE (org_id, key),
  CONSTRAINT idempotency_keys_key_shape CHECK (key ~ '^[A-Za-z0-9_-]{8,128}$'),
  CONSTRAINT idempotency_keys_sha CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_keys_method CHECK (method IN ('POST','PUT','PATCH','DELETE')),
  CONSTRAINT idempotency_keys_path CHECK (path ~ '^/api/' AND length(path) <= 300),
  CONSTRAINT idempotency_keys_status CHECK (status IS NULL OR status BETWEEN 200 AND 299),
  CONSTRAINT idempotency_keys_completed CHECK ((status IS NULL) = (completed_at IS NULL))
);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The app records the outcome in the same transaction; it never rewrites the key or the hash.
GRANT SELECT, INSERT ON idempotency_keys TO pharmacy_app;
GRANT UPDATE (status, resource_id, completed_at) ON idempotency_keys TO pharmacy_app;
GRANT SELECT ON idempotency_keys TO pharmacy_jobs;
