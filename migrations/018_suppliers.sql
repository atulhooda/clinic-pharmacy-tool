-- 018_suppliers: Spec 06a §6.5. Org-wide; licence rules are evaluated against the receiving
-- premises' mode. Contact details are business contacts and are never logged.

CREATE TABLE suppliers (
  org_id               uuid        NOT NULL,
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  name                 text        NOT NULL,
  gstin                text        NULL,
  drug_licence_numbers text[]      NOT NULL DEFAULT '{}',
  licence_valid_till   date        NULL,
  address              text        NULL,
  contact_name         text        NULL,
  contact_phone        text        NULL,
  contact_email        text        NULL,
  active               boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT suppliers_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT suppliers_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT suppliers_gstin CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'),
  CONSTRAINT suppliers_licences CHECK (cardinality(drug_licence_numbers) <= 10),
  CONSTRAINT suppliers_phone CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT suppliers_email CHECK (contact_email IS NULL OR contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
CREATE UNIQUE INDEX suppliers_name_key ON suppliers (org_id, lower(name));
CREATE UNIQUE INDEX suppliers_gstin_key ON suppliers (org_id, gstin) WHERE gstin IS NOT NULL;

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON suppliers
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON suppliers TO pharmacy_app;
GRANT SELECT ON suppliers TO pharmacy_jobs;
