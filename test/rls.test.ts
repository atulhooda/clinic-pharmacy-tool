// 06b §4: RLS and role self-tests (DS-01 … DS-08, DS-13 … DS-15, DS-17).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { as, pgCode, urls } from './harness/env';
import { createOrg, createStaff, createPrescriber, createDeviceAndSession, type OrgFixture } from './harness/fixtures';
import { withTenant } from '../lib/db/tenant';
import { listTables, checkRls } from '../lib/db/catalog';
import { wrap } from '../lib/db/db';

let A: OrgFixture;
let B: OrgFixture;
let appPool: pg.Pool;

before(async () => {
  A = await createOrg('a');
  B = await createOrg('b');
  appPool = new pg.Pool({ connectionString: urls.app, max: 2 });
});
after(async () => {
  await appPool.end();
});

/** Every table RLS must cover: those with org_id, plus the tenant root. Derived from the catalog. */
async function scopedTables(): Promise<string[]> {
  const tables = await as('app', async (c) => listTables(wrap(c)));
  return tables.filter((t) => t.hasOrg || t.name === 'organisations').map((t) => t.name);
}

test('DS-01: outside withTenant, the app role sees zero rows in every tenant table', async () => {
  const tables = await scopedTables();
  assert.ok(tables.includes('organisations') && tables.includes('premises'));
  await as('app', async (c) => {
    for (const t of tables) {
      const { rows } = await c.query(`SELECT count(*) AS n FROM "${t}"`);
      assert.equal(rows[0].n, 0, `${t} leaked rows outside withTenant`);
    }
  });
});

test('DS-02: outside withTenant, an INSERT fails WITH CHECK', async () => {
  const code = await as('app', (c) => pgCode(c.query(
    'INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, $2, $3, $4)', [A.orgId, 'Leak', 'x', '24'])));
  assert.equal(code, '42501');
});

test("DS-03: inside withTenant(A), inserting org B's row fails WITH CHECK", async () => {
  const code = await pgCode(withTenant(A.orgId, (db) => db.rows(
    'INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, $2, $3, $4)', [B.orgId, 'Cross', 'x', '24']), appPool));
  assert.equal(code, '42501');
});

test("DS-04: inside withTenant(A), every tenant table returns only A's rows", async () => {
  // Give both organisations rows in the identity tables, so a leak would be visible.
  for (const o of [A, B]) {
    const s = await createStaff(o, { role: 'owner' });
    await createPrescriber(o);
    await createDeviceAndSession(o, s.id);
  }
  const tables = await scopedTables();
  const othersExist = await as('super', async (c) => {
    const out: string[] = [];
    for (const t of tables) {
      const key = t === 'organisations' ? 'id' : 'org_id';
      const { rows } = await c.query(`SELECT count(*) AS n FROM "${t}" WHERE ${key} <> $1`, [A.orgId]);
      if (Number(rows[0].n) > 0) out.push(t);
    }
    return out;
  });
  assert.ok(othersExist.length >= 8, `too few tables hold other tenants' rows to prove anything: ${othersExist}`);
  await withTenant(A.orgId, async (db) => {
    for (const t of tables) {
      const key = t === 'organisations' ? 'id' : 'org_id';
      const rows = await db.rows<{ k: string }>(`SELECT ${key}::text AS k FROM "${t}"`);
      assert.ok(rows.every((r) => r.k === A.orgId), `${t}: another tenant's row is visible`);
    }
    for (const t of ['organisations', 'premises', 'staff_users', 'sessions']) {
      const rows = await db.rows(`SELECT 1 FROM "${t}"`);
      assert.ok(rows.length > 0, `${t}: A's own rows must be visible`);
    }
  }, appPool);
});

test('DS-05 / DS-06: the setting never outlives its transaction on a pooled connection', async () => {
  const one = new pg.Pool({ connectionString: urls.app, max: 1 });
  try {
    await withTenant(A.orgId, (db) => db.rows('SELECT 1'), one); // commit
    let r = await one.query("SELECT count(*) AS n, coalesce(current_setting('app.org_id', true), '') AS s FROM premises");
    assert.deepEqual([r.rows[0].n, r.rows[0].s], [0, ''], 'after COMMIT');

    await assert.rejects(withTenant(A.orgId, async () => { throw new Error('boom'); }, one)); // rollback
    r = await one.query("SELECT count(*) AS n, coalesce(current_setting('app.org_id', true), '') AS s FROM premises");
    assert.deepEqual([r.rows[0].n, r.rows[0].s], [0, ''], 'after ROLLBACK');
  } finally {
    await one.end();
  }
});

test('DS-07 / DS-14: RLS is enabled and forced everywhere, with only reviewed policies', async () => {
  const problems = await as('app', (c) => checkRls(wrap(c)));
  assert.deepEqual(problems, []);
  const policies = await as('app', async (c) => (await c.query(
    "SELECT tablename || '.' || policyname AS p FROM pg_policies WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.p));
  const expected = [...(await scopedTables()).map((t) => `${t}.tenant_isolation`), 'organisations.org_directory'].sort();
  assert.deepEqual(policies, expected);
});

test('DS-08: the app role is not a superuser, has no BYPASSRLS and owns nothing; only the migrator owns tables', async () => {
  await as('super', async (c) => {
    const { rows } = await c.query(`SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
      FROM pg_roles WHERE rolname LIKE 'pharmacy\\_%' ORDER BY rolname`);
    assert.deepEqual(rows.map((r) => r.rolname),
      ['pharmacy_app', 'pharmacy_curator', 'pharmacy_jobs', 'pharmacy_migrator', 'pharmacy_ops', 'pharmacy_resolver']);
    for (const r of rows) {
      assert.equal(r.rolsuper, false, `${r.rolname} is a superuser`);
      assert.equal(r.rolbypassrls, false, `${r.rolname} has BYPASSRLS`);
      assert.equal(r.rolcreaterole || r.rolcreatedb, false, `${r.rolname} can create roles or databases`);
    }
    assert.equal(rows.find((r) => r.rolname === 'pharmacy_resolver').rolcanlogin, false);
    const owners = await c.query(`SELECT DISTINCT pg_get_userbyid(c.relowner) AS o FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v')`);
    assert.deepEqual(owners.rows.map((r) => r.o), ['pharmacy_migrator']);
  });
});

test('DS-13: auth_resolve_org returns an active organisation\'s id and name, and nothing else', async () => {
  const suspended = await createOrg('s', { status: 'SUSPENDED' });
  await as('app', async (c) => {
    const hit = await c.query('SELECT * FROM auth_resolve_org($1)', [A.slug.toUpperCase()]);
    assert.equal(hit.rows.length, 1);
    assert.deepEqual(Object.keys(hit.rows[0]).sort(), ['display_name', 'id']);
    assert.equal(hit.rows[0].id, A.orgId);
    assert.equal((await c.query('SELECT * FROM auth_resolve_org($1)', ['no-such-org'])).rows.length, 0);
    assert.equal((await c.query('SELECT * FROM auth_resolve_org($1)', [suspended.slug])).rows.length, 0);
  });
  // No other role may call it.
  assert.equal(await as('jobs', (c) => pgCode(c.query('SELECT * FROM auth_resolve_org($1)', [A.slug]))), '42501');
});

test('DS-15: the jobs role reads the organisation list but no tenant rows outside withTenant', async () => {
  await as('jobs', async (c) => {
    const ids = (await c.query('SELECT id::text AS id FROM organisations')).rows.map((r) => r.id);
    assert.ok(ids.includes(A.orgId) && ids.includes(B.orgId));
    assert.equal((await c.query('SELECT count(*) AS n FROM premises')).rows[0].n, 0);
  });
});

test('DS-17: pharmacy_resolver can read four columns of organisations and nothing else', async () => {
  await as('migrator', async (c) => {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE pharmacy_resolver');
    const ok = await c.query('SELECT id, slug, display_name, status FROM organisations');
    assert.ok(ok.rows.length >= 2);
    await c.query('SAVEPOINT s');
    assert.equal(await pgCode(c.query('SELECT legal_name FROM organisations')), '42501');
    await c.query('ROLLBACK TO SAVEPOINT s');
    assert.equal(await pgCode(c.query('SELECT * FROM premises')), '42501');
    await c.query('ROLLBACK');
  });
  // The app is not a member of the resolver role.
  assert.equal(await as('app', (c) => pgCode(c.query('SET ROLE pharmacy_resolver'))), '42501');
});

test('ops creates organisations only for the organisation in its transaction setting', async () => {
  const code = await as('ops', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [A.orgId]);
    const r = await pgCode(c.query(
      "INSERT INTO organisations (id, slug, display_name) VALUES (gen_random_uuid(), 'other-org', 'Other')"));
    await c.query('ROLLBACK');
    return r;
  });
  assert.equal(code, '42501');
});
