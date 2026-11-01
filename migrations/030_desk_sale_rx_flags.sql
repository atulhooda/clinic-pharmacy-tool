-- 030_desk_sale_rx_flags: D-66 (founder, 2026-11-01: "allowed to put any medicine and everything should be optional").
-- Any active item may now sell through the desk; nothing about the patient, prescriber or prescription gates a
-- sale. What a line was exposed to is recorded instead, on the line, when it is received:
--
-- - desk_sale_lines.rx_flags: the item's prescription, schedule, injectable, consumable and in-clinic flags at
--   the moment the pharmacy received the line ('{}' for an unknown item, and for every line stored before 030).
--   A record, never a gate; the app never recomputes it.
-- - desk_sale_lines_guard: 028's function, with rx_flags added to what never changes. The app role has no
--   UPDATE on the column either (028's column grant leaves it out); the guard holds it for the owner too.

ALTER TABLE desk_sale_lines ADD COLUMN rx_flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE desk_sale_lines ADD CONSTRAINT desk_sale_lines_rx_flags CHECK (rx_flags <@ ARRAY[
  'requires_prescription','schedule_h','schedule_h1','schedule_x','schedule_g','schedule_h2','ndps','injectable','consumable','in_clinic_item']::text[]);

CREATE OR REPLACE FUNCTION desk_sale_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'POSTED' AND EXISTS (SELECT 1 FROM desk_return_lines r WHERE r.org_id = NEW.org_id AND r.sale_line_id = NEW.id) THEN
    RAISE EXCEPTION 'a credited desk sale line never takes stock' USING ERRCODE = 'P0001', HINT = 'DESK_SALE_CREDITED';
  END IF;
  IF OLD.status IN ('POSTED','CANCELLED')
     OR (NEW.org_id, NEW.premises_id, NEW.bill_id, NEW.line_key, NEW.bill_serial, NEW.issued_at, NEW.requested_item_id, NEW.item_id, NEW.qty_base, NEW.received_at, NEW.rx_flags)
        IS DISTINCT FROM (OLD.org_id, OLD.premises_id, OLD.bill_id, OLD.line_key, OLD.bill_serial, OLD.issued_at, OLD.requested_item_id, OLD.item_id, OLD.qty_base, OLD.received_at, OLD.rx_flags) THEN
    RAISE EXCEPTION 'a desk sale line changes only by being resolved' USING ERRCODE = 'P0001', HINT = 'DESK_SALE_FIXED';
  END IF;
  RETURN NEW;
END $$;
