-- 030_desk_sale_rx_flags: D-66 (founder, 2026-11-01: "allowed to put any medicine and everything should be optional").
-- Any active item may now sell through the desk; nothing about the patient, prescriber or prescription gates a
-- sale. What a line was exposed to is recorded instead, on the line, when it is received:
--
-- - desk_sale_lines.rx_flags: the item's prescription, schedule, injectable, consumable and in-clinic flags at
--   the moment the pharmacy received the line ('{}' for an unknown item). A record, never a gate.
--   Every line stored before 030 is NULL: never recorded. Such a line still open (short, or rejected under the
--   older rule) records its flags once, when Retry (E-56) first evaluates it, so the old backlog that now takes
--   stock is flagged too; a posted or cancelled one stays NULL (it took its stock, or never will, before D-66).
-- - desk_sale_lines_guard: 028's function; rx_flags never changes once recorded (NULL to a value, once). The
--   app role gets UPDATE on the column for that one fill; the guard holds it for the owner too.

-- Added without a default, so the lines already stored stay NULL; new lines default to none.
ALTER TABLE desk_sale_lines ADD COLUMN rx_flags text[] NULL;
ALTER TABLE desk_sale_lines ALTER COLUMN rx_flags SET DEFAULT '{}';
ALTER TABLE desk_sale_lines ADD CONSTRAINT desk_sale_lines_rx_flags CHECK (rx_flags <@ ARRAY[
  'requires_prescription','schedule_h','schedule_h1','schedule_x','schedule_g','schedule_h2','ndps','injectable','consumable','in_clinic_item']::text[]);

CREATE OR REPLACE FUNCTION desk_sale_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'POSTED' AND EXISTS (SELECT 1 FROM desk_return_lines r WHERE r.org_id = NEW.org_id AND r.sale_line_id = NEW.id) THEN
    RAISE EXCEPTION 'a credited desk sale line never takes stock' USING ERRCODE = 'P0001', HINT = 'DESK_SALE_CREDITED';
  END IF;
  IF OLD.status IN ('POSTED','CANCELLED')
     OR (NEW.org_id, NEW.premises_id, NEW.bill_id, NEW.line_key, NEW.bill_serial, NEW.issued_at, NEW.requested_item_id, NEW.item_id, NEW.qty_base, NEW.received_at)
        IS DISTINCT FROM (OLD.org_id, OLD.premises_id, OLD.bill_id, OLD.line_key, OLD.bill_serial, OLD.issued_at, OLD.requested_item_id, OLD.item_id, OLD.qty_base, OLD.received_at)
     OR (OLD.rx_flags IS NOT NULL AND NEW.rx_flags IS DISTINCT FROM OLD.rx_flags) THEN
    RAISE EXCEPTION 'a desk sale line changes only by being resolved' USING ERRCODE = 'P0001', HINT = 'DESK_SALE_FIXED';
  END IF;
  RETURN NEW;
END $$;

-- The one fill of a line stored before 030 (E-56); the guard refuses any other change to it.
GRANT UPDATE (rx_flags) ON desk_sale_lines TO pharmacy_app;
