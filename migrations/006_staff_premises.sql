-- 006_staff_premises: Spec 06a §3.2, §4.4. Which premises a person works at. The owner
-- holds every premises implicitly; others only through these rows.

CREATE TABLE staff_premises (
  org_id        uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  staff_user_id uuid        NOT NULL,
  premises_id   uuid        NOT NULL,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_premises_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT staff_premises_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT staff_premises_staff_fk FOREIGN KEY (org_id, staff_user_id) REFERENCES staff_users (org_id, id),
  CONSTRAINT staff_premises_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT staff_premises_key UNIQUE (org_id, staff_user_id, premises_id)
);

ALTER TABLE staff_premises ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_premises FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_premises
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON staff_premises TO pharmacy_app;
GRANT SELECT, INSERT ON staff_premises TO pharmacy_ops;
