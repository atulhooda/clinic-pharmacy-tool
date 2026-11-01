-- 031_desk_sale_party: D-67 (founder, 2026-11-01: "desk sales should show everything updated"). The Desk sales
-- page shows, per bill, the patient and the doctor when the desk had them, and per line which credit note put
-- stock back. Amends 028's "nothing here names a patient": the desk may now send a bill's patient display name,
-- its own patient id and the doctor's name. All optional, never a gate (D-66 stands).
--
-- - desk_sale_bills: one row per bill whose sale carried any of them, keyed (org_id, bill_id). Written once, the
--   first time a sale (E-53) for the bill carries one (a resend of a bill stored before 031 fills it then), never
--   changed: an issued bill never changes at the desk. A bill without a row simply shows no patient or doctor.
--   patient_ref is the desk's own patient id (a uuid the pharmacy never resolves), not a pharmacy patient.
-- - desk_return_lines.credit_note_serial: the credit note's number as the desk printed it, when the desk sends
--   it (E-54 `serial`); NULL for every return stored before 031 and for a desk that does not send it.

-- ---------------------------------------------------------------- sale bills
CREATE TABLE desk_sale_bills (
  org_id       uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  premises_id  uuid        NOT NULL,
  bill_id      uuid        NOT NULL,
  patient_name text        NULL,
  patient_ref  uuid        NULL,
  doctor_name  text        NULL,
  received_at  timestamptz NOT NULL,
  CONSTRAINT desk_sale_bills_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT desk_sale_bills_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT desk_sale_bills_premises_fk FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id),
  CONSTRAINT desk_sale_bills_key UNIQUE (org_id, bill_id),
  CONSTRAINT desk_sale_bills_patient_name CHECK (patient_name IS NULL OR (length(btrim(patient_name)) BETWEEN 1 AND 120 AND patient_name !~ '[[:cntrl:]]')),
  CONSTRAINT desk_sale_bills_doctor_name CHECK (doctor_name IS NULL OR (length(btrim(doctor_name)) BETWEEN 1 AND 120 AND doctor_name !~ '[[:cntrl:]]')),
  -- A row exists only to say something.
  CONSTRAINT desk_sale_bills_some CHECK (patient_name IS NOT NULL OR patient_ref IS NOT NULL OR doctor_name IS NOT NULL)
);
CREATE TRIGGER desk_sale_bills_append_only BEFORE UPDATE OR DELETE ON desk_sale_bills
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE desk_sale_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_sale_bills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desk_sale_bills
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT ON desk_sale_bills TO pharmacy_app;
GRANT SELECT ON desk_sale_bills TO pharmacy_jobs;

-- ---------------------------------------------------------------- the credit note's number
-- Added without a default: every return already stored stays NULL (desk_return_lines is append-only).
ALTER TABLE desk_return_lines ADD COLUMN credit_note_serial text NULL;
ALTER TABLE desk_return_lines ADD CONSTRAINT desk_return_lines_serial_len CHECK (
  credit_note_serial IS NULL OR (length(btrim(credit_note_serial)) BETWEEN 1 AND 40 AND credit_note_serial !~ '[[:cntrl:]]'));
