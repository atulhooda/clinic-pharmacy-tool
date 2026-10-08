-- 013_medicine_master: Spec 06a §6.3 (R6-5). The one global catalogue table: no org_id, no RLS
-- (a reviewed exception, §2.6 rule 5). The app reads it; only pharmacy_curator writes it, from
-- the reviewed seed in data/master/ (scripts/load-master.cjs). No drug name is in code (DH-13).

CREATE TABLE medicine_master (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  brand_name            text        NOT NULL,
  manufacturer_name     text        NOT NULL,
  manufacturer_address  text        NULL,
  dosage_form           text        NOT NULL,
  strength_text         text        NULL,
  pack_text             text        NULL,
  suggested_base_unit   text        NULL,
  suggested_units       jsonb       NOT NULL DEFAULT '[]',
  hsn_code              text        NULL,
  salts                 jsonb       NOT NULL DEFAULT '[]',
  schedule_flags        text[]      NOT NULL DEFAULT '{}',
  requires_prescription boolean     NOT NULL DEFAULT false,
  storage_condition     text        NULL,
  source                text        NOT NULL,
  source_ref            text        NOT NULL,
  verified              boolean     NOT NULL DEFAULT false,
  verified_by           text        NULL,
  verified_at           timestamptz NULL,
  version               integer     NOT NULL DEFAULT 1,
  discontinued          boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicine_master_pkey PRIMARY KEY (id),
  CONSTRAINT medicine_master_source_ref_key UNIQUE (source, source_ref),
  CONSTRAINT medicine_master_brand_len CHECK (length(btrim(brand_name)) BETWEEN 1 AND 200),
  CONSTRAINT medicine_master_dosage_form CHECK (dosage_form IN ('TABLET','CAPSULE','SYRUP','SUSPENSION','INJECTION','CREAM','OINTMENT',
    'GEL','LOTION','SOLUTION','DROPS','POWDER','SACHET','SPRAY','SHAMPOO','SOAP','SERUM','PATCH','DEVICE','OTHER')),
  CONSTRAINT medicine_master_base_unit CHECK (suggested_base_unit IS NULL OR suggested_base_unit IN ('TABLET','CAPSULE','ML','G','VIAL','UNIT','PIECE')),
  CONSTRAINT medicine_master_units_array CHECK (jsonb_typeof(suggested_units) = 'array'),
  CONSTRAINT medicine_master_salts_array CHECK (jsonb_typeof(salts) = 'array'),
  CONSTRAINT medicine_master_schedule_flags CHECK (schedule_flags <@ ARRAY['H','H1','X','G','NDPS','H2']::text[]),
  CONSTRAINT medicine_master_storage CHECK (storage_condition IS NULL OR storage_condition IN ('ROOM_TEMPERATURE','BELOW_25C','BELOW_30C','COLD_2_8C','FROZEN')),
  CONSTRAINT medicine_master_version CHECK (version >= 1)
);
CREATE INDEX medicine_master_brand_trgm ON medicine_master USING gin (lower(brand_name) gin_trgm_ops);
CREATE INDEX medicine_master_salts ON medicine_master USING gin (salts jsonb_path_ops);

GRANT SELECT ON medicine_master TO pharmacy_app, pharmacy_jobs;
GRANT SELECT, INSERT, UPDATE ON medicine_master TO pharmacy_curator;
