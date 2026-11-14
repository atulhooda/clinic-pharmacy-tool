-- 033_units_tube: Spec 06a §6.5; D-69 (the pilot clinic, 2026-11-14: "only keep tubes, bottles, strips, units").
-- New items are counted in a strip, bottle, tube or unit; TUBE joins the base units. The older units stay
-- allowed for existing items (items_freeze), and the screens offer them only through a pack. No rows change.
ALTER TABLE items DROP CONSTRAINT items_base_unit, ADD CONSTRAINT items_base_unit
  CHECK (base_unit IN ('TABLET','CAPSULE','STRIP','BOTTLE','TUBE','ML','G','VIAL','UNIT','PIECE'));

ALTER TABLE medicine_master DROP CONSTRAINT medicine_master_base_unit, ADD CONSTRAINT medicine_master_base_unit
  CHECK (suggested_base_unit IS NULL OR suggested_base_unit IN ('TABLET','CAPSULE','STRIP','BOTTLE','TUBE','ML','G','VIAL','UNIT','PIECE'));
