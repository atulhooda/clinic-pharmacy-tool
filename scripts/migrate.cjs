#!/usr/bin/env node
// Migration runner: Spec 06a §18, 06b DMG-01 … 04, DMG-12, DMG-13.
//
// Applies migrations/NNN_name.sql in order, as pharmacy_migrator, through
// MIGRATION_DATABASE_URL. Each file runs in its own transaction and is recorded
// in schema_migrations with its SHA-256.
//
// It FAILS (exit 1) on ANY problem, so `prestart` fails and the deploy fails:
//   - MIGRATION_DATABASE_URL unset;
//   - connected as a superuser or a BYPASSRLS role;
//   - Postgres older than 15;
//   - a badly named or non-contiguous migration file;
//   - an applied file whose checksum changed, or an applied version this build lacks;
//   - any SQL error (the failing file is rolled back; later files are not attempted).
'use strict';
const { Client } = require('pg');
const { listMigrations, defaultMigrationsDir } = require('../lib/db/migration-files.cjs');

const LOCK_KEY = 4206101; // advisory lock: one runner at a time per database

class MigrateError extends Error {}

async function main({
  url = process.env.MIGRATION_DATABASE_URL,
  dir = defaultMigrationsDir(),
  log = (msg) => console.log(`[migrate] ${msg}`),
} = {}) {
  if (!url) throw new MigrateError('MIGRATION_DATABASE_URL is not set');
  const files = listMigrations(dir);

  const c = new Client({ connectionString: url, application_name: 'pharmacy-migrate' });
  await c.connect();
  try {
    const who = (await c.query(
      'SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (who.rolsuper || who.rolbypassrls) {
      throw new MigrateError(`refusing to run as "${who.name}": it is a superuser or has BYPASSRLS. Use the pharmacy_migrator role.`);
    }
    const version = Number((await c.query("SELECT current_setting('server_version_num') AS v")).rows[0].v);
    if (version < 150000) throw new MigrateError(`Postgres 15 or newer is required (server_version_num ${version})`);

    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer     PRIMARY KEY,
      name       text        NOT NULL,
      sha256     text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const applied = (await c.query('SELECT version, name, sha256 FROM schema_migrations ORDER BY version')).rows;
    for (const a of applied) {
      const f = files.find((x) => x.version === a.version);
      if (!f) throw new MigrateError(`the database has migration ${a.version} (${a.name}), which this build does not ship`);
      if (f.name !== a.name || f.sha256 !== a.sha256) {
        throw new MigrateError(`${f.file} was changed after it was applied (checksum mismatch). Never edit an applied migration; add a new one.`);
      }
    }

    const pending = files.filter((f) => !applied.some((a) => a.version === f.version));
    if (pending.length === 0) log(`up to date at ${String(files.length).padStart(3, '0')}`);
    for (const f of pending) {
      await c.query('BEGIN');
      try {
        await c.query(f.sql);
        await c.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [f.version, f.name, f.sha256]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw new MigrateError(`${f.file} failed and was rolled back: ${err.message}`);
      }
      log(`applied ${f.file}`);
    }
  } finally {
    await c.end().catch(() => {});
  }
}

module.exports = { main, MigrateError };

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`[migrate] FAILED: ${err.message}`);
      process.exit(1);
    },
  );
}
