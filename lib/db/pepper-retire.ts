import type { Pool } from 'pg';

/**
 * The pepper rotation's step 4 (06a §3.12): clear every PIN hash made with `version`, in every
 * organisation, and write one `auth.pin_pepper_retired` audit row per organisation affected.
 * Runs as the MIGRATOR (scripts/retire-pepper.ts), in one transaction.
 *
 * RLS is forced even for the table owner, and no role may list organisations' staff, so the
 * transaction lifts FORCE on staff_users, does the update, and restores FORCE before it
 * commits. Other transactions never see the change (DDL is transactional and takes an
 * exclusive lock for its duration). The census trigger keeps the per-version counts in step.
 */
export async function retirePepperVersion(migratorPool: Pool, version: number): Promise<{ orgs: number; cleared: number }> {
  if (!Number.isInteger(version) || version < 1 || version > 999) throw new Error('version must be an integer 1–999');
  const c = await migratorPool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE staff_users NO FORCE ROW LEVEL SECURITY');
    const perOrg = (await c.query<{ orgId: string; n: number }>(
      `SELECT org_id AS "orgId",
              (count(*) FILTER (WHERE pin_hash_version(switch_pin_hash) = $1)
               + count(*) FILTER (WHERE pin_hash_version(signing_pin_hash) = $1))::int AS n
         FROM staff_users
        WHERE pin_hash_version(switch_pin_hash) = $1 OR pin_hash_version(signing_pin_hash) = $1
        GROUP BY org_id`, [version])).rows;
    await c.query(
      `UPDATE staff_users
          SET switch_pin_hash  = CASE WHEN pin_hash_version(switch_pin_hash)  = $1 THEN NULL ELSE switch_pin_hash END,
              signing_pin_hash = CASE WHEN pin_hash_version(signing_pin_hash) = $1 THEN NULL ELSE signing_pin_hash END
        WHERE pin_hash_version(switch_pin_hash) = $1 OR pin_hash_version(signing_pin_hash) = $1`, [version]);
    await c.query('ALTER TABLE staff_users FORCE ROW LEVEL SECURITY');
    for (const o of perOrg) {
      await c.query("SELECT set_config('app.org_id', $1, true)", [o.orgId]);
      await c.query(
        `INSERT INTO audit_log (org_id, actor_label, actor_role, action, detail)
         VALUES ($1, 'pepper-retire', 'system', 'auth.pin_pepper_retired', jsonb_build_object('version', $2::int, 'count', $3::int))`,
        [o.orgId, version, o.n]);
    }
    await c.query('COMMIT');
    return { orgs: perOrg.length, cleared: perOrg.reduce((a, o) => a + o.n, 0) };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
