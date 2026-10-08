-- 015_premises_settings: Spec 06a §6.4 (D-6). The legal configuration of each premises: the
-- dispensing mode (no default), licences, register fields, prescription age. Every change is
-- snapshotted into an append-only history: a mode change has legal weight.

CREATE TABLE premises_settings (
  org_id                        uuid        NOT NULL,
  id                            uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id                   uuid        NOT NULL,
  dispensing_mode               text        NOT NULL,
  ndps_licence_no               text        NULL,
  ndps_licence_valid_till       date        NULL,
  schedule_x_licence_no         text        NULL,
  schedule_x_licence_valid_till date        NULL,
  retail_drug_licence_numbers   text[]      NOT NULL DEFAULT '{}',
  retail_licence_valid_till     date        NULL,
  h1_register_extra_fields      text[]      NOT NULL DEFAULT '{}',
  prescription_max_age_days     integer     NULL,
  version                       integer     NOT NULL DEFAULT 1,
  updated_by                    uuid        NULL,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premises_settings_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT premises_settings_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT premises_settings_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT premises_settings_updated_by_fk FOREIGN KEY (org_id, updated_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT premises_settings_premises_key UNIQUE (org_id, premises_id),
  CONSTRAINT premises_settings_mode CHECK (dispensing_mode IN ('RMP_OWN_PATIENTS','LICENSED_PHARMACY','CONSUMABLES_ONLY')),
  CONSTRAINT premises_settings_retail_licence CHECK (dispensing_mode <> 'LICENSED_PHARMACY' OR cardinality(retail_drug_licence_numbers) > 0),
  CONSTRAINT premises_settings_h1_fields CHECK (h1_register_extra_fields <@ ARRAY['PATIENT_ADDRESS','PATIENT_AGE','PATIENT_DOB','PRESCRIPTION_DATE']::text[]),
  CONSTRAINT premises_settings_rx_age CHECK (prescription_max_age_days IS NULL OR prescription_max_age_days BETWEEN 1 AND 365),
  CONSTRAINT premises_settings_version CHECK (version >= 1)
);

CREATE TABLE premises_settings_history (
  org_id      uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  settings_id uuid        NOT NULL,
  premises_id uuid        NOT NULL,
  snapshot    jsonb       NOT NULL,
  version     integer     NOT NULL,
  changed_by  uuid        NULL,
  valid_from  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premises_settings_history_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT premises_settings_history_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT premises_settings_history_settings_fk FOREIGN KEY (org_id, settings_id) REFERENCES premises_settings (org_id, id),
  CONSTRAINT premises_settings_history_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT premises_settings_history_changed_by_fk FOREIGN KEY (org_id, changed_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT premises_settings_history_snapshot CHECK (jsonb_typeof(snapshot) = 'object')
);
CREATE INDEX premises_settings_history_at ON premises_settings_history (org_id, premises_id, valid_from);

CREATE FUNCTION premises_settings_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO premises_settings_history (org_id, settings_id, premises_id, snapshot, version, changed_by, valid_from)
  VALUES (NEW.org_id, NEW.id, NEW.premises_id,
          to_jsonb(NEW) - 'org_id' - 'id' - 'premises_id' - 'updated_by' - 'updated_at' - 'created_at' - 'version',
          NEW.version, NEW.updated_by, NEW.updated_at);
  RETURN NULL;
END $$;
CREATE TRIGGER premises_settings_history AFTER INSERT OR UPDATE ON premises_settings
  FOR EACH ROW EXECUTE FUNCTION premises_settings_snapshot();
CREATE TRIGGER premises_settings_history_append_only BEFORE UPDATE OR DELETE ON premises_settings_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE premises_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE premises_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON premises_settings
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE premises_settings_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE premises_settings_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON premises_settings_history
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON premises_settings TO pharmacy_app;
GRANT SELECT, INSERT ON premises_settings_history TO pharmacy_app;
GRANT SELECT ON premises_settings, premises_settings_history TO pharmacy_jobs;
