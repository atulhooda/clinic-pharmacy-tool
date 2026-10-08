-- 014_stock_settings: Spec 06a §6.4. One row per organisation, created by E-02; every change is
-- snapshotted into an append-only history (a backdated entry is checked against the settings
-- in force at its time, §11.4).

CREATE TABLE stock_settings (
  org_id                          uuid        NOT NULL,
  id                              uuid        NOT NULL DEFAULT gen_random_uuid(),
  near_expiry_windows_days        integer[]   NOT NULL DEFAULT '{30,60,90}',
  dispense_reversal_window_hours  integer     NOT NULL DEFAULT 24,
  backdate_reason_after_minutes   integer     NOT NULL DEFAULT 120,
  scheduled_entry_max_minutes     integer     NOT NULL DEFAULT 30,
  backdate_window_hours           integer     NOT NULL DEFAULT 48,
  backdate_extended_window_hours  integer     NOT NULL DEFAULT 168,
  procedure_use_patient_link      text        NOT NULL DEFAULT 'REQUIRED_FOR_INJECTABLES',
  opened_container_lapse_policy   text        NOT NULL DEFAULT 'BLOCK',
  intra_state_transfers_enabled   boolean     NOT NULL DEFAULT false,
  version                         integer     NOT NULL DEFAULT 1,
  updated_by                      uuid        NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_settings_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT stock_settings_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT stock_settings_updated_by_fk FOREIGN KEY (org_id, updated_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT stock_settings_org_key UNIQUE (org_id),
  CONSTRAINT stock_settings_near_expiry CHECK (cardinality(near_expiry_windows_days) BETWEEN 1 AND 3 AND 0 < ALL (near_expiry_windows_days)),
  CONSTRAINT stock_settings_reversal_window CHECK (dispense_reversal_window_hours BETWEEN 0 AND 168),
  CONSTRAINT stock_settings_reason_lag CHECK (backdate_reason_after_minutes BETWEEN 10 AND 1440),
  CONSTRAINT stock_settings_scheduled_lag CHECK (scheduled_entry_max_minutes BETWEEN 0 AND 120
                                                 AND scheduled_entry_max_minutes <= backdate_reason_after_minutes),
  CONSTRAINT stock_settings_backdate_window CHECK (backdate_window_hours BETWEEN 0 AND 168),
  CONSTRAINT stock_settings_backdate_extended CHECK (backdate_extended_window_hours BETWEEN backdate_window_hours AND 168),
  CONSTRAINT stock_settings_patient_link CHECK (procedure_use_patient_link IN ('OPTIONAL','REQUIRED_FOR_INJECTABLES','REQUIRED')),
  CONSTRAINT stock_settings_lapse_policy CHECK (opened_container_lapse_policy IN ('BLOCK','DOCTOR_OVERRIDE')),
  CONSTRAINT stock_settings_version CHECK (version >= 1)
);

CREATE TABLE stock_settings_history (
  org_id                          uuid        NOT NULL,
  id                              uuid        NOT NULL DEFAULT gen_random_uuid(),
  settings_id                     uuid        NOT NULL,
  snapshot                        jsonb       NOT NULL,
  version                         integer     NOT NULL,
  changed_by                      uuid        NULL,
  valid_from                      timestamptz NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_settings_history_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT stock_settings_history_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT stock_settings_history_settings_fk FOREIGN KEY (org_id, settings_id) REFERENCES stock_settings (org_id, id),
  CONSTRAINT stock_settings_history_changed_by_fk FOREIGN KEY (org_id, changed_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT stock_settings_history_snapshot CHECK (jsonb_typeof(snapshot) = 'object')
);

-- A full snapshot per change: the row as JSON, minus the bookkeeping columns.
CREATE FUNCTION stock_settings_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stock_settings_history (org_id, settings_id, snapshot, version, changed_by, valid_from)
  VALUES (NEW.org_id, NEW.id, to_jsonb(NEW) - 'org_id' - 'id' - 'updated_by' - 'updated_at' - 'created_at' - 'version',
          NEW.version, NEW.updated_by, NEW.updated_at);
  RETURN NULL;
END $$;
CREATE TRIGGER stock_settings_history AFTER INSERT OR UPDATE ON stock_settings
  FOR EACH ROW EXECUTE FUNCTION stock_settings_snapshot();
CREATE TRIGGER stock_settings_history_append_only BEFORE UPDATE OR DELETE ON stock_settings_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE stock_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_settings
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE stock_settings_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_settings_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_settings_history
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON stock_settings TO pharmacy_app;
GRANT SELECT, INSERT ON stock_settings_history TO pharmacy_app;
GRANT SELECT ON stock_settings, stock_settings_history TO pharmacy_jobs;
