-- 025_batches_details_pending: Spec 06a §6.6 (batches); D-55. Stock counted from a list that has no
-- batch number, expiry or MRP is held on one placeholder batch per item and premises, marked
-- details_pending, until someone reads them off the pack. Nullable (R6-8): NULL and false mean a real
-- batch. A placeholder carries fixed values that the app never shows: batch_no 'DETAILS PENDING',
-- expiry 2099-12-31 (so it is never "expired" or "near expiry"), MRP 1 paisa per base unit.
ALTER TABLE batches ADD COLUMN details_pending boolean NULL;
ALTER TABLE batches ADD CONSTRAINT batches_details_pending CHECK (
  (details_pending IS TRUE) = (batch_no = 'DETAILS PENDING')
  AND (details_pending IS NOT TRUE OR (expiry_date = DATE '2099-12-31' AND mrp_paise = 1))) NOT VALID;
ALTER TABLE batches VALIDATE CONSTRAINT batches_details_pending;
