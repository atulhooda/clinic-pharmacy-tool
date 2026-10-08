-- 004_prescribers: Spec 06a §6.2. Created before staff_users, which links a doctor's login
-- to their prescriber row. The prescriber screens and routes come in PR 6.

CREATE TABLE prescribers (
  org_id          uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  kind            text        NOT NULL,
  name            text        NOT NULL,
  registration_no text        NULL,
  council         text        NULL,
  qualification   text        NULL,
  address         text        NULL,
  phone_e164      text        NULL,
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prescribers_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT prescribers_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT prescribers_kind CHECK (kind IN ('INTERNAL', 'EXTERNAL')),
  CONSTRAINT prescribers_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- An INTERNAL prescriber without an address uses the premises' address on the register.
  CONSTRAINT prescribers_external_address CHECK (kind = 'INTERNAL' OR address IS NOT NULL),
  CONSTRAINT prescribers_phone_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

ALTER TABLE prescribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescribers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON prescribers
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON prescribers TO pharmacy_app;
