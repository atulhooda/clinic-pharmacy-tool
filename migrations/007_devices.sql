-- 007_devices: Spec 06a §3.5, §6.1. Trusted front-desk PCs. Registration and the lock
-- screen arrive in PR 3; the table exists now because sessions reference it.

CREATE TABLE devices (
  org_id        uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id   uuid        NOT NULL,
  name          text        NOT NULL,
  registered_by uuid        NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz NULL,
  revoked_by    uuid        NULL,
  last_seen_at  timestamptz NULL,
  CONSTRAINT devices_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT devices_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT devices_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT devices_registered_by_fk FOREIGN KEY (org_id, registered_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT devices_revoked_by_fk FOREIGN KEY (org_id, revoked_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT devices_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT devices_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX devices_name_key ON devices (org_id, lower(name)) WHERE revoked_at IS NULL;

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON devices
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON devices TO pharmacy_app;
