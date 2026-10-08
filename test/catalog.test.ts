// 06b DS-18 … DS-21, DMG-05, DMG-07, DMG-09, DMG-14: tenant integrity beyond RLS (06a §2.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { as, pgCode, urls } from './harness/env';
import { createOrg } from './harness/fixtures';
import { checkKeys, checkForeignKeys, listConstraints, listTables, listUniqueIndexes, REVIEWED_EXCEPTIONS } from '../lib/db/catalog';
import { wrap } from '../lib/db/db';
import { withTenant } from '../lib/db/tenant';
import { FK_BUILDERS, UNIQUE_BUILDERS } from './harness/builders';
import pg from 'pg';

test('DS-18 / DMG-05: keys and unique constraints pass on the migrated schema', async () => {
  assert.deepEqual(await as('app', (c) => checkKeys(wrap(c))), []);
});

test('DS-18: the key check catches a single-column primary key, a unique without org_id, and a defaulted org_id', async () => {
  await as('migrator', async (c) => {
    await c.query('BEGIN');
    await c.query(`CREATE TABLE bad_keys (
      org_id uuid NOT NULL DEFAULT gen_random_uuid() REFERENCES organisations (id) ON DELETE RESTRICT,
      id uuid NOT NULL, name text, PRIMARY KEY (id))`);
    await c.query('CREATE UNIQUE INDEX bad_keys_name ON bad_keys (name)');
    const problems = await checkKeys(wrap(c));
    await c.query('ROLLBACK');
    assert.ok(problems.some((p) => p.includes('bad_keys: primary key must be (org_id, id)')), problems.join('\n'));
    assert.ok(problems.some((p) => p.includes('bad_keys_name') && p.includes('org_id')));
    assert.ok(problems.some((p) => p.includes('bad_keys: org_id must not have a default')));
  });
});

test('DS-19: foreign keys pass on the migrated schema', async () => {
  assert.deepEqual(await as('app', (c) => checkForeignKeys(wrap(c))), []);
});

test('DS-19: the FK check catches a non-composite FK and a batch FK without premises_id', async () => {
  await as('migrator', async (c) => {
    await c.query('BEGIN');
    // A single-column FK to premises cannot even be declared: premises has no key on id alone.
    await c.query('SAVEPOINT s');
    assert.equal(await pgCode(c.query(`CREATE TABLE fk_single (org_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
      id uuid NOT NULL, premises_id uuid REFERENCES premises (id), PRIMARY KEY (org_id, id))`)), '42830');
    await c.query('ROLLBACK TO SAVEPOINT s');
    // A premises-scoped parent referenced without premises_id.
    await c.query(`CREATE TABLE batches (org_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
      id uuid NOT NULL, premises_id uuid NOT NULL, PRIMARY KEY (org_id, id), UNIQUE (org_id, premises_id, id))`);
    await c.query(`CREATE TABLE child_of_batches (org_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
      id uuid NOT NULL, batch_id uuid, PRIMARY KEY (org_id, id), FOREIGN KEY (org_id, batch_id) REFERENCES batches (org_id, id))`);
    // A tenant table pointing at the tenant root through a column other than org_id.
    await c.query(`CREATE TABLE odd_root_ref (org_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
      id uuid NOT NULL, other_org uuid REFERENCES organisations (id), PRIMARY KEY (org_id, id))`);
    const problems = await checkForeignKeys(wrap(c));
    await c.query('ROLLBACK');
    assert.ok(problems.some((p) => p.includes('child_of_batches') && p.includes('premises_id')), problems.join('\n'));
    assert.ok(problems.some((p) => p.includes('odd_root_ref') && p.includes('not a reviewed exception')));
  });
});

test('DS-20: every FK between tenant tables has a cross-tenant builder, and each cross-tenant insert fails', async () => {
  const tables = await as('app', (c) => listTables(wrap(c)));
  const tenant = new Set(tables.filter((t) => t.hasOrg).map((t) => t.name));
  const fks = (await as('app', (c) => listConstraints(wrap(c))))
    .filter((k) => k.type === 'f' && tenant.has(k.table) && tenant.has(k.refTable ?? ''));
  assert.deepEqual(fks.map((k) => k.name).sort(), Object.keys(FK_BUILDERS).sort(),
    'every FK between tenant tables needs a builder in test/harness/builders.ts');
  const A = await createOrg('fka');
  const B = await createOrg('fkb');
  for (const k of fks) assert.equal(await FK_BUILDERS[k.name](A, B), '23503', `${k.name} accepted a cross-tenant reference`);
});

test('DS-20: a composite FK refuses a cross-tenant reference even though FK checks bypass RLS', async () => {
  const A = await createOrg('fkd');
  const B = await createOrg('fke');
  await as('migrator', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [A.orgId]);
    await c.query(`CREATE TABLE demo_child (org_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
      id uuid NOT NULL DEFAULT gen_random_uuid(), premises_id uuid NOT NULL, PRIMARY KEY (org_id, id),
      FOREIGN KEY (org_id, premises_id) REFERENCES premises (org_id, id))`);
    await c.query('SAVEPOINT s');
    assert.equal(await pgCode(c.query('INSERT INTO demo_child (org_id, premises_id) VALUES ($1, $2)', [A.orgId, B.premisesId])), '23503');
    await c.query('ROLLBACK TO SAVEPOINT s');
    await c.query('INSERT INTO demo_child (org_id, premises_id) VALUES ($1, $2)', [A.orgId, A.premisesId]);
    await c.query('ROLLBACK');
  });
});

test('DS-21: every unique has a builder; a duplicate in another organisation is fine, in the same one it is a violation', async () => {
  const tables = await as('app', (c) => listTables(wrap(c)));
  const tenant = new Set(tables.filter((t) => t.hasOrg).map((t) => t.name));
  const uniques = (await as('app', (c) => listUniqueIndexes(wrap(c)))).filter((u) => tenant.has(u.table) && !u.primary);
  assert.deepEqual(uniques.map((u) => u.name).sort(), Object.keys(UNIQUE_BUILDERS).sort(),
    'every unique index on a tenant table needs a builder in test/harness/builders.ts');
  const A = await createOrg('ua');
  const B = await createOrg('ub');
  for (const u of uniques) {
    const result = await UNIQUE_BUILDERS[u.name](A, B);
    assert.deepEqual(result, { otherOrg: 'ok', sameOrg: '23505' }, u.name);
  }
});

test('DMG-07: the app role holds no TRUNCATE, no DELETE, and cannot insert organisations', async () => {
  await as('super', async (c) => {
    const tables = (await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`)).rows.map((r) => r.relname);
    for (const t of tables) {
      for (const priv of ['TRUNCATE', 'DELETE', 'REFERENCES', 'TRIGGER']) {
        const { rows } = await c.query('SELECT has_table_privilege($1, $2, $3) AS ok', ['pharmacy_app', `public."${t}"`, priv]);
        assert.equal(rows[0].ok, false, `pharmacy_app has ${priv} on ${t}`);
      }
    }
    const ins = await c.query("SELECT has_table_privilege('pharmacy_app', 'organisations', 'INSERT') AS i, has_table_privilege('pharmacy_app', 'organisations', 'UPDATE') AS u");
    assert.deepEqual(ins.rows[0], { i: false, u: false });
    const fn = await c.query("SELECT has_function_privilege('pharmacy_jobs', 'auth_resolve_org(text)', 'EXECUTE') AS j, has_function_privilege('pharmacy_app', 'auth_resolve_org(text)', 'EXECUTE') AS a");
    assert.deepEqual(fn.rows[0], { j: false, a: true });
  });
});

test('DMG-09: the server is Postgres 15 or newer', async () => {
  const v = await as('app', async (c) => Number((await c.query("SELECT current_setting('server_version_num') AS v")).rows[0].v));
  assert.ok(v >= 150000, `server_version_num ${v}`);
});

test('DMG-14: the reviewed exceptions are exactly the list in 06a §2.6 rule 5', () => {
  assert.deepEqual([...REVIEWED_EXCEPTIONS.nonTenantTables].sort(), ['medicine_master', 'organisations', 'schema_migrations']);
  assert.deepEqual(REVIEWED_EXCEPTIONS.foreignKeysToNonTenant.map((e) => `${e.cols.join()}→${e.refTable}.${e.refCols.join()}`).sort(),
    ['master_id→medicine_master.id', 'matched_master_id→medicine_master.id', 'org_id→organisations.id']);
  assert.deepEqual(REVIEWED_EXCEPTIONS.policies.map((p) => `${p.table}.${p.policy}`).sort(),
    ['master_correction_requests.curation_select', 'master_correction_requests.curation_update', 'organisations.org_directory']);
  const spec = fs.readFileSync(path.join(process.cwd(), 'docs/specs/06a-dispensary-ledger.design.md'), 'utf8');
  const rule5 = spec.slice(spec.indexOf('5. **Reviewed exceptions**'), spec.indexOf('6. **Sequence numbers.**'));
  for (const name of ['organisations', 'medicine_master', 'items.master_id', 'stock_import_rows.matched_master_id', 'schema_migrations']) {
    assert.ok(rule5.includes(name), `06a §2.6 rule 5 no longer mentions ${name}`);
  }
});

test('withTenant inserts are confined to the tenant (sanity check for the builders)', async () => {
  const A = await createOrg('wt');
  const pool = new pg.Pool({ connectionString: urls.app, max: 1 });
  try {
    const rows = await withTenant(A.orgId, (db) => db.rows<{ n: number }>('SELECT count(*) AS n FROM premises'), pool);
    assert.equal(rows[0].n, 1);
  } finally {
    await pool.end();
  }
});
