-- 026_items_note: Spec 06a §6.5 (items); D-56. A short free-text note on an item, shown on the Stock
-- page, for what the clinic still has to do about it ("enter the quantity", "pack size?"). Nullable
-- (R6-8). No patient content: it is about the product.
ALTER TABLE items ADD COLUMN note text NULL;
ALTER TABLE items ADD CONSTRAINT items_note_len CHECK (note IS NULL OR length(note) BETWEEN 1 AND 300) NOT VALID;
ALTER TABLE items VALIDATE CONSTRAINT items_note_len;
