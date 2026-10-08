// Test-side view of the harness started by scripts/test.mjs.
import { randomUUID } from 'crypto';
import pg from 'pg';
import { prepareDatabase } from '../../scripts/lib/pg-harness.mjs';

export type Role = 'super' | 'migrator' | 'app' | 'jobs' | 'ops' | 'curator';
export type Urls = Record<Role, string>;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run the tests with \`npm test\``);
  return v;
}

/** The main test database, migrated to head. */
export const urls: Urls = JSON.parse(required('TEST_DB_URLS'));

export async function connect(role: Role, from: Urls = urls): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: from[role] });
  await c.connect();
  return c;
}

/** Run fn with a connected client and always close it. */
export async function as<T>(role: Role, fn: (c: pg.Client) => Promise<T>, from: Urls = urls): Promise<T> {
  const c = await connect(role, from);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let n = 0;
/** A brand-new database, bootstrapped as production is; migrated unless migrate is false. */
export async function freshDatabase(opts: { migrate?: boolean; migrationsDir?: string } = {}): Promise<Urls> {
  const name = `${required('TEST_DB_PREFIX')}f${n++}_${randomUUID().slice(0, 8)}`;
  const { urls: u } = await prepareDatabase(required('TEST_PG_SERVER_URL'), name, {
    password: required('TEST_ROLE_PASSWORD'),
    migrate: opts.migrate ?? true,
    migrationsDir: opts.migrationsDir,
  });
  return u as Urls;
}

/** Postgres error code of a rejected promise (e.g. 42501, 23503, 23505). */
export async function pgCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code';
  }
  return 'no-error';
}
