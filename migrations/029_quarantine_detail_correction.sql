-- 029_quarantine_detail_correction: Spec 06a §7.2 L-20; D-61 (founder, 2026-10-26). Quarantine stays a one-way
-- door to disposal, with one exception: correcting a batch's details (BATCH_DETAILS_CORRECTED count corrections,
-- written as a pair by the service) may move stock out, e.g. an expiry typed as 2026 that is really 2028.
-- Only the L-20 condition changes; the rest of the function is 020's.
CREATE OR REPLACE FUNCTION stock_movements_validate() RETURNS trigger
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
  -- D-61: or a correction of the batch's details (a wrong expiry typed in), which moves it as a pair.
  IF NEW.qty_delta < 0 AND loc_kind = 'QUARANTINE'
     AND NEW.movement_type NOT IN ('EXPIRY_WRITEOFF','DAMAGE_WRITEOFF','SUPPLIER_RETURN','REVERSAL')
     AND NOT (NEW.movement_type = 'STOCKTAKE_ADJUSTMENT' AND NEW.reason_code = 'BATCH_DETAILS_CORRECTED') THEN
    RAISE EXCEPTION 'quarantined stock can only be written off or returned' USING ERRCODE = 'P0001', HINT = 'QUARANTINED';
  END IF;
  RETURN NEW;
END $$;
