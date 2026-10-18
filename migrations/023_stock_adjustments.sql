-- 023_stock_adjustments: Spec 06a §6.7 (stock_adjustments), §9.3 adjust_stock, E-34; D-53 (PR 10a,
-- pulled forward from PR 10, numbered 028 before). An adjustment is written and posted in one
-- transaction: a header, its lines and one movement per line, never changed afterwards.
--
-- Milestone 1 (PR 10a) posts two kinds: OPENING_BALANCE (stock already on the shelf, on a key with
-- no movement yet) and STOCKTAKE_ADJUSTMENT (a count correction, ±). The write-off kinds are in the
-- CHECK already, for PR 10. A line's location is its own (expired opening stock goes to quarantine,
-- D-14), and the composite FK keeps it inside the header's premises.

CREATE TABLE stock_adjustments (
  org_id       uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id  uuid        NOT NULL,
  kind         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'POSTED',
  reason_code  text        NULL,
  note         text        NULL,
  created_by   uuid        NOT NULL,
  occurred_at  timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL,
  CONSTRAINT stock_adjustments_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT stock_adjustments_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT stock_adjustments_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT stock_adjustments_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT stock_adjustments_created_by_fk FOREIGN KEY (org_id, created_by) REFERENCES staff_users (org_id, id),
  CONSTRAINT stock_adjustments_kind CHECK (kind IN ('EXPIRY_WRITEOFF','DAMAGE_WRITEOFF','STOCKTAKE_ADJUSTMENT','OPENING_BALANCE')),
  CONSTRAINT stock_adjustments_status CHECK (status IN ('POSTED','REVERSED')),
  -- §7.1: every kind but an opening balance carries a reason; OTHER needs a note.
  CONSTRAINT stock_adjustments_reason CHECK (reason_code IS NOT NULL OR kind = 'OPENING_BALANCE'),
  CONSTRAINT stock_adjustments_reason_shape CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT stock_adjustments_reason_note CHECK (reason_code IS DISTINCT FROM 'OTHER' OR note IS NOT NULL),
  CONSTRAINT stock_adjustments_note_len CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  -- Adjustments are never backdated (06a §11.4): recorded at server time.
  CONSTRAINT stock_adjustments_not_backdated CHECK (occurred_at = recorded_at)
);
CREATE INDEX stock_adjustments_list ON stock_adjustments (org_id, premises_id, recorded_at DESC);

CREATE TABLE stock_adjustment_lines (
  org_id               uuid    NOT NULL,
  id                   uuid    NOT NULL DEFAULT gen_random_uuid(),
  premises_id          uuid    NOT NULL,
  adjustment_id        uuid    NOT NULL,
  line_no              integer NOT NULL,
  item_id              uuid    NOT NULL,
  batch_id             uuid    NULL,
  location_id          uuid    NOT NULL,
  qty_delta            integer NOT NULL,
  -- What the person counted, in base units, when they entered a count (null for a plain delta).
  counted_base         integer NULL,
  opened_container_id  uuid    NULL,
  CONSTRAINT stock_adjustment_lines_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT stock_adjustment_lines_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT stock_adjustment_lines_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT stock_adjustment_lines_line_key UNIQUE (org_id, adjustment_id, line_no),
  CONSTRAINT stock_adjustment_lines_header_fk FOREIGN KEY (org_id, premises_id, adjustment_id) REFERENCES stock_adjustments (org_id, premises_id, id),
  CONSTRAINT stock_adjustment_lines_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  CONSTRAINT stock_adjustment_lines_batch_fk FOREIGN KEY (org_id, premises_id, item_id, batch_id) REFERENCES batches (org_id, premises_id, item_id, id),
  CONSTRAINT stock_adjustment_lines_location_fk FOREIGN KEY (org_id, premises_id, location_id) REFERENCES stock_locations (org_id, premises_id, id),
  CONSTRAINT stock_adjustment_lines_line_no CHECK (line_no BETWEEN 1 AND 500),
  CONSTRAINT stock_adjustment_lines_qty CHECK (qty_delta <> 0),
  CONSTRAINT stock_adjustment_lines_counted CHECK (counted_base IS NULL OR counted_base >= 0)
);
CREATE INDEX stock_adjustment_lines_item ON stock_adjustment_lines (org_id, item_id);

-- Posted at creation: a header changes only to REVERSED (PR 10's reversals), and never moves.
CREATE FUNCTION stock_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED')
     OR (NEW.org_id, NEW.premises_id, NEW.kind, NEW.reason_code, NEW.note, NEW.created_by, NEW.occurred_at, NEW.recorded_at)
        IS DISTINCT FROM (OLD.org_id, OLD.premises_id, OLD.kind, OLD.reason_code, OLD.note, OLD.created_by, OLD.occurred_at, OLD.recorded_at) THEN
    RAISE EXCEPTION 'a posted adjustment never changes' USING ERRCODE = 'P0001', HINT = 'LEDGER_APPEND_ONLY';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_adjustments_guard BEFORE UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION stock_adjustments_guard();
CREATE TRIGGER stock_adjustments_no_delete BEFORE DELETE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_adjustment_lines_append_only BEFORE UPDATE OR DELETE ON stock_adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_adjustments
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE stock_adjustment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustment_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_adjustment_lines
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The app writes them once. PR 10 grants UPDATE on the header with reversals; the guard already holds it to POSTED → REVERSED.
GRANT SELECT, INSERT ON stock_adjustments, stock_adjustment_lines TO pharmacy_app;
GRANT SELECT ON stock_adjustments, stock_adjustment_lines TO pharmacy_jobs;
