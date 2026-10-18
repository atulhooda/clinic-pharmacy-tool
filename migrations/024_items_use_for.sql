-- 024_items_use_for: Spec 06a §6.5 (items); D-54. Who an item is for: given to patients (dispensed),
-- used in the clinic during treatment (procedures, IV drips, consultations), or both. Nullable
-- (R6-8, an addition to an earlier table): NULL means the category's default, which the app reads
-- as IN_CLINIC for injectables and consumables and PATIENTS for everything else.
ALTER TABLE items ADD COLUMN use_for text NULL;
ALTER TABLE items ADD CONSTRAINT items_use_for CHECK (use_for IS NULL OR use_for IN ('PATIENTS','IN_CLINIC','BOTH')) NOT VALID;
ALTER TABLE items VALIDATE CONSTRAINT items_use_for;
