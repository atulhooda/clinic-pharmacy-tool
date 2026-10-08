-- 008_sessions: Spec 06a §3.4 (one working day), §3.7 (secret failures), §6.1.

CREATE TABLE sessions (
  org_id          uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  staff_user_id   uuid        NOT NULL,
  device_id       uuid        NULL,   -- NULL = an untrusted browser
  method          text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_input_at   timestamptz NOT NULL,
  secret_failures integer     NOT NULL DEFAULT 0,
  revoked_at      timestamptz NULL,
  revoked_reason  text        NULL,
  CONSTRAINT sessions_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT sessions_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT sessions_staff_fk FOREIGN KEY (org_id, staff_user_id) REFERENCES staff_users (org_id, id),
  CONSTRAINT sessions_device_fk FOREIGN KEY (org_id, device_id) REFERENCES devices (org_id, id),
  CONSTRAINT sessions_method CHECK (method IN ('PASSWORD', 'OTP')),
  -- §3.4: a session never outlives 16 hours (and ends earlier at the daily reset).
  CONSTRAINT sessions_expiry_cap CHECK (expires_at > created_at AND expires_at <= created_at + interval '16 hours'),
  CONSTRAINT sessions_secret_failures CHECK (secret_failures BETWEEN 0 AND 5),
  CONSTRAINT sessions_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT sessions_revoked_reason CHECK (revoked_reason IS NULL OR revoked_reason IN (
    'sign_out', 'sign_out_all', 'replaced', 'expired', 'idle', 'wrong_secrets', 'deactivated',
    'role_changed', 'password_changed', 'password_reset', 'device_revoked', 'owner_revoked'))
);
CREATE INDEX sessions_open_by_staff ON sessions (org_id, staff_user_id) WHERE revoked_at IS NULL;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON sessions TO pharmacy_app;
