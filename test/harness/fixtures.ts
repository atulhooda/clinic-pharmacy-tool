// Synthetic organisations, staff and identity rows. Organisations are created the way
// production creates them: by pharmacy_ops, inside a transaction that sets app.org_id.
import { randomUUID } from 'crypto';
import pg from 'pg';
import { as, type Urls, urls as mainUrls } from './env';
import { hashPassword } from '../../lib/auth/password';
import { BUILTIN_ROLE_ROWS } from '../../lib/db/create-org';

export interface OrgFixture {
  orgId: string;
  slug: string;
  premisesId: string;
}

/**
 * An organisation with one premises. By default it also gets the built-in roles and a
 * settings row (as the founder CLI makes). `minimal` stops after the premises, for databases
 * migrated only to 001 (06b DMG-03).
 */
export async function createOrg(
  label: string,
  opts: { status?: 'ACTIVE' | 'SUSPENDED'; premisesName?: string; from?: Urls; minimal?: boolean; settings?: boolean } = {},
): Promise<OrgFixture> {
  const orgId = randomUUID();
  const premisesId = randomUUID();
  const slug = `${label}-${orgId.slice(0, 8)}`.toLowerCase();
  await as('ops', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await c.query('INSERT INTO organisations (id, slug, display_name, status) VALUES ($1, $2, $3, $4)',
      [orgId, slug, `Synthetic ${label}`, opts.status ?? 'ACTIVE']);
    await c.query('INSERT INTO premises (org_id, id, name, address, state_code) VALUES ($1, $2, $3, $4, $5)',
      [orgId, premisesId, opts.premisesName ?? 'Main', '1 Test Road, Gujarat', '24']);
    if (!opts.minimal) {
      for (const r of BUILTIN_ROLE_ROWS) {
        await c.query('INSERT INTO org_roles (org_id, key, name, builtin) VALUES ($1, $2, $3, true)', [orgId, r.key, r.name]);
      }
      if (opts.settings !== false) await c.query('INSERT INTO org_settings (org_id) VALUES ($1)', [orgId]);
    }
    await c.query('COMMIT');
  }, opts.from ?? mainUrls);
  return { orgId, slug, premisesId };
}

/** Run SQL as the app role inside the organisation's tenant transaction. */
export async function inOrg<T>(orgId: string, fn: (c: pg.Client) => Promise<T>, from: Urls = mainUrls): Promise<T> {
  return as('app', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    try {
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  }, from);
}

export interface StaffFixture {
  id: string;
  login: string;
  password: string;
  name: string;
}

let staffN = 0;
export async function createStaff(
  org: OrgFixture,
  opts: { role?: string; password?: string; login?: string; name?: string; premises?: string[]; mustChange?: boolean;
          active?: boolean; phone?: string; prescriberId?: string } = {},
): Promise<StaffFixture> {
  staffN++;
  const id = randomUUID();
  const login = opts.login ?? `user${staffN}-${id.slice(0, 4)}`;
  const name = opts.name ?? `Staff ${staffN} ${id.slice(0, 4)}`;
  const password = opts.password ?? `correct-horse-${id.slice(0, 8)}`;
  const hash = await hashPassword(password);
  await inOrg(org.orgId, async (c) => {
    await c.query(`INSERT INTO staff_users (org_id, id, name, login, role_key, password_hash, must_change_password, active, phone_e164, prescriber_id)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [org.orgId, id, name, login, opts.role ?? 'reception', hash, opts.mustChange ?? false, opts.active ?? true, opts.phone ?? null, opts.prescriberId ?? null]);
    for (const p of opts.premises ?? [org.premisesId]) {
      await c.query('INSERT INTO staff_premises (org_id, staff_user_id, premises_id) VALUES ($1, $2, $3)', [org.orgId, id, p]);
    }
  });
  return { id, login, password, name };
}

export async function createPrescriber(org: OrgFixture, opts: { kind?: 'INTERNAL' | 'EXTERNAL'; name?: string } = {}): Promise<string> {
  const id = randomUUID();
  await inOrg(org.orgId, (c) => c.query(
    'INSERT INTO prescribers (org_id, id, kind, name, address) VALUES ($1, $2, $3, $4, $5)',
    [org.orgId, id, opts.kind ?? 'INTERNAL', opts.name ?? 'Dr. Synthetic', opts.kind === 'EXTERNAL' ? '1 Clinic Road' : null]));
  return id;
}

/** A device and an open session for a staff member (trusted-device flows come in PR 3). */
export async function createDeviceAndSession(org: OrgFixture, staffId: string): Promise<{ deviceId: string; sessionId: string }> {
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  await inOrg(org.orgId, async (c) => {
    await c.query('INSERT INTO devices (org_id, id, premises_id, name, registered_by) VALUES ($1, $2, $3, $4, $5)',
      [org.orgId, deviceId, org.premisesId, `PC ${deviceId.slice(0, 6)}`, staffId]);
    await c.query(`INSERT INTO sessions (org_id, id, staff_user_id, device_id, method, created_at, expires_at, last_input_at)
                   VALUES ($1, $2, $3, $4, 'PASSWORD', now(), now() + interval '1 hour', now())`, [org.orgId, sessionId, staffId, deviceId]);
  });
  return { deviceId, sessionId };
}
