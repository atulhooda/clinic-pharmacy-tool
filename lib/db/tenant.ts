import type { Pool } from 'pg';
import { getPool } from './pool';
import { wrap, type Db } from './db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 06a §2.3: the one way in. Opens a transaction on the shared pool and sets
 * app.org_id with set_config(…, true): transaction-local, so it is cleared at
 * COMMIT or ROLLBACK and can never leak to the next request on a pooled
 * connection. Outside withTenant the setting is unset and every policy matches
 * zero rows (fail-closed).
 *
 * orgId must come from a verified session or device cookie, never a request field.
 */
export async function withTenant<T>(orgId: string, fn: (db: Db) => Promise<T>, pool: Pool = getPool()): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new TypeError('withTenant: orgId must be a UUID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
