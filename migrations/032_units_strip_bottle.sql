-- 032_units_strip_bottle: the clinic's units (founder, 2026-11-11: "remove pieces, they want strips for the
-- medicines; for liquids remove ml and add bottle; keep unit, not pieces").
--
-- - items.base_unit and medicine_master.suggested_base_unit also allow STRIP and BOTTLE. ML and PIECE stay
--   ALLOWED so every existing item keeps working: an item's base unit is fixed once stock has moved
--   (items_freeze, 020), and turning ml into bottles would need each bottle's size. The screens no longer
--   OFFER ml or piece for a new item (lib/stock/items.ts NEW_ITEM_UNITS), and show PIECE as "unit".
-- - No row changes: a PIECE item keeps its 'piece' base pack, and the code shows and sends it as "unit"
--   (lib/stock/display.ts unitName; the desk feed in lib/integrations/desk/sync.ts).

ALTER TABLE items DROP CONSTRAINT items_base_unit;
ALTER TABLE items ADD CONSTRAINT items_base_unit
  CHECK (base_unit IN ('TABLET','CAPSULE','STRIP','BOTTLE','ML','G','VIAL','UNIT','PIECE'));

ALTER TABLE medicine_master DROP CONSTRAINT medicine_master_base_unit;
ALTER TABLE medicine_master ADD CONSTRAINT medicine_master_base_unit
  CHECK (suggested_base_unit IS NULL OR suggested_base_unit IN ('TABLET','CAPSULE','STRIP','BOTTLE','ML','G','VIAL','UNIT','PIECE'));
