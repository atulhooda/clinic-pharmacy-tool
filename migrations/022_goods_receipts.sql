-- 022_goods_receipts: Spec 06a §6.7 (goods receipts), §9.3 (post_grn), L-12, L-22; D-50 (PR 8,
-- numbered 025 before). A delivery is a DRAFT until it is posted; posting writes its lines and
-- one RECEIPT per line, and freezes it.
--
-- A draft's lines are a JSON array on the header (draft_lines) until posting: the app role holds
-- no DELETE on any table (06b DMG-07), so draft line rows could never be removed. Posting writes
-- the immutable goods_receipt_lines rows and empties draft_lines in the same transaction.

CREATE TABLE goods_receipts (
  org_id                              uuid        NOT NULL,
  id                                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id                         uuid        NOT NULL,
  location_id                         uuid        NOT NULL,
  supplier_id                         uuid        NOT NULL,
  invoice_no                          text        NOT NULL,
  invoice_date                        date        NOT NULL,
  invoice_total_paise                 bigint      NULL,
  status                              text        NOT NULL DEFAULT 'DRAFT',
  notes                               text        NULL,
  draft_lines                         jsonb       NOT NULL DEFAULT '[]',
  created_by                          uuid        NOT NULL,
  created_at                          timestamptz NOT NULL,
  updated_at                          timestamptz NOT NULL,
  -- D-11: when the goods arrived. Milestone 1 records it at posting (R6-3: no backdating yet).
  received_at                         timestamptz NULL,
  received_by                         uuid        NULL,
  posted_at                           timestamptz NULL,
  posted_by                           uuid        NULL,
  discarded_at                        timestamptz NULL,
  discarded_by                        uuid        NULL,
  -- The shared backdating columns (§6.7, R6-9); unused until Milestone 2.
  backdate_reason_code                text        NULL,
  backdate_note                       text        NULL,
  reason_after_minutes_snapshot       integer     NULL,
  -- The supplier as it was at posting: the purchase register shows what was true then.
  supplier_name_snapshot              text        NULL,
  supplier_gstin_snapshot             text        NULL,
  supplier_address_snapshot           text        NULL,
  supplier_licence_numbers_snapshot   text[]      NULL,
  supplier_licence_valid_till_snapshot date       NULL,
  CONSTRAINT goods_receipts_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT goods_receipts_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT goods_receipts_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT goods_receipts_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT goods_receipts_location_fk FOREIGN KEY (org_id, premises_id, location_id) REFERENCES stock_locations (org_id, premises_id, id),
  CONSTRAINT goods_receipts_supplier_fk FOREIGN KEY (org_id, supplier_id) REFERENCES suppliers (org_id, id),
  CONSTRAINT goods_receipts_created_by_fk FOREIGN KEY (org_id, created_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT goods_receipts_received_by_fk FOREIGN KEY (org_id, received_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT goods_receipts_posted_by_fk FOREIGN KEY (org_id, posted_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT goods_receipts_discarded_by_fk FOREIGN KEY (org_id, discarded_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT goods_receipts_status CHECK (status IN ('DRAFT','POSTED','REVERSED','DISCARDED')),
  CONSTRAINT goods_receipts_invoice_no CHECK (invoice_no = btrim(invoice_no) AND length(invoice_no) BETWEEN 1 AND 40),
  CONSTRAINT goods_receipts_invoice_total CHECK (invoice_total_paise IS NULL OR invoice_total_paise >= 0),
  CONSTRAINT goods_receipts_notes_len CHECK (notes IS NULL OR length(notes) <= 500),
  CONSTRAINT goods_receipts_draft_lines CHECK (jsonb_typeof(draft_lines) = 'array' AND (status = 'DRAFT' OR draft_lines = '[]'::jsonb)),
  CONSTRAINT goods_receipts_posted CHECK ((status IN ('POSTED','REVERSED')) = (posted_at IS NOT NULL)
    AND (posted_at IS NULL OR (posted_by IS NOT NULL AND received_at IS NOT NULL AND received_by IS NOT NULL
                               AND supplier_name_snapshot IS NOT NULL AND supplier_licence_numbers_snapshot IS NOT NULL
                               AND reason_after_minutes_snapshot IS NOT NULL))),
  CONSTRAINT goods_receipts_discarded CHECK ((status = 'DISCARDED') = (discarded_at IS NOT NULL AND discarded_by IS NOT NULL)),
  -- L-22: never received before the invoice date (IST).
  CONSTRAINT goods_receipts_received_after_invoice CHECK (received_at IS NULL OR ist_date(received_at) >= invoice_date),
  CONSTRAINT goods_receipts_not_future CHECK (received_at IS NULL OR received_at <= posted_at + interval '2 minutes'),
  CONSTRAINT goods_receipts_backdate_reason CHECK (backdate_reason_code IS NULL
    OR backdate_reason_code IN ('SYSTEM_UNAVAILABLE','PAPER_RECORD_ENTERED_LATE','STOCK_USED_BEFORE_INVOICE_KEYED','OTHER')),
  CONSTRAINT goods_receipts_backdate_lag CHECK (received_at IS NULL
    OR posted_at - received_at <= make_interval(mins => reason_after_minutes_snapshot) OR backdate_reason_code IS NOT NULL),
  CONSTRAINT goods_receipts_backdate_note CHECK (backdate_reason_code IS DISTINCT FROM 'OTHER' OR backdate_note IS NOT NULL)
);
-- A supplier's invoice is posted once (409 DUPLICATE_INVOICE); allowed again after a reversal.
CREATE UNIQUE INDEX goods_receipts_invoice_key ON goods_receipts (org_id, supplier_id, lower(invoice_no)) WHERE status = 'POSTED';
CREATE INDEX goods_receipts_list ON goods_receipts (org_id, premises_id, created_at DESC);

CREATE TABLE goods_receipt_lines (
  org_id                        uuid        NOT NULL,
  id                            uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id                   uuid        NOT NULL,
  goods_receipt_id              uuid        NOT NULL,
  line_no                       integer     NOT NULL,
  item_id                       uuid        NOT NULL,
  purchase_unit_id              uuid        NOT NULL,
  base_units_per_unit_snapshot  integer     NOT NULL,
  qty                           integer     NOT NULL,
  free_qty                      integer     NOT NULL DEFAULT 0,
  batch_no                      text        NULL,
  expiry_date                   date        NULL,
  expiry_as_printed             text        NULL,
  mfg_date                      date        NULL,
  mrp_paise                     bigint      NULL,
  mrp_unit_id                   uuid        NULL,
  purchase_rate_paise           bigint      NOT NULL,
  discount_paise                bigint      NOT NULL DEFAULT 0,
  gst_rate_bp                   integer     NULL,
  manufacturer_name_snapshot    text        NULL,
  manufacturer_address_snapshot text        NULL,
  raw_scan_payload              jsonb       NULL,
  batch_id                      uuid        NULL,
  CONSTRAINT goods_receipt_lines_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT goods_receipt_lines_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT goods_receipt_lines_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT goods_receipt_lines_line_key UNIQUE (org_id, goods_receipt_id, line_no),
  CONSTRAINT goods_receipt_lines_receipt_fk FOREIGN KEY (org_id, premises_id, goods_receipt_id) REFERENCES goods_receipts (org_id, premises_id, id),
  CONSTRAINT goods_receipt_lines_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  CONSTRAINT goods_receipt_lines_unit_fk FOREIGN KEY (org_id, item_id, purchase_unit_id) REFERENCES item_units (org_id, item_id, id),
  CONSTRAINT goods_receipt_lines_mrp_unit_fk FOREIGN KEY (org_id, item_id, mrp_unit_id) REFERENCES item_units (org_id, item_id, id),
  CONSTRAINT goods_receipt_lines_batch_fk FOREIGN KEY (org_id, premises_id, item_id, batch_id) REFERENCES batches (org_id, premises_id, item_id, id),
  CONSTRAINT goods_receipt_lines_line_no CHECK (line_no BETWEEN 1 AND 500),
  CONSTRAINT goods_receipt_lines_qty CHECK (qty > 0 AND free_qty >= 0 AND base_units_per_unit_snapshot > 0),
  CONSTRAINT goods_receipt_lines_money CHECK (purchase_rate_paise >= 0 AND discount_paise >= 0
    AND discount_paise <= qty::bigint * purchase_rate_paise AND (mrp_paise IS NULL OR mrp_paise > 0)),
  CONSTRAINT goods_receipt_lines_gst CHECK (gst_rate_bp IS NULL OR gst_rate_bp BETWEEN 0 AND 2800),
  -- A tracked line names its batch with all its details; an untracked line names none.
  CONSTRAINT goods_receipt_lines_batch CHECK (
       (batch_id IS NULL AND batch_no IS NULL AND expiry_date IS NULL)
    OR (batch_id IS NOT NULL AND batch_no IS NOT NULL AND expiry_date IS NOT NULL AND mrp_paise IS NOT NULL AND mrp_unit_id IS NOT NULL)),
  CONSTRAINT goods_receipt_lines_mfg CHECK (mfg_date IS NULL OR expiry_date IS NULL OR mfg_date <= expiry_date)
);
CREATE INDEX goods_receipt_lines_batch ON goods_receipt_lines (org_id, batch_id);

-- L-12: a posted (or discarded) delivery never changes. PR 10's reversals extend this to allow
-- POSTED → REVERSED with its stock_reversals row.
CREATE FUNCTION goods_receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'a posted or discarded delivery never changes' USING ERRCODE = 'P0001', HINT = 'GRN_NOT_DRAFT';
  END IF;
  IF NEW.status NOT IN ('DRAFT','POSTED','DISCARDED') THEN
    RAISE EXCEPTION 'a draft is posted or discarded' USING ERRCODE = 'P0001', HINT = 'GRN_NOT_DRAFT';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.premises_id <> OLD.premises_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a delivery stays where it was created' USING ERRCODE = 'P0001', HINT = 'GRN_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_receipts_guard BEFORE UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_guard();
CREATE TRIGGER goods_receipts_no_delete BEFORE DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Lines are written once, while their delivery is still a draft being posted, and never change.
CREATE FUNCTION goods_receipt_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'delivery lines never change' USING ERRCODE = 'P0001', HINT = 'LEDGER_APPEND_ONLY';
  END IF;
  -- A header this tenant cannot see is left to the composite FK (23503).
  SELECT status INTO st FROM goods_receipts WHERE org_id = NEW.org_id AND id = NEW.goods_receipt_id;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'lines are added only while posting a draft' USING ERRCODE = 'P0001', HINT = 'GRN_NOT_DRAFT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_receipt_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_guard();

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goods_receipts
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goods_receipt_lines
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON goods_receipts TO pharmacy_app;
GRANT SELECT, INSERT ON goods_receipt_lines TO pharmacy_app;
GRANT SELECT ON goods_receipts, goods_receipt_lines TO pharmacy_jobs;
