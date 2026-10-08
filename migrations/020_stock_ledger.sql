-- 020_stock_ledger: Spec 06a §6.6, §7 (L-1 … L-8, L-11, L-13, L-20, L-26). The append-only
-- ledger and its balance cache are one logical change: the cache is defined by the trigger
-- that maintains it. Also the items_freeze trigger (an item's identity is fixed once stock has
-- moved, L-13), which reads stock_movements. Numbered 023 before D-50.

-- ---------------------------------------------------------------- the ledger
CREATE TABLE stock_movements (
  org_id               uuid        NOT NULL,
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  seq                  bigint      GENERATED ALWAYS AS IDENTITY,
  premises_id          uuid        NOT NULL,
  item_id              uuid        NOT NULL,
  batch_id             uuid        NULL,
  location_id          uuid        NOT NULL,
  movement_type        text        NOT NULL,
  qty_delta            integer     NOT NULL,
  reference_type       text        NOT NULL,
  reference_id         uuid        NOT NULL,
  reason_code          text        NULL,
  note                 text        NULL,
  actor_staff_id       uuid        NOT NULL,
  actor_label          text        NOT NULL,
  occurred_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  reverses_movement_id uuid        NULL,
  CONSTRAINT stock_movements_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT stock_movements_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  -- §2.6 rule 4/6: seq orders rows inside the database only; never returned by the API.
  CONSTRAINT stock_movements_seq_key UNIQUE (org_id, seq),
  CONSTRAINT stock_movements_premises_key UNIQUE (org_id, premises_id, id),
  CONSTRAINT stock_movements_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  CONSTRAINT stock_movements_batch_fk FOREIGN KEY (org_id, premises_id, item_id, batch_id) REFERENCES batches (org_id, premises_id, item_id, id),
  CONSTRAINT stock_movements_location_fk FOREIGN KEY (org_id, premises_id, location_id) REFERENCES stock_locations (org_id, premises_id, id),
  CONSTRAINT stock_movements_actor_fk FOREIGN KEY (org_id, actor_staff_id) REFERENCES staff_users (org_id, id),
  CONSTRAINT stock_movements_reverses_fk FOREIGN KEY (org_id, premises_id, reverses_movement_id) REFERENCES stock_movements (org_id, premises_id, id),
  -- L-8: at most one reversal per movement.
  CONSTRAINT stock_movements_reverses_key UNIQUE (org_id, reverses_movement_id),
  CONSTRAINT stock_movements_type CHECK (movement_type IN ('OPENING_BALANCE','RECEIPT','DISPENSE','PROCEDURE_USE','PATIENT_RETURN',
    'SUPPLIER_RETURN','EXPIRY_WRITEOFF','DAMAGE_WRITEOFF','STOCKTAKE_ADJUSTMENT','TRANSFER_OUT','TRANSFER_IN','REVERSAL')),
  CONSTRAINT stock_movements_nonzero CHECK (qty_delta <> 0),
  -- L-4: the sign matches the type.
  CONSTRAINT stock_movements_sign CHECK (
       (movement_type IN ('OPENING_BALANCE','RECEIPT','PATIENT_RETURN','TRANSFER_IN') AND qty_delta > 0)
    OR (movement_type IN ('DISPENSE','PROCEDURE_USE','SUPPLIER_RETURN','EXPIRY_WRITEOFF','DAMAGE_WRITEOFF','TRANSFER_OUT') AND qty_delta < 0)
    OR movement_type IN ('STOCKTAKE_ADJUSTMENT','REVERSAL')),
  -- §7.1: the source-document line each type may name.
  CONSTRAINT stock_movements_reference CHECK (
       (movement_type = 'OPENING_BALANCE' AND reference_type IN ('STOCK_IMPORT_ROW','STOCK_ADJUSTMENT_LINE'))
    OR (movement_type = 'RECEIPT' AND reference_type = 'GOODS_RECEIPT_LINE')
    OR (movement_type = 'DISPENSE' AND reference_type = 'DISPENSE_ALLOCATION')
    OR (movement_type = 'PROCEDURE_USE' AND reference_type = 'PROCEDURE_USE_ALLOCATION')
    OR (movement_type = 'PATIENT_RETURN' AND reference_type = 'PATIENT_RETURN_LINE')
    OR (movement_type = 'SUPPLIER_RETURN' AND reference_type = 'SUPPLIER_RETURN_LINE')
    OR (movement_type IN ('EXPIRY_WRITEOFF','DAMAGE_WRITEOFF') AND reference_type IN ('STOCK_ADJUSTMENT_LINE','PATIENT_RETURN_LINE'))
    OR (movement_type = 'STOCKTAKE_ADJUSTMENT' AND reference_type IN ('STOCK_ADJUSTMENT_LINE','STOCK_TAKE_LINE'))
    OR (movement_type IN ('TRANSFER_OUT','TRANSFER_IN') AND reference_type = 'STOCK_TRANSFER_LINE')
    OR (movement_type = 'REVERSAL' AND reference_type = 'STOCK_REVERSAL')),
  -- L-5: a reason where required; OTHER needs a note.
  CONSTRAINT stock_movements_reason CHECK (reason_code IS NOT NULL
    OR movement_type NOT IN ('EXPIRY_WRITEOFF','DAMAGE_WRITEOFF','STOCKTAKE_ADJUSTMENT','SUPPLIER_RETURN','REVERSAL')),
  CONSTRAINT stock_movements_reason_note CHECK (reason_code IS DISTINCT FROM 'OTHER' OR note IS NOT NULL),
  CONSTRAINT stock_movements_reason_shape CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT stock_movements_note_len CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  CONSTRAINT stock_movements_actor_label_len CHECK (length(btrim(actor_label)) BETWEEN 1 AND 120),
  CONSTRAINT stock_movements_reversal_link CHECK ((movement_type = 'REVERSAL') = (reverses_movement_id IS NOT NULL)),
  -- No future dating; the hard backdating cap (7 days).
  CONSTRAINT stock_movements_not_future CHECK (occurred_at <= recorded_at + interval '2 minutes'),
  CONSTRAINT stock_movements_backdate_cap CHECK (recorded_at - occurred_at <= interval '7 days')
);
-- L-9: a document line posts each movement type at most once (the DB-level double-post guard).
CREATE UNIQUE INDEX stock_movements_natural_key ON stock_movements (org_id, reference_type, reference_id, movement_type)
  WHERE movement_type <> 'REVERSAL';
CREATE INDEX stock_movements_item_time ON stock_movements (org_id, item_id, occurred_at DESC);
CREATE INDEX stock_movements_batch ON stock_movements (org_id, batch_id);
CREATE INDEX stock_movements_time ON stock_movements (org_id, occurred_at);
CREATE INDEX stock_movements_reference ON stock_movements (org_id, reference_type, reference_id);

-- ---------------------------------------------------------------- the balance cache
CREATE TABLE stock_balances (
  org_id            uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id       uuid        NOT NULL,
  item_id           uuid        NOT NULL,
  batch_id          uuid        NULL,
  location_id       uuid        NOT NULL,
  on_hand           integer     NOT NULL,
  last_movement_seq bigint      NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_balances_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT stock_balances_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT stock_balances_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  CONSTRAINT stock_balances_batch_fk FOREIGN KEY (org_id, premises_id, item_id, batch_id) REFERENCES batches (org_id, premises_id, item_id, id),
  CONSTRAINT stock_balances_location_fk FOREIGN KEY (org_id, premises_id, location_id) REFERENCES stock_locations (org_id, premises_id, id),
  CONSTRAINT stock_balances_key UNIQUE NULLS NOT DISTINCT (org_id, premises_id, item_id, batch_id, location_id),
  -- L-3: never negative now.
  CONSTRAINT stock_balances_on_hand CHECK (on_hand >= 0)
);

-- ---------------------------------------------------------------- L-1: append-only
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- L-6, L-7, L-8, L-20, D-14
CREATE FUNCTION stock_movements_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tracked boolean;
  exp date;
  expired boolean := false;
  loc_kind text;
  orig stock_movements%ROWTYPE;
BEGIN
  -- An item, batch or movement this tenant cannot see is left to the composite FKs (23503).
  SELECT track_batches INTO tracked FROM items WHERE org_id = NEW.org_id AND id = NEW.item_id;
  IF tracked IS NOT NULL AND tracked <> (NEW.batch_id IS NOT NULL) THEN
    RAISE EXCEPTION 'batch/tracking mismatch' USING ERRCODE = 'P0001', HINT = 'BATCH_TRACKING_MISMATCH';
  END IF;
  SELECT kind INTO loc_kind FROM stock_locations WHERE org_id = NEW.org_id AND id = NEW.location_id;

  -- L-7: "expired" is the batch's expiry date earlier than the IST date of occurred_at.
  IF NEW.batch_id IS NOT NULL THEN
    SELECT expiry_date INTO exp FROM batches WHERE org_id = NEW.org_id AND id = NEW.batch_id;
    expired := exp < ist_date(NEW.occurred_at);
  END IF;
  IF expired AND NEW.movement_type IN ('DISPENSE','PROCEDURE_USE','RECEIPT') THEN
    RAISE EXCEPTION 'batch expired' USING ERRCODE = 'P0001', HINT = 'BATCH_EXPIRED';
  END IF;
  IF NOT expired AND NEW.movement_type = 'EXPIRY_WRITEOFF' THEN
    RAISE EXCEPTION 'batch not expired' USING ERRCODE = 'P0001', HINT = 'EXPIRY_WRITEOFF_NOT_EXPIRED';
  END IF;
  -- D-14: expired stock entered as an opening balance lands in quarantine, never on the shelf.
  IF expired AND NEW.movement_type = 'OPENING_BALANCE' AND loc_kind IS DISTINCT FROM 'QUARANTINE' THEN
    RAISE EXCEPTION 'expired opening stock goes to quarantine' USING ERRCODE = 'P0001', HINT = 'OPENING_EXPIRED_NOT_QUARANTINED';
  END IF;

  -- L-8: a reversal mirrors its original exactly, and never reverses a reversal.
  IF NEW.movement_type = 'REVERSAL' THEN
    SELECT * INTO orig FROM stock_movements WHERE org_id = NEW.org_id AND id = NEW.reverses_movement_id;
    IF FOUND AND (orig.movement_type = 'REVERSAL' OR orig.item_id <> NEW.item_id
       OR orig.batch_id IS DISTINCT FROM NEW.batch_id OR orig.location_id <> NEW.location_id
       OR NEW.qty_delta <> -orig.qty_delta) THEN
      RAISE EXCEPTION 'reversal does not mirror original' USING ERRCODE = 'P0001', HINT = 'REVERSAL_MISMATCH';
    END IF;
  END IF;

  -- L-20: quarantine is a one-way door to disposal.
  IF NEW.qty_delta < 0 AND loc_kind = 'QUARANTINE'
     AND NEW.movement_type NOT IN ('EXPIRY_WRITEOFF','DAMAGE_WRITEOFF','SUPPLIER_RETURN','REVERSAL') THEN
    RAISE EXCEPTION 'quarantined stock can only be written off or returned' USING ERRCODE = 'P0001', HINT = 'QUARANTINED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movements_validate BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_validate();

-- ---------------------------------------------------------------- L-2, L-3: the cache, in the same transaction
-- SECURITY DEFINER owned by the migrator: the app role has no write privilege on the cache.
-- RLS is forced, so the owner is still held to the transaction's tenant (06a §7.3).
-- Update first, insert if the key is new. (Not INSERT … ON CONFLICT DO UPDATE: Postgres checks
-- CHECK constraints on the proposed insert row before it resolves the conflict, so a negative
-- delta on an existing key would fail on_hand >= 0 even when the update leaves it ≥ 0.) Two
-- transactions creating the same key race on the unique key; the loser loops to the update.
CREATE FUNCTION stock_movements_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  LOOP
    UPDATE stock_balances
       SET on_hand = on_hand + NEW.qty_delta, last_movement_seq = NEW.seq, updated_at = now()
     WHERE org_id = NEW.org_id AND premises_id = NEW.premises_id AND item_id = NEW.item_id
       AND location_id = NEW.location_id AND batch_id IS NOT DISTINCT FROM NEW.batch_id;
    IF FOUND THEN RETURN NULL; END IF;   -- CHECK (on_hand >= 0) fires here if anything slipped through
    INSERT INTO stock_balances (org_id, premises_id, item_id, batch_id, location_id, on_hand, last_movement_seq)
    VALUES (NEW.org_id, NEW.premises_id, NEW.item_id, NEW.batch_id, NEW.location_id, NEW.qty_delta, NEW.seq)
    ON CONFLICT ON CONSTRAINT stock_balances_key DO NOTHING;
    IF FOUND THEN RETURN NULL; END IF;
  END LOOP;
END $$;
CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_apply();

-- ---------------------------------------------------------------- L-3b: backdated rows only (bounded cost)
CREATE FUNCTION stock_movements_asof_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recorded_at - NEW.occurred_at > interval '2 minutes' AND EXISTS (
     SELECT 1 FROM (
       SELECT occurred_at, sum(qty_delta) OVER (ORDER BY occurred_at, seq) AS running
         FROM stock_movements
        WHERE org_id = NEW.org_id AND item_id = NEW.item_id
          AND batch_id IS NOT DISTINCT FROM NEW.batch_id AND location_id = NEW.location_id) r
      WHERE r.occurred_at >= NEW.occurred_at AND r.running < 0) THEN
    RAISE EXCEPTION 'backdated movement makes history negative' USING ERRCODE = 'P0001', HINT = 'INSUFFICIENT_STOCK_AS_OF';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER stock_movements_asof_check AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_asof_check();

-- ---------------------------------------------------------------- L-13: items_freeze (§6.5, R7-5)
CREATE FUNCTION items_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.base_unit, NEW.track_batches, NEW.master_id, NEW.container_unit_id)
       IS DISTINCT FROM (OLD.base_unit, OLD.track_batches, OLD.master_id, OLD.container_unit_id)
     AND EXISTS (SELECT 1 FROM stock_movements WHERE org_id = OLD.org_id AND item_id = OLD.id) THEN
    RAISE EXCEPTION 'an item''s identity is fixed once stock has moved' USING ERRCODE = 'P0001', HINT = 'ITEM_IDENTITY_LOCKED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_freeze BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION items_freeze();

-- ---------------------------------------------------------------- §7.4: rebuild the cache (ops, as the migrator, in a tenant transaction)
CREATE FUNCTION rebuild_balances() RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  changed integer;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'rebuild_balances runs inside a tenant transaction' USING ERRCODE = 'P0001', HINT = 'TENANT_REQUIRED';
  END IF;
  PERFORM 1 FROM stock_balances WHERE org_id = org FOR UPDATE;
  WITH sums AS (
    SELECT premises_id, item_id, batch_id, location_id, sum(qty_delta)::integer AS on_hand, max(seq) AS last_seq
      FROM stock_movements WHERE org_id = org
     GROUP BY premises_id, item_id, batch_id, location_id)
  INSERT INTO stock_balances AS b (org_id, premises_id, item_id, batch_id, location_id, on_hand, last_movement_seq)
  SELECT org, premises_id, item_id, batch_id, location_id, on_hand, last_seq FROM sums
  ON CONFLICT ON CONSTRAINT stock_balances_key DO UPDATE
    SET on_hand = EXCLUDED.on_hand, last_movement_seq = EXCLUDED.last_movement_seq, updated_at = now()
    WHERE b.on_hand <> EXCLUDED.on_hand OR b.last_movement_seq <> EXCLUDED.last_movement_seq;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;

REVOKE ALL ON FUNCTION stock_movements_apply() FROM PUBLIC;
REVOKE ALL ON FUNCTION rebuild_balances() FROM PUBLIC;

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_movements
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_balances
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The app inserts movements and reads both; it never updates or deletes either (L-1, L-15).
GRANT SELECT, INSERT ON stock_movements TO pharmacy_app;
GRANT SELECT ON stock_balances TO pharmacy_app;
-- SELECT … FOR UPDATE needs UPDATE on at least one column: the service locks balance rows (§9.1
-- step 4) but never writes on_hand, so it gets updated_at alone.
GRANT UPDATE (updated_at) ON stock_balances TO pharmacy_app;
GRANT SELECT ON stock_movements, stock_balances TO pharmacy_jobs;
