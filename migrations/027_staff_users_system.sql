-- 027_staff_users_system: Spec 06a §6.1 (staff_users), D-57 (founder, 2026-10-22). A system actor:
-- a staff_users row that stands for another system, so every movement it causes still names an
-- actor (L-1, the actor FK). v1 has one kind, DESK_SYNC ("Ritu Desk"): the desk's bills move stock.
-- The app creates it on first use, one per organisation. It can never sign in:
-- - it is inactive (sign-in refuses an inactive account), with no switch or signing PIN, no phone
--   and no prescriber, so it never appears on the lock screen and can never confirm anything;
-- - its password hash is random bytes that no password produces (the credential CHECK of 005 needs one);
-- - it stays a system actor, and keeps that hash, for good (the guard below).
-- The app role's existing table grants on staff_users (005) cover the new column.
ALTER TABLE staff_users ADD COLUMN system_kind text NULL;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_system_kind CHECK (system_kind IS NULL OR system_kind IN ('DESK_SYNC')) NOT VALID;
ALTER TABLE staff_users VALIDATE CONSTRAINT staff_users_system_kind;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_system_unusable CHECK (
  system_kind IS NULL
  OR (NOT active AND switch_pin_hash IS NULL AND signing_pin_hash IS NULL AND phone_e164 IS NULL AND prescriber_id IS NULL)) NOT VALID;
ALTER TABLE staff_users VALIDATE CONSTRAINT staff_users_system_unusable;
CREATE UNIQUE INDEX staff_users_system_key ON staff_users (org_id, system_kind) WHERE system_kind IS NOT NULL;

-- A person never becomes a system actor, a system actor never becomes a person, and its
-- password hash never changes (a reset could otherwise give it a known password).
CREATE FUNCTION staff_users_system_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.system_kind IS DISTINCT FROM OLD.system_kind
     OR (OLD.system_kind IS NOT NULL AND NEW.password_hash IS DISTINCT FROM OLD.password_hash) THEN
    RAISE EXCEPTION 'a system actor is fixed' USING ERRCODE = 'P0001', HINT = 'SYSTEM_ACTOR_FIXED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_users_system_guard BEFORE UPDATE ON staff_users
  FOR EACH ROW EXECUTE FUNCTION staff_users_system_guard();
