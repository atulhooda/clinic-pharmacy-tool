-- 009_device_state: Spec 06a §3.5, §6.1. Who is active at a trusted PC (NULL = locked).
-- Kept apart from devices so devices and sessions do not reference each other.

CREATE TABLE device_state (
  org_id            uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  device_id         uuid        NOT NULL,
  active_session_id uuid        NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_state_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT device_state_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT device_state_device_fk FOREIGN KEY (org_id, device_id) REFERENCES devices (org_id, id),
  CONSTRAINT device_state_session_fk FOREIGN KEY (org_id, active_session_id) REFERENCES sessions (org_id, id),
  CONSTRAINT device_state_device_key UNIQUE (org_id, device_id)
);

ALTER TABLE device_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_state
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON device_state TO pharmacy_app;
