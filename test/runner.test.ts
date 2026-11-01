// 06b DMG-01 … DMG-04, DMG-13 and the runner's refusals (06a §18): it fails the deploy on any error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { as, freshDatabase, type Urls } from './harness/env';
import { createOrg, inOrg } from './harness/fixtures';

const ROOT = process.cwd();
const REPO_MIGRATIONS = path.join(ROOT, 'migrations');

function runRunner(env: Record<string, string | undefined>): { code: number; out: string } {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) merged[k] = v;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.cjs')], { cwd: ROOT, env: merged as NodeJS.ProcessEnv, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

/** A temp migrations dir holding the first `k` repo files plus any extra files. */
function migrationsDir(k: number, extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-mig-'));
  fs.readdirSync(REPO_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().slice(0, k)
    .forEach((f) => fs.copyFileSync(path.join(REPO_MIGRATIONS, f), path.join(dir, f)));
  for (const [name, sql] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

const repoCount = fs.readdirSync(REPO_MIGRATIONS).filter((f) => f.endsWith('.sql')).length;

async function applied(u: Urls): Promise<{ version: number; name: string; applied_at: Date }[]> {
  return as('migrator', async (c) => (await c.query('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')).rows, u);
}

test('DMG-01 / DMG-02: an empty database reaches head, and a second run is a no-op', async () => {
  const u = await freshDatabase({ migrate: false });
  const first = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: REPO_MIGRATIONS });
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /applied 001_tenancy_foundation\.sql/);
  const before = await applied(u);
  assert.equal(before.length, repoCount);

  const second = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: REPO_MIGRATIONS });
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /up to date/);
  assert.deepEqual(await applied(u), before);
});

test('DMG-03: each migration applies on top of the previous one, with its data intact', async () => {
  const u = await freshDatabase({ migrate: false });
  const orgs: string[] = [];
  for (let k = 1; k <= repoCount; k++) {
    const r = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: migrationsDir(k) });
    assert.equal(r.code, 0, r.out);
    orgs.push((await createOrg(`m${k}`, { from: u, minimal: true })).orgId);
    const seen = await as('jobs', async (c) => (await c.query('SELECT id::text AS id FROM organisations')).rows.map((x) => x.id), u);
    for (const id of orgs) assert.ok(seen.includes(id), `organisation created after step ${orgs.indexOf(id) + 1} is gone`);
  }
});

test('DMG-04: a broken migration exits non-zero, rolls back, and stops the run', async () => {
  const u = await freshDatabase({ migrate: false });
  const n = String(repoCount + 1).padStart(3, '0');
  const dir = migrationsDir(repoCount, {
    [`${n}_broken.sql`]: 'CREATE TABLE should_not_exist (id int);\nSELECT 1 / 0;\n',
  });
  const r = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: dir });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`FAILED: ${n}_broken\\.sql failed and was rolled back`));
  assert.equal((await applied(u)).length, repoCount);
  const exists = await as('super', async (c) => (await c.query("SELECT to_regclass('public.should_not_exist') AS t")).rows[0].t, u);
  assert.equal(exists, null);
});

test('the runner refuses: no URL, a superuser, a numbering gap, a statement that cannot run in a transaction', async () => {
  const u = await freshDatabase({ migrate: false });
  const noUrl = runRunner({ MIGRATION_DATABASE_URL: undefined, MIGRATIONS_DIR: REPO_MIGRATIONS });
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.out, /MIGRATION_DATABASE_URL is not set/);

  const superuser = runRunner({ MIGRATION_DATABASE_URL: u.super, MIGRATIONS_DIR: REPO_MIGRATIONS });
  assert.equal(superuser.code, 1);
  assert.match(superuser.out, /refusing to run as "[^"]+": it is a superuser/);

  const gap = runRunner({
    MIGRATION_DATABASE_URL: u.migrator,
    MIGRATIONS_DIR: migrationsDir(1, { [`${String(repoCount + 2).padStart(3, '0')}_gap.sql`]: 'SELECT 1;' }),
  });
  assert.equal(gap.code, 1);
  assert.match(gap.out, /no gaps or duplicates/);

  const concurrently = runRunner({
    MIGRATION_DATABASE_URL: u.migrator,
    MIGRATIONS_DIR: migrationsDir(repoCount, {
      [`${String(repoCount + 1).padStart(3, '0')}_concurrently.sql`]: 'CREATE INDEX CONCURRENTLY premises_extra ON premises (address);',
    }),
  });
  assert.equal(concurrently.code, 1, concurrently.out);
  assert.equal((await applied(u)).length, repoCount, 'the files before the bad one are applied; the bad one is not');
});

test('DMG-13: an edited applied file, or an applied version the build lacks, fails the run', async () => {
  const u = await freshDatabase();
  const edited = migrationsDir(repoCount);
  fs.appendFileSync(path.join(edited, fs.readdirSync(edited).sort()[0]), '\n-- edited after it was applied\n');
  const r1 = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: edited });
  assert.equal(r1.code, 1);
  assert.match(r1.out, /changed after it was applied \(checksum mismatch\)/);

  await as('migrator', (c) => c.query("INSERT INTO schema_migrations (version, name, sha256) VALUES (999, 'from_the_future', repeat('0', 64))"), u);
  const r2 = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: REPO_MIGRATIONS });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /has migration 999 \(from_the_future\), which this build does not ship/);
});

test('030 (D-66): a desk sale line stored before it has no rx_flags (NULL: never recorded); a line stored after defaults to none', async () => {
  const u = await freshDatabase({ migrate: false });
  const at029 = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: migrationsDir(29) });
  assert.equal(at029.code, 0, at029.out);
  const org = await createOrg('m030', { from: u });
  const line = (key: string) => inOrg(org.orgId, (c) => c.query(`INSERT INTO desk_sale_lines (org_id, premises_id, bill_id, line_key, bill_serial, issued_at,
      requested_item_id, qty_base, status, allocated_base, short_base, reason, received_at)
      VALUES ($1, $2, gen_random_uuid(), $3, 'OLD-1', now(), gen_random_uuid(), 1, 'REJECTED', 0, 0, 'unknown_item', now())`, [org.orgId, org.premisesId, key]), u);
  await line('before');
  const head = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: REPO_MIGRATIONS });
  assert.equal(head.code, 0, head.out);
  await line('after');
  const flags = await inOrg(org.orgId, async (c) => (await c.query('SELECT line_key, rx_flags FROM desk_sale_lines ORDER BY line_key')).rows, u);
  assert.deepEqual(flags, [{ line_key: 'after', rx_flags: [] }, { line_key: 'before', rx_flags: null }]);
});

test('031 (D-67): a credit note stored before it keeps no number (NULL); a bill stored before it can gain its patient and doctor once, never twice', async () => {
  const u = await freshDatabase({ migrate: false });
  const at030 = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: migrationsDir(30) });
  assert.equal(at030.code, 0, at030.out);
  const org = await createOrg('m031', { from: u });
  const billId = (await inOrg(org.orgId, async (c) => {
    const line = (await c.query(`INSERT INTO desk_sale_lines (org_id, premises_id, bill_id, line_key, bill_serial, issued_at,
        requested_item_id, qty_base, status, allocated_base, short_base, reason, received_at)
        VALUES ($1, $2, gen_random_uuid(), 'L1', 'OLD-1', now(), gen_random_uuid(), 1, 'REJECTED', 0, 0, 'unknown_item', now()) RETURNING id, bill_id`, [org.orgId, org.premisesId])).rows[0];
    await c.query(`INSERT INTO desk_return_lines (org_id, premises_id, credit_note_id, bill_id, line_key, sale_line_id, qty_base, returned_base, status, reason, received_at)
        VALUES ($1, $2, gen_random_uuid(), $3, 'L1', $4, 1, 0, 'NOTHING_TO_RETURN', 'not_posted', now())`, [org.orgId, org.premisesId, line.bill_id, line.id]);
    return line.bill_id as string;
  }, u));
  const head = runRunner({ MIGRATION_DATABASE_URL: u.migrator, MIGRATIONS_DIR: REPO_MIGRATIONS });
  assert.equal(head.code, 0, head.out);
  const serials = await inOrg(org.orgId, async (c) => (await c.query('SELECT credit_note_serial FROM desk_return_lines')).rows, u);
  assert.deepEqual(serials, [{ credit_note_serial: null }]);
  const add = (name: string) => inOrg(org.orgId, (c) => c.query(`INSERT INTO desk_sale_bills (org_id, premises_id, bill_id, patient_name, received_at)
      VALUES ($1, $2, $3, $4, now()) ON CONFLICT ON CONSTRAINT desk_sale_bills_key DO NOTHING`, [org.orgId, org.premisesId, billId, name]), u);
  await add('Test Patient');
  await add('Someone Else');
  const party = await inOrg(org.orgId, async (c) => (await c.query('SELECT patient_name FROM desk_sale_bills')).rows, u);
  assert.deepEqual(party, [{ patient_name: 'Test Patient' }]);
  // A row that says nothing, or a name with a control character, is refused by the table itself.
  const refused = (sql: string) => inOrg(org.orgId, (c) => c.query(sql, [org.orgId, org.premisesId]), u).then(() => 'ok', (e) => (e as { constraint?: string }).constraint);
  assert.equal(await refused('INSERT INTO desk_sale_bills (org_id, premises_id, bill_id, received_at) VALUES ($1, $2, gen_random_uuid(), now())'), 'desk_sale_bills_some');
  assert.equal(await refused("INSERT INTO desk_sale_bills (org_id, premises_id, bill_id, doctor_name, received_at) VALUES ($1, $2, gen_random_uuid(), E'Dr\\nX', now())"), 'desk_sale_bills_doctor_name');
});
