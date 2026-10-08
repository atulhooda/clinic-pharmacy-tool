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

async function inTenant(org: OrgFixture, sql: string, params: unknown[]): Promise<string> {
  const pool = new pg.Pool({ connectionString: urls.app, max: 1 });
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
  const w = { staffId: staff.id, prescriberId, deviceId, sessionId, settingsId };
  worlds.set(org.orgId, w);
  return w;
}
const onlyKey = (org: OrgFixture) => `only_${org.orgId.slice(0, 6)}`;

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
  async device_state_device_key(a, b) {
    const [wa, wb] = [await world(a), await world(b)];
    return twice(a, b, (o) => inTenant(o, 'INSERT INTO device_state (org_id, device_id) VALUES ($1, $2)', [o.orgId, o === a ? wa.deviceId : wb.deviceId]));
  },
};
