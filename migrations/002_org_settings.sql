-- 002_org_settings: Spec 06a §6.1 (org_settings), §3.4 (sessions), §3.6 (idle lock).
-- One row per organisation; every change is snapshotted into an append-only history.

CREATE TABLE org_settings (
  org_id                 uuid        NOT NULL,
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  device_lock_minutes    integer     NOT NULL DEFAULT 3,
  day_reset_time_ist     time        NOT NULL DEFAULT '04:00',
  untrusted_idle_minutes integer     NULL,
  version                integer     NOT NULL DEFAULT 1,
  updated_by             uuid        NULL,   -- FK to staff_users added in 005 (it does not exist yet)
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_settings_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT org_settings_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT org_settings_org_key UNIQUE (org_id),
  CONSTRAINT org_settings_lock_minutes CHECK (device_lock_minutes BETWEEN 1 AND 10),
  CONSTRAINT org_settings_untrusted_idle CHECK (untrusted_idle_minutes IS NULL OR untrusted_idle_minutes BETWEEN 5 AND 720),
  CONSTRAINT org_settings_version CHECK (version >= 1)
);

CREATE TABLE org_settings_history (
  org_id                 uuid        NOT NULL,
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  settings_id            uuid        NOT NULL,
  device_lock_minutes    integer     NOT NULL,
  day_reset_time_ist     time        NOT NULL,
  untrusted_idle_minutes integer     NULL,
  version                integer     NOT NULL,
  changed_by             uuid        NULL,   -- FK to staff_users added in 005
  valid_from             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_settings_history_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT org_settings_history_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT org_settings_history_settings_fk FOREIGN KEY (org_id, settings_id) REFERENCES org_settings (org_id, id)
);

-- Every insert or update of org_settings writes a full snapshot (06a §6.4: history makes
-- "what was the setting at time T" answerable). Runs as the invoking role, under RLS.
CREATE FUNCTION org_settings_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO org_settings_history (org_id, settings_id, device_lock_minutes, day_reset_time_ist,
                                    untrusted_idle_minutes, version, changed_by, valid_from)
  VALUES (NEW.org_id, NEW.id, NEW.device_lock_minutes, NEW.day_reset_time_ist,
          NEW.untrusted_idle_minutes, NEW.version, NEW.updated_by, NEW.updated_at);
  RETURN NULL;
END $$;
CREATE TRIGGER org_settings_history AFTER INSERT OR UPDATE ON org_settings
  FOR EACH ROW EXECUTE FUNCTION org_settings_snapshot();
CREATE TRIGGER org_settings_history_append_only BEFORE UPDATE OR DELETE ON org_settings_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_settings
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE org_settings_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_settings_history
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON org_settings TO pharmacy_app;
GRANT SELECT, INSERT ON org_settings_history TO pharmacy_app;
GRANT SELECT, INSERT ON org_settings, org_settings_history TO pharmacy_ops;
GRANT SELECT ON org_settings TO pharmacy_jobs;
