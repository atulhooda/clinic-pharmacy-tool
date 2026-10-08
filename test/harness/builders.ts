// Builders for the generated tenant-integrity tests (06b DS-20, DS-21).
//
// DS-20: one entry per FK between tenant tables (named by constraint). Inside withTenant(A) it
//        writes a row whose reference points at org B's parent row, and returns the Postgres
//        error code (expected '23503').
// DS-21: one entry per unique index on a tenant table. It writes the same key in A and in B
//        (expected 'ok'), then again in A (expected '23505').
//
// The tests compare these maps with the catalog: a new FK or unique without a builder fails.
import { randomUUID } from 'crypto';
import pg from 'pg';
import { urls, pgCode } from './env';
import { withTenant } from '../../lib/db/tenant';
import { hashPassword } from '../../lib/auth/password';
import { createOrg, createStaff, createPrescriber, createDeviceAndSession, inOrg, type OrgFixture } from './fixtures';

type FkBuilder = (a: OrgFixture, b: OrgFixture) => Promise<string>;
type UniqueBuilder = (a: OrgFixture, b: OrgFixture) => Promise<{ otherOrg: string; sameOrg: string }>;

async function inTenant(org: OrgFixture, sql: string, params: unknown[], role: 'app' | 'migrator' = 'app'): Promise<string> {
  const pool = new pg.Pool({ connectionString: urls[role], max: 1 });
  try {
    return await pgCode(withTenant(org.orgId, (db) => db.rows(sql, params), pool)).then((c) => (c === 'no-error' ? 'ok' : c));
  } finally {
    await pool.end();
  }
}

/** Parents in an organisation that the builders point at. */
interface World {
  staffId: string;
  prescriberId: string;
  deviceId: string;
  sessionId: string;
  settingsId: string;
  stockSettingsId: string;
  premisesSettingsId: string;
  itemId: string;
  unitId: string;
  /** An item with no stock movements, so its identity can still change (items_freeze). */
  bareItemId: string;
  locationId: string;
  batchId: string;
  /** An OPENING_BALANCE of +100 of batchId at locationId. */
  movementId: string;
}
const worlds = new Map<string, World>();
async function world(org: OrgFixture): Promise<World> {
  const cached = worlds.get(org.orgId);
  if (cached) return cached;
  const staff = await createStaff(org, { role: 'owner' });
  const prescriberId = await createPrescriber(org);
  const { deviceId, sessionId } = await createDeviceAndSession(org, staff.id);
  const settingsId = await inOrg(org.orgId, async (c) => (await c.query('SELECT id FROM org_settings')).rows[0].id as string);
  // A role key that exists only in this organisation.
  await inOrg(org.orgId, (c) => c.query("INSERT INTO org_roles (org_id, key, name) VALUES ($1, $2, 'Only here')", [org.orgId, `only_${org.orgId.slice(0, 6)}`]));
  const stock = await inOrg(org.orgId, async (c) => {
    const stockSettingsId = (await c.query('INSERT INTO stock_settings (org_id) VALUES ($1) RETURNING id', [org.orgId])).rows[0].id as string;
    const premisesSettingsId = (await c.query(`INSERT INTO premises_settings (org_id, premises_id, dispensing_mode) VALUES ($1, $2, 'RMP_OWN_PATIENTS') RETURNING id`,
      [org.orgId, org.premisesId])).rows[0].id as string;
    const itemId = (await c.query(`INSERT INTO items (org_id, category, display_name, base_unit, track_batches) VALUES ($1, 'MEDICINE', $2, 'TABLET', true) RETURNING id`,
      [org.orgId, `World item ${org.orgId.slice(0, 6)}`])).rows[0].id as string;
    const unitId = (await c.query(`INSERT INTO item_units (org_id, item_id, name, base_units_per_unit) VALUES ($1, $2, 'strip', 10) RETURNING id`,
      [org.orgId, itemId])).rows[0].id as string;
    const locationId = (await c.query(`INSERT INTO stock_locations (org_id, premises_id, name, kind, is_default) VALUES ($1, $2, 'World store', 'STORE', true) RETURNING id`,
      [org.orgId, org.premisesId])).rows[0].id as string;
    const batchId = (await c.query(`INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id) VALUES ($1, $2, $3, 'W1', '2099-12-31', 1000, $4) RETURNING id`,
      [org.orgId, org.premisesId, itemId, unitId])).rows[0].id as string;
    const movementId = (await c.query(`INSERT INTO stock_movements (org_id, premises_id, item_id, batch_id, location_id, movement_type, qty_delta, reference_type, reference_id,
                                                                    actor_staff_id, actor_label, occurred_at, recorded_at)
                                       VALUES ($1, $2, $3, $4, $5, 'OPENING_BALANCE', 100, 'STOCK_ADJUSTMENT_LINE', gen_random_uuid(), $6, 'World', now(), now()) RETURNING id`,
      [org.orgId, org.premisesId, itemId, batchId, locationId, staff.id])).rows[0].id as string;
    const bareItemId = (await c.query(`INSERT INTO items (org_id, category, display_name, base_unit, track_batches) VALUES ($1, 'INJECTABLE', $2, 'UNIT', true) RETURNING id`,
      [org.orgId, `Bare item ${org.orgId.slice(0, 6)}`])).rows[0].id as string;
    return { stockSettingsId, premisesSettingsId, itemId, unitId, bareItemId, locationId, batchId, movementId };
  });
  const w = { staffId: staff.id, prescriberId, deviceId, sessionId, settingsId, ...stock };
  worlds.set(org.orgId, w);
  return w;
}
const onlyKey = (org: OrgFixture) => `only_${org.orgId.slice(0, 6)}`;

/** A movement row in o (as the app role unless stated); returns the Postgres error code or 'ok'. */
function movement(o: OrgFixture, v: { premisesId?: string; itemId: string; batchId: string | null; locationId: string; actor: string;
  type?: string; qty?: number; refType?: string; refId?: string; reverses?: string | null; seq?: number }): Promise<string> {
  const cols = `org_id, premises_id, item_id, batch_id, location_id, movement_type, qty_delta, reference_type, reference_id,
                actor_staff_id, actor_label, occurred_at, recorded_at, reverses_movement_id, reason_code`;
  const reversal = v.type === 'REVERSAL';
  const vals = [o.orgId, v.premisesId ?? o.premisesId, v.itemId, v.batchId, v.locationId, v.type ?? 'OPENING_BALANCE', v.qty ?? 1,
    v.refType ?? (reversal ? 'STOCK_REVERSAL' : 'STOCK_ADJUSTMENT_LINE'), v.refId ?? randomUUID(), v.actor, v.reverses ?? null,
    reversal ? 'DATA_ENTRY_ERROR' : null];
  if (v.seq !== undefined) {
    return inTenant(o, `INSERT INTO stock_movements (${cols}, seq) OVERRIDING SYSTEM VALUE
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'B', now(), now(), $11, $12, $13)`, [...vals, v.seq]);
  }
  return inTenant(o, `INSERT INTO stock_movements (${cols}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'B', now(), now(), $11, $12)`, vals);
}

let hashCache: string | undefined;
const aHash = async () => (hashCache ??= await hashPassword('builder-password-1'));
async function insertStaff(org: OrgFixture, extra: { login?: string; name?: string; phone?: string | null; prescriberId?: string | null; role?: string }) {
  const id = randomUUID();
  const code = await inTenant(org, `INSERT INTO staff_users (org_id, id, name, login, role_key, password_hash, phone_e164, prescriber_id)
                                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [org.orgId, id, extra.name ?? `N ${id.slice(0, 8)}`, extra.login ?? `l${id.slice(0, 8)}`, extra.role ?? 'reception', await aHash(), extra.phone ?? null, extra.prescriberId ?? null]);
  return { id, code };
}

export const FK_BUILDERS: Record<string, FkBuilder> = {
  async org_settings_history_settings_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, `INSERT INTO org_settings_history (org_id, settings_id, device_lock_minutes, day_reset_time_ist, version, valid_from)
                        VALUES ($1, $2, 3, '04:00', 1, now())`, [a.orgId, wb.settingsId]);
  },
  async org_settings_updated_by_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, 'UPDATE org_settings SET updated_by = $2 WHERE org_id = $1', [a.orgId, wb.staffId]);
  },
  async org_settings_history_changed_by_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO org_settings_history (org_id, settings_id, device_lock_minutes, day_reset_time_ist, version, changed_by, valid_from)
                        VALUES ($1, $2, 3, '04:00', 1, $3, now())`, [a.orgId, wa.settingsId, wb.staffId]);
  },
  async role_grants_role_fk(a, b) {
    await world(b);
    return inTenant(a, "INSERT INTO role_grants (org_id, role_key, permission, allowed) VALUES ($1, $2, 'stock.view', true)", [a.orgId, onlyKey(b)]);
  },
  async role_grants_updated_by_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, "INSERT INTO role_grants (org_id, role_key, permission, allowed, updated_by) VALUES ($1, 'doctor', 'stock.items', true, $2)", [a.orgId, wb.staffId]);
  },
  async staff_users_role_fk(a, b) {
    await world(b);
    return (await insertStaff(a, { role: onlyKey(b) })).code;
  },
  async staff_users_prescriber_fk(a, b) {
    const wb = await world(b);
    return (await insertStaff(a, { prescriberId: wb.prescriberId })).code;
  },
  async staff_premises_staff_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, 'INSERT INTO staff_premises (org_id, staff_user_id, premises_id) VALUES ($1, $2, $3)', [a.orgId, wb.staffId, a.premisesId]);
  },
  async staff_premises_premises_fk(a, b) {
    const wa = await world(a);
    return inTenant(a, 'INSERT INTO staff_premises (org_id, staff_user_id, premises_id) VALUES ($1, $2, $3)', [a.orgId, wa.staffId, b.premisesId]);
  },
  async devices_premises_fk(a, b) {
    const wa = await world(a);
    return inTenant(a, "INSERT INTO devices (org_id, premises_id, name, registered_by) VALUES ($1, $2, 'X1', $3)", [a.orgId, b.premisesId, wa.staffId]);
  },
  async devices_registered_by_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, "INSERT INTO devices (org_id, premises_id, name, registered_by) VALUES ($1, $2, 'X2', $3)", [a.orgId, a.premisesId, wb.staffId]);
  },
  async devices_revoked_by_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO devices (org_id, premises_id, name, registered_by, revoked_at, revoked_by)
                        VALUES ($1, $2, 'X3', $3, now(), $4)`, [a.orgId, a.premisesId, wa.staffId, wb.staffId]);
  },
  async sessions_staff_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, `INSERT INTO sessions (org_id, staff_user_id, method, created_at, expires_at, last_input_at)
                        VALUES ($1, $2, 'PASSWORD', now(), now() + interval '1 hour', now())`, [a.orgId, wb.staffId]);
  },
  async sessions_device_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO sessions (org_id, staff_user_id, device_id, method, created_at, expires_at, last_input_at)
                        VALUES ($1, $2, $3, 'PASSWORD', now(), now() + interval '1 hour', now())`, [a.orgId, wa.staffId, wb.deviceId]);
  },
  async device_state_device_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, 'INSERT INTO device_state (org_id, device_id) VALUES ($1, $2)', [a.orgId, wb.deviceId]);
  },
  async reauth_grants_session_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO reauth_grants (org_id, session_id, staff_user_id, purpose, entity_id, created_at, expires_at)
                        VALUES ($1, $2, $3, 'stock.adjust', $4, now(), now() + interval '2 minutes')`, [a.orgId, wb.sessionId, wa.staffId, a.premisesId]);
  },
  async reauth_grants_staff_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO reauth_grants (org_id, session_id, staff_user_id, purpose, entity_id, created_at, expires_at)
                        VALUES ($1, $2, $3, 'stock.adjust', $4, now(), now() + interval '2 minutes')`, [a.orgId, wa.sessionId, wb.staffId, a.premisesId]);
  },
  async stock_settings_updated_by_fk(a, b) {
    const [, wb] = [await world(a), await world(b)];
    return inTenant(a, 'UPDATE stock_settings SET updated_by = $2 WHERE org_id = $1', [a.orgId, wb.staffId]);
  },
  async stock_settings_history_settings_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, `INSERT INTO stock_settings_history (org_id, settings_id, snapshot, version, valid_from) VALUES ($1, $2, '{}', 1, now())`, [a.orgId, wb.stockSettingsId]);
  },
  async stock_settings_history_changed_by_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO stock_settings_history (org_id, settings_id, snapshot, version, changed_by, valid_from) VALUES ($1, $2, '{}', 1, $3, now())`,
      [a.orgId, wa.stockSettingsId, wb.staffId]);
  },
  async premises_settings_premises_fk(a, b) {
    await world(a);
    return inTenant(a, `INSERT INTO premises_settings (org_id, premises_id, dispensing_mode) VALUES ($1, $2, 'RMP_OWN_PATIENTS')`, [a.orgId, b.premisesId]);
  },
  async premises_settings_updated_by_fk(a, b) {
    const [, wb] = [await world(a), await world(b)];
    return inTenant(a, 'UPDATE premises_settings SET updated_by = $2 WHERE org_id = $1', [a.orgId, wb.staffId]);
  },
  async premises_settings_history_settings_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, `INSERT INTO premises_settings_history (org_id, settings_id, premises_id, snapshot, version, valid_from) VALUES ($1, $2, $3, '{}', 1, now())`,
      [a.orgId, wb.premisesSettingsId, a.premisesId]);
  },
  async premises_settings_history_premises_fk(a, b) {
    const wa = await world(a);
    return inTenant(a, `INSERT INTO premises_settings_history (org_id, settings_id, premises_id, snapshot, version, valid_from) VALUES ($1, $2, $3, '{}', 1, now())`,
      [a.orgId, wa.premisesSettingsId, b.premisesId]);
  },
  async premises_settings_history_changed_by_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO premises_settings_history (org_id, settings_id, premises_id, snapshot, version, changed_by, valid_from) VALUES ($1, $2, $3, '{}', 1, $4, now())`,
      [a.orgId, wa.premisesSettingsId, a.premisesId, wb.staffId]);
  },
  async stock_locations_premises_fk(a, b) {
    return inTenant(a, `INSERT INTO stock_locations (org_id, premises_id, name, kind) VALUES ($1, $2, 'Cross', 'STORE')`, [a.orgId, b.premisesId]);
  },
  async item_units_item_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, `INSERT INTO item_units (org_id, item_id, name, base_units_per_unit) VALUES ($1, $2, 'box', 100)`, [a.orgId, wb.itemId]);
  },
  async items_container_unit_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, 'UPDATE items SET container_unit_id = $3, in_use_hours = 24 WHERE org_id = $1 AND id = $2', [a.orgId, wa.bareItemId, wb.unitId]);
  },
  async batches_premises_fk(a, b) {
    const wa = await world(a);
    return inTenant(a, `INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id) VALUES ($1, $2, $3, 'X1', '2099-01-31', 100, $4)`,
      [a.orgId, b.premisesId, wa.itemId, wa.unitId]);
  },
  async batches_item_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id) VALUES ($1, $2, $3, 'X2', '2099-01-31', 100, $4)`,
      [a.orgId, a.premisesId, wb.itemId, wa.unitId]);
  },
  async batches_mrp_unit_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id) VALUES ($1, $2, $3, 'X3', '2099-01-31', 100, $4)`,
      [a.orgId, a.premisesId, wa.itemId, wb.unitId]);
  },
  async stock_movements_item_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return movement(a, { itemId: wb.itemId, batchId: null, locationId: wa.locationId, actor: wa.staffId });
  },
  async stock_movements_batch_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return movement(a, { itemId: wa.itemId, batchId: wb.batchId, locationId: wa.locationId, actor: wa.staffId });
  },
  async stock_movements_location_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return movement(a, { itemId: wa.itemId, batchId: wa.batchId, locationId: wb.locationId, actor: wa.staffId });
  },
  async stock_movements_actor_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return movement(a, { itemId: wa.itemId, batchId: wa.batchId, locationId: wa.locationId, actor: wb.staffId });
  },
  async stock_movements_reverses_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return movement(a, { itemId: wa.itemId, batchId: wa.batchId, locationId: wa.locationId, actor: wa.staffId, type: 'REVERSAL', qty: -100, reverses: wb.movementId });
  },
  async stock_balances_item_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO stock_balances (org_id, premises_id, item_id, batch_id, location_id, on_hand, last_movement_seq) VALUES ($1, $2, $3, NULL, $4, 0, 0)`,
      [a.orgId, a.premisesId, wb.itemId, wa.locationId], 'migrator');
  },
  async stock_balances_batch_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO stock_balances (org_id, premises_id, item_id, batch_id, location_id, on_hand, last_movement_seq) VALUES ($1, $2, $3, $4, $5, 0, 0)`,
      [a.orgId, a.premisesId, wa.itemId, wb.batchId, wa.locationId], 'migrator');
  },
  async stock_balances_location_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, `INSERT INTO stock_balances (org_id, premises_id, item_id, batch_id, location_id, on_hand, last_movement_seq) VALUES ($1, $2, $3, NULL, $4, 0, 0)`,
      [a.orgId, a.premisesId, wa.itemId, wb.locationId], 'migrator');
  },
  async idempotency_keys_staff_fk(a, b) {
    const wb = await world(b);
    return inTenant(a, `INSERT INTO idempotency_keys (org_id, key, request_sha256, method, path, staff_user_id) VALUES ($1, 'fk-key-0001', repeat('a', 64), 'POST', '/api/x', $2)`,
      [a.orgId, wb.staffId]);
  },
  async device_state_session_fk(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return inTenant(a, 'INSERT INTO device_state (org_id, device_id, active_session_id) VALUES ($1, $2, $3)', [a.orgId, wa.deviceId, wb.sessionId]);
  },
};

/** Run the same insert in A, then B, then A again. */
async function twice(a: OrgFixture, b: OrgFixture, insert: (o: OrgFixture, variant: 'first' | 'other' | 'again') => Promise<string>) {
  const first = await insert(a, 'first');
  if (first !== 'ok') return { otherOrg: `setup failed: ${first}`, sameOrg: '' };
  return { otherOrg: await insert(b, 'other'), sameOrg: await insert(a, 'again') };
}

export const UNIQUE_BUILDERS: Record<string, UniqueBuilder> = {
  async batches_number_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o) => inTenant(o, `INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id) VALUES ($1, $2, $3, 'DUP 1', '2099-02-28', 100, $4)`,
      [o.orgId, o.premisesId, o === a ? wa.itemId : wb.itemId, o === a ? wa.unitId : wb.unitId]));
  },
  async batches_premises_item_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    const id = randomUUID();
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO batches (org_id, id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id) VALUES ($1, $2, $3, $4, $5, '2099-02-28', 100, $6)`,
      [o.orgId, id, o.premisesId, o === a ? wa.itemId : wb.itemId, v === 'again' ? 'ID 2' : 'ID 1', o === a ? wa.unitId : wb.unitId]));
  },
  async stock_movements_seq_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    const seq = 9_000_000_000 + Math.floor(Math.random() * 1_000_000);
    return twice(a, b, (o) => { const w = o === a ? wa : wb; return movement(o, { itemId: w.itemId, batchId: w.batchId, locationId: w.locationId, actor: w.staffId, seq }); });
  },
  async stock_movements_premises_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    const id = randomUUID();
    return twice(a, b, (o) => {
      const w = o === a ? wa : wb;
      return inTenant(o, `INSERT INTO stock_movements (org_id, id, premises_id, item_id, batch_id, location_id, movement_type, qty_delta, reference_type, reference_id,
                                                       actor_staff_id, actor_label, occurred_at, recorded_at)
                          VALUES ($1, $2, $3, $4, $5, $6, 'OPENING_BALANCE', 1, 'STOCK_ADJUSTMENT_LINE', gen_random_uuid(), $7, 'B', now(), now())`,
        [o.orgId, id, o.premisesId, w.itemId, w.batchId, w.locationId, w.staffId]);
    });
  },
  async stock_movements_reverses_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o) => {
      const w = o === a ? wa : wb;
      return inTenant(o, `INSERT INTO stock_movements (org_id, premises_id, item_id, batch_id, location_id, movement_type, qty_delta, reference_type, reference_id,
                                                       reason_code, actor_staff_id, actor_label, occurred_at, recorded_at, reverses_movement_id)
                          VALUES ($1, $2, $3, $4, $5, 'REVERSAL', -100, 'STOCK_REVERSAL', gen_random_uuid(), 'DATA_ENTRY_ERROR', $6, 'B', now(), now(), $7)`,
        [o.orgId, o.premisesId, w.itemId, w.batchId, w.locationId, w.staffId, w.movementId]);
    });
  },
  async stock_movements_natural_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    const refId = randomUUID();
    return twice(a, b, (o) => { const w = o === a ? wa : wb; return movement(o, { itemId: w.itemId, batchId: w.batchId, locationId: w.locationId, actor: w.staffId, refId }); });
  },
  async stock_balances_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o) => {
      const w = o === a ? wa : wb;
      return inTenant(o, `INSERT INTO stock_balances (org_id, premises_id, item_id, batch_id, location_id, on_hand, last_movement_seq) VALUES ($1, $2, $3, NULL, $4, 0, 0)`,
        [o.orgId, o.premisesId, w.itemId, w.locationId], 'migrator');
    });
  },
  async idempotency_keys_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o) => inTenant(o, `INSERT INTO idempotency_keys (org_id, key, request_sha256, method, path, staff_user_id) VALUES ($1, 'same-key-0001', repeat('b', 64), 'POST', '/api/x', $2)`,
      [o.orgId, (o === a ? wa : wb).staffId]));
  },
  async premises_name_key(a, b) {
    return twice(a, b, (o, v) => inTenant(o, 'INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, $2, $3, $4)',
      [o.orgId, v === 'again' ? 'counter two' : 'Counter Two', 'x', '24']));
  },
  async org_settings_org_key() {
    // Fresh organisations without settings, so each can take exactly one row.
    const [a, b] = [await createOrg('usa', { settings: false }), await createOrg('usb', { settings: false })];
    return twice(a, b, (o) => inTenant(o, 'INSERT INTO org_settings (org_id) VALUES ($1)', [o.orgId]));
  },
  async org_roles_key(a, b) {
    return twice(a, b, (o) => inTenant(o, "INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'clerk', 'Clerk')", [o.orgId]));
  },
  async role_grants_role_permission_key(a, b) {
    return twice(a, b, (o) => inTenant(o, "INSERT INTO role_grants (org_id, role_key, permission, allowed) VALUES ($1, 'reception', 'stock.items', true)", [o.orgId]));
  },
  async staff_users_name_key(a, b) {
    return twice(a, b, async (o, v) => (await insertStaff(o, { name: v === 'again' ? 'same person' : 'Same Person' })).code);
  },
  async staff_users_login_key(a, b) {
    return twice(a, b, async (o) => (await insertStaff(o, { login: 'samelogin' })).code);
  },
  async staff_users_phone_key(a, b) {
    return twice(a, b, async (o) => (await insertStaff(o, { phone: '+919800000099' })).code);
  },
  async staff_users_prescriber_key(a, b) {
    const pa = await createPrescriber(a);
    const pb = await createPrescriber(b);
    return twice(a, b, async (o) => (await insertStaff(o, { prescriberId: o === a ? pa : pb })).code);
  },
  async staff_premises_key(a, b) {
    const sa = (await insertStaff(a, {})).id;
    const sb = (await insertStaff(b, {})).id;
    return twice(a, b, (o) => inTenant(o, 'INSERT INTO staff_premises (org_id, staff_user_id, premises_id) VALUES ($1, $2, $3)',
      [o.orgId, o === a ? sa : sb, o.premisesId]));
  },
  async devices_name_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o, v) => inTenant(o, 'INSERT INTO devices (org_id, premises_id, name, registered_by) VALUES ($1, $2, $3, $4)',
      [o.orgId, o.premisesId, v === 'again' ? 'front desk' : 'Front Desk', o === a ? wa.staffId : wb.staffId]));
  },
  async sign_in_throttle_login_key(a, b) {
    const hmac = 'A'.repeat(43);
    return twice(a, b, (o) => inTenant(o, 'INSERT INTO sign_in_throttle (org_id, login_hmac) VALUES ($1, $2)', [o.orgId, hmac]));
  },
  async stock_settings_org_key() {
    const [a, b] = [await createOrg('ssa'), await createOrg('ssb')];
    return twice(a, b, (o) => inTenant(o, 'INSERT INTO stock_settings (org_id) VALUES ($1)', [o.orgId]));
  },
  async premises_settings_premises_key() {
    const [a, b] = [await createOrg('psa'), await createOrg('psb')];
    return twice(a, b, (o) => inTenant(o, `INSERT INTO premises_settings (org_id, premises_id, dispensing_mode) VALUES ($1, $2, 'RMP_OWN_PATIENTS')`, [o.orgId, o.premisesId]));
  },
  async stock_locations_premises_key(a, b) {
    const id = randomUUID();
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO stock_locations (org_id, id, premises_id, name, kind) VALUES ($1, $2, $3, $4, 'STORE')`,
      [o.orgId, id, o.premisesId, v === 'again' ? 'Second shelf' : 'First shelf']));
  },
  async stock_locations_name_key(a, b) {
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO stock_locations (org_id, premises_id, name, kind) VALUES ($1, $2, $3, 'STORE')`,
      [o.orgId, o.premisesId, v === 'again' ? 'back room' : 'Back Room']));
  },
  async stock_locations_default_key() {
    const [a, b] = [await createOrg('lda'), await createOrg('ldb')];
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO stock_locations (org_id, premises_id, name, kind, is_default) VALUES ($1, $2, $3, 'STORE', true)`,
      [o.orgId, o.premisesId, v === 'again' ? 'Store 2' : 'Store']));
  },
  async stock_locations_quarantine_key() {
    const [a, b] = [await createOrg('lqa'), await createOrg('lqb')];
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO stock_locations (org_id, premises_id, name, kind) VALUES ($1, $2, $3, 'QUARANTINE')`,
      [o.orgId, o.premisesId, v === 'again' ? 'Quarantine 2' : 'Quarantine']));
  },
  async items_display_name_key(a, b) {
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO items (org_id, category, display_name, base_unit, track_batches) VALUES ($1, 'MEDICINE', $2, 'TABLET', true)`,
      [o.orgId, v === 'again' ? 'same item' : 'Same Item']));
  },
  async items_master_key(a, b) {
    const master = await inOrg(a.orgId, async (c) => (await c.query('SELECT id FROM medicine_master WHERE NOT requires_prescription ORDER BY id LIMIT 1')).rows[0].id as string);
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO items (org_id, master_id, category, display_name, base_unit, track_batches) VALUES ($1, $2, 'MEDICINE', $3, 'TABLET', true)`,
      [o.orgId, master, v === 'again' ? 'Linked again' : 'Linked']));
  },
  async item_units_item_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    const id = randomUUID();
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO item_units (org_id, id, item_id, name, base_units_per_unit) VALUES ($1, $2, $3, $4, 5)`,
      [o.orgId, id, o === a ? wa.itemId : wb.itemId, v === 'again' ? 'pack b' : 'pack a']));
  },
  async item_units_name_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO item_units (org_id, item_id, name, base_units_per_unit) VALUES ($1, $2, $3, 30)`,
      [o.orgId, o === a ? wa.itemId : wb.itemId, v === 'again' ? 'JAR' : 'jar']));
  },
  async item_units_base_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o, v) => inTenant(o, `INSERT INTO item_units (org_id, item_id, name, base_units_per_unit, is_base) VALUES ($1, $2, $3, 1, true)`,
      [o.orgId, o === a ? wa.itemId : wb.itemId, v === 'again' ? 'tab' : 'tablet']));
  },
  async suppliers_name_key(a, b) {
    return twice(a, b, (o, v) => inTenant(o, 'INSERT INTO suppliers (org_id, name) VALUES ($1, $2)', [o.orgId, v === 'again' ? 'same supplier' : 'Same Supplier']));
  },
  async suppliers_gstin_key(a, b) {
    return twice(a, b, (o, v) => inTenant(o, 'INSERT INTO suppliers (org_id, name, gstin) VALUES ($1, $2, $3)',
      [o.orgId, v === 'again' ? 'Gstin Two' : 'Gstin One', '24AAAAA0000A1Z5']));
  },
  async device_state_device_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o) => inTenant(o, 'INSERT INTO device_state (org_id, device_id) VALUES ($1, $2)', [o.orgId, o === a ? wa.deviceId : wb.deviceId]));
  },
};
