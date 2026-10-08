-- 019_batches: Spec 06a §6.6, §2.6 rule 3 (D-31), §11.3. Batches are per premises: the same
-- batch number and expiry at two premises are two rows. Cost and supplier are not here; they
-- live on the receipt lines (PR 8). A batch never changes once created: the app may only
-- insert and read it.

CREATE TABLE batches (
  org_id                        uuid        NOT NULL,
  id                            uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id                   uuid        NOT NULL,
  item_id                       uuid        NOT NULL,
  batch_no                      text        NOT NULL,
  expiry_date                   date        NOT NULL,
  expiry_as_printed             text        NULL,
  mfg_date                      date        NULL,
  mrp_paise                     bigint      NOT NULL,
  mrp_unit_id                   uuid        NOT NULL,
  manufacturer_name_snapshot    text        NULL,
  manufacturer_address_snapshot text        NULL,
  seq                           bigint      GENERATED ALWAYS AS IDENTITY,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batches_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT batches_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT batches_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT batches_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  -- The MRP is for a pack OF THIS ITEM.
  CONSTRAINT batches_mrp_unit_fk FOREIGN KEY (org_id, item_id, mrp_unit_id) REFERENCES item_units (org_id, item_id, id),
  CONSTRAINT batches_number_key UNIQUE (org_id, premises_id, item_id, batch_no, expiry_date),
  -- For the composite FKs of §2.6 (movements, balances, lines and allocations name a batch of their own premises).
  CONSTRAINT batches_premises_item_key UNIQUE (org_id, premises_id, item_id, id),
  -- Normalised: trimmed, single spaces, upper case (the service normalises; this proves it).
  CONSTRAINT batches_batch_no_normalised CHECK (batch_no = upper(regexp_replace(btrim(batch_no), '\s+', ' ', 'g'))
                                                AND length(batch_no) BETWEEN 1 AND 40),
  CONSTRAINT batches_expiry_printed_len CHECK (expiry_as_printed IS NULL OR length(expiry_as_printed) <= 20),
  CONSTRAINT batches_mfg_before_expiry CHECK (mfg_date IS NULL OR mfg_date <= expiry_date),
  CONSTRAINT batches_mrp_positive CHECK (mrp_paise > 0),
  CONSTRAINT batches_manufacturer_len CHECK (coalesce(length(manufacturer_name_snapshot), 0) <= 200
                                             AND coalesce(length(manufacturer_address_snapshot), 0) <= 500)
);
CREATE INDEX batches_item_expiry ON batches (org_id, item_id, expiry_date);

ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batches
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT ON batches TO pharmacy_app;
GRANT SELECT ON batches TO pharmacy_jobs;
