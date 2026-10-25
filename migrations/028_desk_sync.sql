-- 028_desk_sync: Spec 06a §6.7 (desk sales and returns), §12.3 (E-52 … E-56), §17; D-57 (founder,
-- 2026-10-22). The desk is the only billing system; its issued bills and credit notes move stock here
-- over a signed HTTP call. Nothing here names a patient: the desk sends a bill id, a serial, line
-- keys, items and quantities only.
--
-- - desk_sync_nonces: each signed request's nonce, single-use for good (06a §12.5). The app role
--   holds no DELETE anywhere (06b DMG-07), so nonces are kept; a request older than the ±120 s
--   window is refused before its nonce is looked at, so the table is only ever a replay record.
-- - desk_sale_lines: one row per bill line received, keyed (bill_id, line_key): the idempotency key.
--   A line is POSTED (fully allocated), SHORT (nothing posted) or REJECTED (nothing posted); never
--   partly allocated. A SHORT or REJECTED line can later be resolved to POSTED by a person, unless
--   a credit note reached it first: then it is CANCELLED (nothing was taken, nothing is owed), for good.
-- - desk_sale_allocations: the batches a posted line took (FEFO), one DISPENSE movement each.
-- - desk_return_lines / desk_return_allocations: a credit note's lines, keyed (credit_note_id,
--   line_key), each naming the sale line it credits (a credit whose sale has not arrived is never
--   stored: the desk retries it), and what each put back: one PATIENT_RETURN movement per allocation, never more than
--   the sale allocation took (a trigger holds the sum).
-- - stock_movements_reference is widened in place (R6-8 as amended by D-57: a CHECK may be dropped
--   and re-added under the same name in one statement when it only admits more): DISPENSE may name
--   a DESK_SALE_ALLOCATION and PATIENT_RETURN a DESK_RETURN_ALLOCATION.

-- ---------------------------------------------------------------- nonces
CREATE TABLE desk_sync_nonces (
  org_id   uuid        NOT NULL,
  id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  nonce    uuid        NOT NULL,
  seen_at  timestamptz NOT NULL,
  CONSTRAINT desk_sync_nonces_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT desk_sync_nonces_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT desk_sync_nonces_key UNIQUE (org_id, nonce)
);
CREATE INDEX desk_sync_nonces_seen ON desk_sync_nonces (org_id, seen_at);

-- ---------------------------------------------------------------- sale lines
CREATE TABLE desk_sale_lines (
  org_id            uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id       uuid        NOT NULL,
  bill_id           uuid        NOT NULL,
  line_key          text        NOT NULL,
  bill_serial       text        NOT NULL,
  issued_at         timestamptz NOT NULL,
  -- As the desk sent it; it may name no item of this organisation (then item_id is null and the line is REJECTED).
  requested_item_id uuid        NOT NULL,
  item_id           uuid        NULL,
  qty_base          integer     NOT NULL,
  status            text        NOT NULL,
  allocated_base    integer     NOT NULL DEFAULT 0,
  short_base        integer     NOT NULL DEFAULT 0,
  reason            text        NULL,
  location_id       uuid        NULL,
  received_at       timestamptz NOT NULL,
  resolved_at       timestamptz NULL,
  resolved_by       uuid        NULL,
  CONSTRAINT desk_sale_lines_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT desk_sale_lines_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT desk_sale_lines_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT desk_sale_lines_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT desk_sale_lines_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  CONSTRAINT desk_sale_lines_location_fk FOREIGN KEY (org_id, premises_id, location_id) REFERENCES stock_locations (org_id, premises_id, id),
  CONSTRAINT desk_sale_lines_resolved_by_fk FOREIGN KEY (org_id, resolved_by) REFERENCES staff_users (org_id, id),
  -- The idempotency key: the same bill line again finds this row and moves nothing.
  CONSTRAINT desk_sale_lines_key UNIQUE (org_id, bill_id, line_key),
  CONSTRAINT desk_sale_lines_line_key CHECK (line_key ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT desk_sale_lines_serial_len CHECK (length(btrim(bill_serial)) BETWEEN 1 AND 40),
  CONSTRAINT desk_sale_lines_qty CHECK (qty_base > 0),
  CONSTRAINT desk_sale_lines_status CHECK (status IN ('POSTED','SHORT','REJECTED','CANCELLED')),
  CONSTRAINT desk_sale_lines_reason CHECK (reason IS NULL OR reason ~ '^[a-z][a-z_]{2,39}$'),
  -- Never partial: all of it, or none of it with the shortfall (or the reason) recorded.
  CONSTRAINT desk_sale_lines_never_partial CHECK (
       (status = 'POSTED' AND allocated_base = qty_base AND short_base = 0 AND item_id IS NOT NULL AND location_id IS NOT NULL AND reason IS NULL)
    OR (status = 'SHORT' AND allocated_base = 0 AND short_base BETWEEN 1 AND qty_base AND item_id IS NOT NULL AND reason IS NOT NULL)
    OR (status = 'REJECTED' AND allocated_base = 0 AND short_base = 0 AND reason IS NOT NULL)
    -- A credit note reached a line that never took stock: closed, nothing taken.
    OR (status = 'CANCELLED' AND allocated_base = 0 AND short_base = 0 AND reason IS NOT NULL)),
  CONSTRAINT desk_sale_lines_resolved CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);
CREATE INDEX desk_sale_lines_open ON desk_sale_lines (org_id, premises_id, received_at DESC) WHERE status IN ('SHORT','REJECTED');

-- What the desk sent never changes; a POSTED or CANCELLED line never changes at all; SHORT and
-- REJECTED lines change only by being retried (to POSTED, or SHORT with a new shortfall) or by a
-- credit note closing them (CANCELLED). A line any credit note has reached never becomes POSTED:
-- stock never goes out for a refunded sale.
CREATE FUNCTION desk_sale_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'POSTED' AND EXISTS (SELECT 1 FROM desk_return_lines r WHERE r.org_id = NEW.org_id AND r.sale_line_id = NEW.id) THEN
    RAISE EXCEPTION 'a credited desk sale line never takes stock' USING ERRCODE = 'P0001', HINT = 'DESK_SALE_CREDITED';
  END IF;
  IF OLD.status IN ('POSTED','CANCELLED')
     OR (NEW.org_id, NEW.premises_id, NEW.bill_id, NEW.line_key, NEW.bill_serial, NEW.issued_at, NEW.requested_item_id, NEW.item_id, NEW.qty_base, NEW.received_at)
        IS DISTINCT FROM (OLD.org_id, OLD.premises_id, OLD.bill_id, OLD.line_key, OLD.bill_serial, OLD.issued_at, OLD.requested_item_id, OLD.item_id, OLD.qty_base, OLD.received_at) THEN
    RAISE EXCEPTION 'a desk sale line changes only by being resolved' USING ERRCODE = 'P0001', HINT = 'DESK_SALE_FIXED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER desk_sale_lines_guard BEFORE UPDATE ON desk_sale_lines
  FOR EACH ROW EXECUTE FUNCTION desk_sale_lines_guard();
CREATE TRIGGER desk_sale_lines_no_delete BEFORE DELETE ON desk_sale_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- sale allocations
CREATE TABLE desk_sale_allocations (
  org_id       uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id  uuid        NOT NULL,
  sale_line_id uuid        NOT NULL,
  alloc_no     integer     NOT NULL,
  item_id      uuid        NOT NULL,
  batch_id     uuid        NULL,
  location_id  uuid        NOT NULL,
  qty_base     integer     NOT NULL,
  created_at   timestamptz NOT NULL,
  CONSTRAINT desk_sale_allocations_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT desk_sale_allocations_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT desk_sale_allocations_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT desk_sale_allocations_line_fk FOREIGN KEY (org_id, premises_id, sale_line_id) REFERENCES desk_sale_lines (org_id, premises_id, id),
  CONSTRAINT desk_sale_allocations_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  CONSTRAINT desk_sale_allocations_batch_fk FOREIGN KEY (org_id, premises_id, item_id, batch_id) REFERENCES batches (org_id, premises_id, item_id, id),
  CONSTRAINT desk_sale_allocations_location_fk FOREIGN KEY (org_id, premises_id, location_id) REFERENCES stock_locations (org_id, premises_id, id),
  CONSTRAINT desk_sale_allocations_no_key UNIQUE (org_id, sale_line_id, alloc_no),
  CONSTRAINT desk_sale_allocations_no CHECK (alloc_no BETWEEN 1 AND 1000),
  CONSTRAINT desk_sale_allocations_qty CHECK (qty_base > 0)
);
CREATE TRIGGER desk_sale_allocations_append_only BEFORE UPDATE OR DELETE ON desk_sale_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- return lines
CREATE TABLE desk_return_lines (
  org_id          uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id     uuid        NOT NULL,
  credit_note_id  uuid        NOT NULL,
  bill_id         uuid        NOT NULL,
  line_key        text        NOT NULL,
  sale_line_id    uuid        NULL,
  qty_base        integer     NOT NULL,
  returned_base   integer     NOT NULL,
  status          text        NOT NULL,
  reason          text        NULL,
  received_at     timestamptz NOT NULL,
  CONSTRAINT desk_return_lines_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT desk_return_lines_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT desk_return_lines_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT desk_return_lines_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT desk_return_lines_sale_fk FOREIGN KEY (org_id, premises_id, sale_line_id) REFERENCES desk_sale_lines (org_id, premises_id, id),
  -- The idempotency key.
  CONSTRAINT desk_return_lines_key UNIQUE (org_id, credit_note_id, line_key),
  CONSTRAINT desk_return_lines_line_key CHECK (line_key ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT desk_return_lines_qty CHECK (qty_base > 0 AND returned_base BETWEEN 0 AND qty_base),
  CONSTRAINT desk_return_lines_status CHECK (status IN ('RETURNED','NOTHING_TO_RETURN')),
  CONSTRAINT desk_return_lines_reason CHECK (reason IS NULL OR reason ~ '^[a-z][a-z_]{2,39}$'),
  CONSTRAINT desk_return_lines_shape CHECK (
       (status = 'RETURNED' AND returned_base > 0 AND sale_line_id IS NOT NULL)
    OR (status = 'NOTHING_TO_RETURN' AND returned_base = 0 AND reason IS NOT NULL AND sale_line_id IS NOT NULL))
);
CREATE INDEX desk_return_lines_sale ON desk_return_lines (org_id, sale_line_id);
CREATE TRIGGER desk_return_lines_append_only BEFORE UPDATE OR DELETE ON desk_return_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- return allocations
CREATE TABLE desk_return_allocations (
  org_id             uuid        NOT NULL,
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id        uuid        NOT NULL,
  return_line_id     uuid        NOT NULL,
  sale_allocation_id uuid        NOT NULL,
  item_id            uuid        NOT NULL,
  batch_id           uuid        NULL,
  location_id        uuid        NOT NULL,
  qty_base           integer     NOT NULL,
  created_at         timestamptz NOT NULL,
  CONSTRAINT desk_return_allocations_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT desk_return_allocations_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT desk_return_allocations_line_fk FOREIGN KEY (org_id, premises_id, return_line_id) REFERENCES desk_return_lines (org_id, premises_id, id),
  CONSTRAINT desk_return_allocations_sale_fk FOREIGN KEY (org_id, premises_id, sale_allocation_id) REFERENCES desk_sale_allocations (org_id, premises_id, id),
  CONSTRAINT desk_return_allocations_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  CONSTRAINT desk_return_allocations_batch_fk FOREIGN KEY (org_id, premises_id, item_id, batch_id) REFERENCES batches (org_id, premises_id, item_id, id),
  CONSTRAINT desk_return_allocations_location_fk FOREIGN KEY (org_id, premises_id, location_id) REFERENCES stock_locations (org_id, premises_id, id),
  CONSTRAINT desk_return_allocations_qty CHECK (qty_base > 0)
);
CREATE INDEX desk_return_allocations_sale ON desk_return_allocations (org_id, sale_allocation_id);
CREATE TRIGGER desk_return_allocations_append_only BEFORE UPDATE OR DELETE ON desk_return_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Never more back than the sale took, from the batch it took it from. The service locks the sale
-- line first, so two credit notes for one line take turns; this is the backstop. An AFTER trigger,
-- so the composite FKs (which fire first) answer a cross-tenant reference.
CREATE FUNCTION desk_return_allocations_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sa desk_sale_allocations%ROWTYPE;
  back integer;
BEGIN
  SELECT * INTO sa FROM desk_sale_allocations WHERE org_id = NEW.org_id AND id = NEW.sale_allocation_id;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- the composite FK answers it
  IF sa.item_id <> NEW.item_id OR sa.batch_id IS DISTINCT FROM NEW.batch_id THEN
    RAISE EXCEPTION 'a return names the batch its sale took' USING ERRCODE = 'P0001', HINT = 'DESK_RETURN_MISMATCH';
  END IF;
  -- AFTER INSERT: the sum already includes NEW.
  SELECT coalesce(sum(qty_base), 0) INTO back FROM desk_return_allocations WHERE org_id = NEW.org_id AND sale_allocation_id = NEW.sale_allocation_id;
  IF back > sa.qty_base THEN
    RAISE EXCEPTION 'a return puts back more than the sale took' USING ERRCODE = 'P0001', HINT = 'DESK_RETURN_EXCEEDS_SALE';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER desk_return_allocations_cap AFTER INSERT ON desk_return_allocations
  FOR EACH ROW EXECUTE FUNCTION desk_return_allocations_cap();

-- ---------------------------------------------------------------- the movement reference, widened
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_reference, ADD CONSTRAINT stock_movements_reference CHECK (
       (movement_type = 'OPENING_BALANCE' AND reference_type IN ('STOCK_IMPORT_ROW','STOCK_ADJUSTMENT_LINE'))
    OR (movement_type = 'RECEIPT' AND reference_type = 'GOODS_RECEIPT_LINE')
    OR (movement_type = 'DISPENSE' AND reference_type IN ('DISPENSE_ALLOCATION','DESK_SALE_ALLOCATION'))
    OR (movement_type = 'PROCEDURE_USE' AND reference_type = 'PROCEDURE_USE_ALLOCATION')
    OR (movement_type = 'PATIENT_RETURN' AND reference_type IN ('PATIENT_RETURN_LINE','DESK_RETURN_ALLOCATION'))
    OR (movement_type = 'SUPPLIER_RETURN' AND reference_type = 'SUPPLIER_RETURN_LINE')
    OR (movement_type IN ('EXPIRY_WRITEOFF','DAMAGE_WRITEOFF') AND reference_type IN ('STOCK_ADJUSTMENT_LINE','PATIENT_RETURN_LINE'))
    OR (movement_type = 'STOCKTAKE_ADJUSTMENT' AND reference_type IN ('STOCK_ADJUSTMENT_LINE','STOCK_TAKE_LINE'))
    OR (movement_type IN ('TRANSFER_OUT','TRANSFER_IN') AND reference_type = 'STOCK_TRANSFER_LINE')
    OR (movement_type = 'REVERSAL' AND reference_type = 'STOCK_REVERSAL')) NOT VALID;
ALTER TABLE stock_movements VALIDATE CONSTRAINT stock_movements_reference;

-- ---------------------------------------------------------------- RLS and grants
ALTER TABLE desk_sync_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_sync_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desk_sync_nonces
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE desk_sale_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_sale_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desk_sale_lines
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE desk_sale_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_sale_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desk_sale_allocations
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE desk_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_return_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desk_return_lines
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE desk_return_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_return_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desk_return_allocations
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Nonces: inserted once, never changed.
GRANT SELECT, INSERT ON desk_sync_nonces TO pharmacy_app;
-- Sale lines: inserted once; only the resolution columns change (the guard holds the rest).
GRANT SELECT, INSERT ON desk_sale_lines TO pharmacy_app;
GRANT UPDATE (status, allocated_base, short_base, reason, location_id, resolved_at, resolved_by) ON desk_sale_lines TO pharmacy_app;
-- Allocations and returns: written once, never changed.
GRANT SELECT, INSERT ON desk_sale_allocations, desk_return_lines, desk_return_allocations TO pharmacy_app;
GRANT SELECT ON desk_sale_lines, desk_sale_allocations, desk_return_lines, desk_return_allocations TO pharmacy_jobs;
