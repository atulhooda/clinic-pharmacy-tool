-- 016_stock_locations: Spec 06a §6.4, §2.6 rule 3. Storage places within a premises. E-05
-- creates two per configured premises: the default STORE and the QUARANTINE location (D-14).
-- Rows that name a location carry premises_id in their FK, so nothing reaches another branch.

CREATE TABLE stock_locations (
  org_id            uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id       uuid        NOT NULL,
  name              text        NOT NULL,
  kind              text        NOT NULL,
  storage_condition text        NULL,
  is_default        boolean     NOT NULL DEFAULT false,
  active            boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_locations_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT stock_locations_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT stock_locations_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT stock_locations_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT stock_locations_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT stock_locations_kind CHECK (kind IN ('STORE','PROCEDURE_ROOM','FRIDGE','QUARANTINE')),
  CONSTRAINT stock_locations_storage CHECK (storage_condition IS NULL OR storage_condition IN ('ROOM_TEMPERATURE','BELOW_25C','BELOW_30C','COLD_2_8C','FROZEN')),
  CONSTRAINT stock_locations_default_is_store CHECK (NOT is_default OR kind <> 'QUARANTINE')
);
CREATE UNIQUE INDEX stock_locations_name_key ON stock_locations (org_id, premises_id, lower(name));
CREATE UNIQUE INDEX stock_locations_default_key ON stock_locations (org_id, premises_id) WHERE is_default;
CREATE UNIQUE INDEX stock_locations_quarantine_key ON stock_locations (org_id, premises_id) WHERE kind = 'QUARANTINE';

ALTER TABLE stock_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_locations
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON stock_locations TO pharmacy_app;
GRANT SELECT ON stock_locations TO pharmacy_jobs;
