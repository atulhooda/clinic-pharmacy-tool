// Real-Postgres test harness (06b §1, 06a §1.2, R6-6).
//
// startServer(): a throwaway cluster from the local Postgres binaries (initdb + pg_ctl,
// TCP on 127.0.0.1, no Unix socket), or TEST_PG_SUPERUSER_URL when given (e.g. CI with a
// Docker service). prepareDatabase(): a fresh database set up exactly as production is:
// ops/bootstrap-roles.sql as the superuser, then the real runner as pharmacy_migrator.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ROLES = {
  migrator: 'pharmacy_migrator',
  app: 'pharmacy_app',
  jobs: 'pharmacy_jobs',
  ops: 'pharmacy_ops',
  curator: 'pharmacy_curator',
};

function majorVersion(binDir) {
  try {
    const out = execFileSync(path.join(binDir, 'postgres'), ['--version'], { encoding: 'utf8' });
    return Number(/(\d+)(\.\d+)?/.exec(out)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

export function findPgBin() {
  const candidates = [];
  if (process.env.PG_BIN) candidates.push(process.env.PG_BIN);
  try {
    candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim());
  } catch { /* not on PATH */ }
  for (const v of [17, 16, 15]) {
    candidates.push(`/opt/homebrew/opt/postgresql@${v}/bin`, `/usr/local/opt/postgresql@${v}/bin`, `/usr/lib/postgresql/${v}/bin`);
  }
  const found = candidates.find((d) => d && majorVersion(d) >= 15);
  if (!found) {
    throw new Error('No Postgres 15+ binaries found. Install postgresql@16, set PG_BIN, or set TEST_PG_SUPERUSER_URL.');
  }
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** @returns {Promise<{url: string, stop: () => Promise<void>}>} url = superuser URL to the "postgres" database */
export async function startServer() {
  if (process.env.TEST_PG_SUPERUSER_URL) {
    const u = new URL(process.env.TEST_PG_SUPERUSER_URL);
    u.pathname = '/postgres';
    return { url: u.toString(), stop: async () => {} };
  }
  const bin = findPgBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-pg-'));
  const data = path.join(dir, 'data');
  const port = await freePort();
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-instructions'], { stdio: 'ignore' });
  const opts = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off`;
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(dir, 'postgres.log'), '-w', '-o', opts, 'start'], { stdio: 'ignore' });
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      spawnSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withDb(url, db, role, password) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (role) {
    u.username = role;
    u.password = password ?? '';
  }
  return u.toString();
}

/**
 * Creates (or re-creates) database `db` on the server, bootstraps it as production is
 * bootstrapped, and optionally migrates it with the real runner.
 * @param {string} serverUrl superuser URL (any database on the server)
 * @param {string} db
 * @param {{ password: string, migrate?: boolean, migrationsDir?: string }} opts
 * @returns {Promise<{db: string, urls: Record<'super'|'migrator'|'app'|'jobs'|'ops'|'curator', string>}>}
 */
export async function prepareDatabase(serverUrl, db, { password, migrate = true, migrationsDir } = {}) {
  if (!/^[a-z0-9_]+$/.test(db)) throw new Error(`bad test database name ${db}`);
  if (!/^[0-9a-f]{16,64}$/.test(password ?? '')) throw new Error('a hex test password is required');
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
  } finally {
    await admin.end();
  }
  const superUrl = withDb(serverUrl, db);
  const c = new pg.Client({ connectionString: superUrl });
  await c.connect();
  try {
    await c.query(fs.readFileSync(path.join(ROOT, 'ops', 'bootstrap-roles.sql'), 'utf8'));
    // Test-only passwords (roles are cluster-wide; one password per test run).
    for (const role of Object.values(ROLES)) await c.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
  } finally {
    await c.end();
  }
  const urls = { super: superUrl };
  for (const [key, role] of Object.entries(ROLES)) urls[key] = withDb(serverUrl, db, role, password);
  if (migrate) {
    const { main } = require('../migrate.cjs');
    await main({ url: urls.migrator, dir: migrationsDir ?? path.join(ROOT, 'migrations'), log: () => {} });
  }
  return { db, urls };
}

export async function dropDatabases(serverUrl, prefix) {
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${prefix}%`]);
    for (const r of rows) await admin.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
