-- 012_sign_in_throttle: Spec 06a §3.8, §6.1 (D-45). Failed sign-ins are counted per submitted
-- username, whether or not the account exists. The row holds an HMAC of the login, never the
-- login (R6-10), and is not linked to staff_users, so it reveals nothing about which exist.
-- staff_users.password_failures / password_paused_until stay, unused (R6-8, R6-11).

CREATE TABLE sign_in_throttle (
  org_id       uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  login_hmac   text        NOT NULL,
  failures     integer     NOT NULL DEFAULT 0,
  window_from  timestamptz NULL,
  paused_until timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sign_in_throttle_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT sign_in_throttle_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT sign_in_throttle_login_key UNIQUE (org_id, login_hmac),
  CONSTRAINT sign_in_throttle_login_hmac CHECK (login_hmac ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT sign_in_throttle_failures CHECK (failures BETWEEN 0 AND 5)
);

ALTER TABLE sign_in_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_in_throttle FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sign_in_throttle
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON sign_in_throttle TO pharmacy_app;
