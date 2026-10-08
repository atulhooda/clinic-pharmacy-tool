// lib/db: the int8 parser (06b DH-05), NUMERIC as string (DH-06), and withTenant's contract.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { urls } from './harness/env';
import { createOrg } from './harness/fixtures';
import { parseInt8 } from '../lib/db/pool';
import { withTenant } from '../lib/db/tenant';

const pool = new pg.Pool({ connectionString: urls.app, max: 2 });
after(() => pool.end());

test('DH-05: int8 values parse to numbers; values beyond 2^53 throw instead of losing precision', async () => {
  assert.equal(parseInt8('2147483648'), 2147483648);
  assert.equal(parseInt8('-42'), -42);
  assert.throws(() => parseInt8('9007199254740993'), RangeError);
  const { rows } = await pool.query('SELECT 3000000000::int8 AS big, count(*) AS n FROM (VALUES (1), (2)) v(x)');
  assert.deepEqual(rows[0], { big: 3000000000, n: 2 });
  await assert.rejects(pool.query('SELECT 9007199254740993::int8 AS too_big'), RangeError);
});

test('DH-06: NUMERIC stays an exact string (quantities are parsed as integer milli-units, never floats)', async () => {
  const { rows } = await pool.query('SELECT 1.500::numeric(12,3) AS q');
  assert.equal(rows[0].q, '1.500');
});

test('withTenant refuses an organisation id that is not a UUID, before touching the database', async () => {
  const neverUsed = { connect: () => assert.fail('connected') } as unknown as pg.Pool;
  await assert.rejects(withTenant('1 OR 1=1', async () => 1, neverUsed), TypeError);
  await assert.rejects(withTenant('', async () => 1, neverUsed), TypeError);
});

test('withTenant commits on success and rolls back everything on error', async () => {
  const A = await createOrg('tx');
  const insert = 'INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, $2, $3, $4)';
  await withTenant(A.orgId, (db) => db.rows(insert, [A.orgId, 'Kept', 'x', '24']), pool);
  await assert.rejects(withTenant(A.orgId, async (db) => {
    await db.rows(insert, [A.orgId, 'Rolled Back', 'x', '24']);
    throw new Error('fail after insert');
  }, pool));
  const names = await withTenant(A.orgId, (db) => db.rows<{ name: string }>('SELECT name FROM premises ORDER BY name'), pool);
  assert.deepEqual(names.map((r) => r.name), ['Kept', 'Main']);
});
