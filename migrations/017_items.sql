-- 017_items: Spec 06a §6.5 (D-23, D-32). One catalogue per organisation: items and their pack
-- units (a direct factor to the base unit). Includes the nullable multi-dose columns (P1-C,
-- R6-9). The items_freeze trigger (identity locked once stock has moved) needs the ledger and
-- comes with it in 023 (PR 7).

CREATE TABLE items (
  org_id                      uuid        NOT NULL,
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  master_id                   uuid        NULL,
  category                    text        NOT NULL,
  display_name                text        NOT NULL,
  base_unit                   text        NOT NULL,
  track_batches               boolean     NOT NULL,
  extra_schedule_flags        text[]      NOT NULL DEFAULT '{}',
  requires_prescription       boolean     NOT NULL DEFAULT false,
  custom_manufacturer_name    text        NULL,
  custom_manufacturer_address text        NULL,
  hsn_code_override           text        NULL,
  storage_condition           text        NULL,
  reorder_level               integer     NULL,
  reorder_qty                 integer     NULL,
  rack_location               text        NULL,
  container_unit_id           uuid        NULL,
  in_use_hours                integer     NULL,
  active                      boolean     NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT items_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT items_master_fk FOREIGN KEY (master_id) REFERENCES medicine_master (id) ON DELETE RESTRICT,
  CONSTRAINT items_category CHECK (category IN ('MEDICINE','RETAIL_PRODUCT','INJECTABLE','CONSUMABLE')),
  CONSTRAINT items_display_name_len CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT items_base_unit CHECK (base_unit IN ('TABLET','CAPSULE','ML','G','VIAL','UNIT','PIECE')),
  CONSTRAINT items_track_batches CHECK (track_batches OR category = 'CONSUMABLE'),
  CONSTRAINT items_extra_flags CHECK (extra_schedule_flags <@ ARRAY['H','H1','X','G','NDPS','H2']::text[]),
  CONSTRAINT items_storage CHECK (storage_condition IS NULL OR storage_condition IN ('ROOM_TEMPERATURE','BELOW_25C','BELOW_30C','COLD_2_8C','FROZEN')),
  CONSTRAINT items_reorder_level CHECK (reorder_level IS NULL OR reorder_level >= 0),
  CONSTRAINT items_reorder_qty CHECK (reorder_qty IS NULL OR reorder_qty > 0),
  CONSTRAINT items_in_use_hours CHECK (in_use_hours IS NULL OR in_use_hours > 0),
  CONSTRAINT items_container_pair CHECK ((container_unit_id IS NULL) = (in_use_hours IS NULL))
);
CREATE UNIQUE INDEX items_display_name_key ON items (org_id, lower(display_name));
CREATE UNIQUE INDEX items_master_key ON items (org_id, master_id) WHERE master_id IS NOT NULL;
CREATE INDEX items_name_trgm ON items USING gin (lower(display_name) gin_trgm_ops);

CREATE TABLE item_units (
  org_id              uuid        NOT NULL,
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  item_id             uuid        NOT NULL,
  name                text        NOT NULL,
  base_units_per_unit integer     NOT NULL,
  is_base             boolean     NOT NULL DEFAULT false,
  dispensable         boolean     NOT NULL DEFAULT true,
  purchasable         boolean     NOT NULL DEFAULT true,
  active              boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_units_pkey PRIMARY KEY (org_id, id),
  CONSTRAINT item_units_org_fk FOREIGN KEY (org_id) REFERENCES organisations (id) ON DELETE RESTRICT,
  CONSTRAINT item_units_item_fk FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id),
  CONSTRAINT item_units_item_key UNIQUE (org_id, item_id, id),
  CONSTRAINT item_units_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT item_units_factor CHECK (base_units_per_unit > 0),
  CONSTRAINT item_units_base_factor CHECK (NOT is_base OR base_units_per_unit = 1)
);
CREATE UNIQUE INDEX item_units_name_key ON item_units (org_id, item_id, lower(name));
CREATE UNIQUE INDEX item_units_base_key ON item_units (org_id, item_id) WHERE is_base;

-- P1-C: the opened container is a unit OF THIS ITEM.
ALTER TABLE items ADD CONSTRAINT items_container_unit_fk
  FOREIGN KEY (org_id, id, container_unit_id) REFERENCES item_units (org_id, item_id, id);

-- §6.5: a unit's factor never changes (deactivate it and add another); a unit never moves
-- to another item.
CREATE FUNCTION item_units_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_units_per_unit <> OLD.base_units_per_unit OR NEW.item_id <> OLD.item_id OR NEW.is_base <> OLD.is_base THEN
    RAISE EXCEPTION 'a unit''s factor, item and base flag are immutable' USING ERRCODE = 'P0001', HINT = 'UNIT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_units_guard BEFORE UPDATE ON item_units
  FOR EACH ROW EXECUTE FUNCTION item_units_guard();

-- D-32: requires_prescription stays true while the linked master has it, or while the item's
-- effective schedule flags (master ∪ extra) include X. The service answers 422 first; this is
-- the guarantee (06b DG-10).
CREATE FUNCTION items_requires_prescription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m_rx boolean := false;
  m_flags text[] := '{}';
BEGIN
  IF NEW.master_id IS NOT NULL THEN
    SELECT requires_prescription, schedule_flags INTO m_rx, m_flags FROM medicine_master WHERE id = NEW.master_id;
  END IF;
  IF NOT NEW.requires_prescription AND (coalesce(m_rx, false) OR 'X' = ANY (coalesce(m_flags, '{}') || NEW.extra_schedule_flags)) THEN
    RAISE EXCEPTION 'requires_prescription is imposed by the master or Schedule X' USING ERRCODE = 'P0001', HINT = 'REQUIRES_PRESCRIPTION_IMPOSED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_requires_prescription BEFORE INSERT OR UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION items_requires_prescription();

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON items
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE item_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_units
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON items, item_units TO pharmacy_app;
GRANT SELECT ON items, item_units TO pharmacy_jobs;
