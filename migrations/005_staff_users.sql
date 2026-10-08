-- 005_staff_users: Spec 06a §3.2 (staff accounts), §3.8 (limits), §3.12 (peppered PINs), §6.1.
-- Also adds the FKs from earlier tables' actor columns now that staff_users exists (R6-8).

CREATE TABLE staff_users (
  org_id                 uuid        NOT NULL,
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  name                   text        NOT NULL,
  login                  text        NOT NULL,
  phone_e164             text        NULL,
  role_key               text        NOT NULL,
  prescriber_id          uuid        NULL,
  password_hash          text        NULL,
  must_change_password   boolean     NOT NULL DEFAULT false,
  switch_pin_hash        text        NULL,
  signing_pin_hash       text        NULL,
  password_failures      integer     NOT NULL DEFAULT 0,
  password_paused_until  timestamptz NULL,
  switch_pin_failures    integer     NOT NULL DEFAULT 0,
  switch_pin_window_from timestamptz NULL,
  switch_pin_blocked     boolean     NOT NULL DEFAULT false,
  active                 boolean     NOT NULL DEFAULT true,
  last_sign_in_at        timestamptz NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_users_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT staff_users_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT staff_users_role_fk FOREIGN KEY (org_id, role_key) REFERENCES org_roles (org_id, key),
  CONSTRAINT staff_users_prescriber_fk FOREIGN KEY (org_id, prescriber_id) REFERENCES prescribers (org_id, id),
  CONSTRAINT staff_users_login_key UNIQUE (org_id, login),
  CONSTRAINT staff_users_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT staff_users_login_format CHECK (login ~ '^[a-z0-9._-]{3,32}$'),
  CONSTRAINT staff_users_phone_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT staff_users_credential CHECK (password_hash IS NOT NULL OR phone_e164 IS NOT NULL),
  CONSTRAINT staff_users_password_shape CHECK (
    password_hash IS NULL OR password_hash ~ '^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$'),
  -- 06a §3.12: PIN hashes carry the version of the pepper that made them.
  CONSTRAINT staff_users_switch_pin_shape CHECK (
    switch_pin_hash IS NULL OR switch_pin_hash ~ '^scrypt\$15\$8\$1\$p[0-9]{1,3}\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$'),
  CONSTRAINT staff_users_signing_pin_shape CHECK (
    signing_pin_hash IS NULL OR signing_pin_hash ~ '^scrypt\$15\$8\$1\$p[0-9]{1,3}\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$'),
  CONSTRAINT staff_users_failures CHECK (password_failures >= 0 AND switch_pin_failures >= 0)
);
CREATE UNIQUE INDEX staff_users_name_key ON staff_users (org_id, lower(name));
CREATE UNIQUE INDEX staff_users_phone_key ON staff_users (org_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX staff_users_prescriber_key ON staff_users (org_id, prescriber_id) WHERE prescriber_id IS NOT NULL;

ALTER TABLE staff_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_users
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Actor columns on earlier tables (added now that the parent exists; R6-8 allows adding an FK).
ALTER TABLE org_settings ADD CONSTRAINT org_settings_updated_by_fk
  FOREIGN KEY (org_id, updated_by) REFERENCES staff_users (org_id, id);
ALTER TABLE org_settings_history ADD CONSTRAINT org_settings_history_changed_by_fk
  FOREIGN KEY (org_id, changed_by) REFERENCES staff_users (org_id, id);
ALTER TABLE role_grants ADD CONSTRAINT role_grants_updated_by_fk
  FOREIGN KEY (org_id, updated_by) REFERENCES staff_users (org_id, id);

GRANT SELECT, INSERT, UPDATE ON staff_users TO pharmacy_app;
GRANT SELECT, INSERT, UPDATE ON staff_users TO pharmacy_ops;
