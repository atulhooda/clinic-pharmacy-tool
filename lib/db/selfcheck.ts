import path from 'path';
import type { Pool } from 'pg';
import { getPool } from './pool';
import { wrap, type Db } from './db';
import { checkRls } from './catalog';
import { EXPECTED_OBJECTS } from './expected-objects';
import { listMigrations } from './migration-files.cjs';
import { log } from '../log';

/**
 * 06a §2.5: the startup and readiness self-check (06b DS-09, DS-10, DL-18, DMG-13).
 * If any check fails, every /api route except /api/health answers 503 SCHEMA_UNVERIFIED.
 */
export interface SchemaStatus {
  ok: boolean;
  failures: string[];
}

export async function verifySchema(db: Db, migrationsDir = defaultDir()): Promise<SchemaStatus> {
  const failures: string[] = [];
  try {
    // 1. Role: not a superuser, no BYPASSRLS.
    const role = (await db.rows<{ name: string; super: boolean; bypass: boolean }>(
      'SELECT current_user AS name, rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user'))[0];
    if (!role || role.super) failures.push(`role: ${role?.name ?? '?'} is a superuser`);
    if (role?.bypass) failures.push(`role: ${role.name} has BYPASSRLS`);

    // 2. Ownership: the app role owns nothing.
    const owned = await db.rows<{ name: string }>(`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      UNION ALL
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`);
    for (const o of owned) failures.push(`ownership: ${o.name} is owned by the app role`);

    // 3. RLS forced everywhere, with the tenant policy and no unreviewed policy.
    for (const p of await checkRls(db)) failures.push(`rls: ${p}`);

    // 4. The enforcement objects.
    for (const f of await checkObjects(db)) failures.push(`objects: ${f}`);

    // 5. The applied migrations equal the files shipped in this build.
    for (const f of await checkMigrations(db, migrationsDir)) failures.push(`migrations: ${f}`);
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown';
    failures.push(`check: could not run (${code})`);
  }
  return { ok: failures.length === 0, failures };
}

async function checkObjects(db: Db): Promise<string[]> {
  const missing: string[] = [];
  for (const o of EXPECTED_OBJECTS) {
    if (o.kind === 'function' || o.kind === 'security_definer') {
      const rows = await db.rows<{ secdef: boolean; owner: string }>(`
        SELECT p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = $1`, [o.name]);
      if (rows.length === 0) missing.push(`function ${o.name} is missing`);
      else if (o.kind === 'security_definer' && (!rows[0].secdef || rows[0].owner !== o.owner)) {
        missing.push(`function ${o.name} must be SECURITY DEFINER owned by ${o.owner}`);
      }
    } else if (o.kind === 'constraint') {
      const rows = await db.rows(`
        SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1 AND con.conname = $2`, [o.table, o.name]);
      if (rows.length === 0) missing.push(`constraint ${o.name} on ${o.table} is missing`);
    } else {
      const rows = await db.rows(`
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1 AND t.tgname = $2 AND t.tgenabled <> 'D'`, [o.table, o.name]);
      if (rows.length === 0) missing.push(`trigger ${o.name} on ${o.table} is missing or disabled`);
    }
  }
  return missing;
}

async function checkMigrations(db: Db, dir: string): Promise<string[]> {
  const files = listMigrations(dir);
  const applied = await db.rows<{ version: number; name: string; sha256: string }>(
    'SELECT version, name, sha256 FROM schema_migrations ORDER BY version');
  const problems: string[] = [];
  for (const f of files) {
    const a = applied.find((x) => x.version === f.version);
    if (!a) problems.push(`${f.file} is not applied`);
    else if (a.name !== f.name || a.sha256 !== f.sha256) problems.push(`${f.file} differs from the applied version`);
  }
  for (const a of applied) {
    if (!files.some((f) => f.version === a.version)) problems.push(`applied migration ${a.version} is not in this build`);
  }
  return problems;
}

function defaultDir(): string {
  // process.cwd(), not __dirname: in a Next build this module is bundled under .next/.
  return process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), 'migrations');
}

// ---------------------------------------------------------------- cached status for routes
const TTL_MS = Number(process.env.SELF_CHECK_TTL_MS ?? 30_000);
let cached: { status: SchemaStatus; at: number } | undefined;

/** A passed check is trusted for SELF_CHECK_TTL_MS; a failed one is re-run on every call. */
export async function getSchemaStatus(pool: Pool = getPool()): Promise<SchemaStatus> {
  if (cached && cached.status.ok && Date.now() - cached.at < TTL_MS) return cached.status;
  let status: SchemaStatus;
  try {
    status = await verifySchema(wrap(pool));
  } catch (err) {
    status = { ok: false, failures: [`check: could not run (${(err as { code?: string }).code ?? 'unknown'})`] };
  }
  if (!status.ok) log('schema_unverified', { failures: status.failures });
  cached = { status, at: Date.now() };
  return status;
}

export function resetSchemaStatusCache(): void {
  cached = undefined;
}
