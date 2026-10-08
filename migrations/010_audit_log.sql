-- 010_audit_log: Spec 06a §3.11. Append-only, enforced three ways: a trigger refuses UPDATE and
-- DELETE; the app role has neither privilege, nor TRUNCATE; and the app role does not own the
-- table, so it cannot disable the trigger. No patient content (lib/audit.ts sanitises detail).

CREATE TABLE audit_log (
  org_id        uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  at            timestamptz NOT NULL DEFAULT now(),
  -- Plain ids, not FKs, so purging sessions never touches the audit trail.
  staff_user_id uuid        NULL,
  session_id    uuid        NULL,
  device_id     uuid        NULL,
  actor_label   text        NOT NULL,
  actor_role    text        NOT NULL,
  action        text        NOT NULL,
  entity_id     uuid        NULL,
  detail        jsonb       NOT NULL DEFAULT '{}',
  CONSTRAINT audit_log_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT audit_log_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT audit_log_actor_label_len CHECK (length(actor_label) BETWEEN 1 AND 64),
  CONSTRAINT audit_log_actor_role CHECK (actor_role ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT audit_log_action CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  CONSTRAINT audit_log_detail_object CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT audit_log_detail_size CHECK (octet_length(detail::text) <= 2048)
);
CREATE INDEX audit_log_recent ON audit_log (org_id, at DESC);

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT ON audit_log TO pharmacy_app;
GRANT SELECT, INSERT ON audit_log TO pharmacy_ops;
