import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { wrap } from './db';
import { writeAudit } from '../audit';
import { hashPassword, oneTimePassword } from '../auth/password';

/**
 * 06a §3.10: the founder CLI's work (scripts/create-org.ts), run as pharmacy_ops. Creates an
 * organisation, its first premises, its built-in roles, its settings and its first owner,
 * with a one-time password that is returned once and never stored in clear or logged.
 */
export interface CreateOrgInput {
  slug: string;
  displayName: string;
  premises: { name: string; address: string; stateCode: string; gstin?: string };
  owner: { name: string; login: string; phoneE164?: string };
}

export interface CreatedOrg {
  orgId: string;
  premisesId: string;
  ownerId: string;
  oneTimePassword: string;
}

export const BUILTIN_ROLE_ROWS = [
  { key: 'owner', name: 'Owner' },
  { key: 'doctor', name: 'Doctor' },
  { key: 'reception', name: 'Reception' },
] as const;

export async function createOrganisation(pool: Pool, input: CreateOrgInput): Promise<CreatedOrg> {
  const orgId = randomUUID();
  const premisesId = randomUUID();
  const ownerId = randomUUID();
  const password = oneTimePassword();
  const hash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const db = wrap(client);
    await db.rows('INSERT INTO organisations (id, slug, display_name) VALUES ($1, $2, $3)',
      [orgId, input.slug.trim().toLowerCase(), input.displayName.trim()]);
    await db.rows('INSERT INTO premises (org_id, id, name, address, state_code, gstin) VALUES ($1, $2, $3, $4, $5, $6)',
      [orgId, premisesId, input.premises.name, input.premises.address, input.premises.stateCode, input.premises.gstin ?? null]);
    for (const r of BUILTIN_ROLE_ROWS) {
      await db.rows('INSERT INTO org_roles (org_id, key, name, builtin) VALUES ($1, $2, $3, true)', [orgId, r.key, r.name]);
    }
    await db.rows('INSERT INTO org_settings (org_id) VALUES ($1)', [orgId]);
    await db.rows(`INSERT INTO staff_users (org_id, id, name, login, phone_e164, role_key, password_hash, must_change_password)
                   VALUES ($1, $2, $3, $4, $5, 'owner', $6, true)`,
      [orgId, ownerId, input.owner.name, input.owner.login.trim().toLowerCase(), input.owner.phoneE164 ?? null, hash]);
    await writeAudit(db, { orgId, action: 'org.created', actorLabel: 'founder-cli', actorRole: 'founder_cli', entityId: orgId });
    await writeAudit(db, { orgId, action: 'staff.owner_bootstrapped', actorLabel: 'founder-cli', actorRole: 'founder_cli',
      entityId: ownerId, detail: { role: 'owner' } });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { orgId, premisesId, ownerId, oneTimePassword: password };
}
