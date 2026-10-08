// 06a §2.5: the startup self-check and the 503 gate (06b DS-09, DS-10, DS-14, DMG-13, DH-07).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { as, freshDatabase, urls, type Urls } from './harness/env';
import { verifySchema, resetSchemaStatusCache } from '../lib/db/selfcheck';
import { wrap } from '../lib/db/db';
import { setPoolForTests } from '../lib/db/pool';
import { gated } from '../lib/http/api';
import { setLogSink } from '../lib/log';
import { GET as health } from '../app/api/health/route';

const pools: pg.Pool[] = [];
after(async () => {
  setPoolForTests(undefined);
  await Promise.all(pools.map((p) => p.end()));
});
function usePool(url: string): pg.Pool {
  const p = new pg.Pool({ connectionString: url, max: 2 });
  pools.push(p);
  setPoolForTests(p);
  resetSchemaStatusCache();
  return p;
}

async function verifyAs(u: Urls, role: 'app' | 'super' = 'app') {
  return as(role, (c) => verifySchema(wrap(c)), u);
}

const okHandler = gated(async () => new Response('fine'));

test('the self-check passes for the app role on a migrated database, and the gate lets requests through', async () => {
  assert.deepEqual(await verifyAs(urls), { ok: true, failures: [] });
  usePool(urls.app);
  const res = await okHandler(new Request('http://x/api/anything'), {});
  assert.equal(res.status, 200);
  const h = await health();
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await h.json(), { ok: true, schemaVerified: true });
});

test('DS-09: connected as a superuser, every gated route answers 503 SCHEMA_UNVERIFIED; /api/health still answers', async () => {
  const status = await verifyAs(urls, 'super');
  assert.equal(status.ok, false);
  assert.ok(status.failures.some((f) => /^role: \S+ is a superuser$/.test(f)), status.failures.join('\n'));

  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try {
    usePool(urls.super);
    const res = await okHandler(new Request('http://x/api/anything'), {});
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'SCHEMA_UNVERIFIED');
    assert.equal(typeof body.error, 'string'); // DH-07: every error body has error and code
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await (await health()).json(), { ok: true, schemaVerified: false });
    assert.ok(lines.some((l) => l.includes('"event":"schema_unverified"') && / is a superuser/.test(l)),
      'the failed check is logged by name');
  } finally {
    restore();
    usePool(urls.app);
  }
});

test('DS-10: RLS no longer forced on a table fails the check; forcing it again restores it', async () => {
  const u = await freshDatabase();
  await as('migrator', (c) => c.query('ALTER TABLE premises NO FORCE ROW LEVEL SECURITY'), u);
  const bad = await verifyAs(u);
  assert.ok(bad.failures.includes('rls: table premises: row-level security must be enabled and forced'), bad.failures.join('\n'));
  await as('migrator', (c) => c.query('ALTER TABLE premises FORCE ROW LEVEL SECURITY'), u);
  assert.deepEqual(await verifyAs(u), { ok: true, failures: [] });
});

test('DS-14: an unreviewed policy fails the check', async () => {
  const u = await freshDatabase();
  await as('migrator', (c) => c.query('CREATE POLICY sneaky ON premises FOR SELECT USING (true)'), u);
  const bad = await verifyAs(u);
  assert.ok(bad.failures.includes('rls: policy sneaky on premises is not on the reviewed list'), bad.failures.join('\n'));
});

test('a missing enforcement object fails the check (06b DL-18 pattern)', async () => {
  const u = await freshDatabase();
  // CASCADE also drops the append-only triggers that use it (002, 010); each is reported.
  await as('migrator', (c) => c.query('DROP FUNCTION forbid_mutation() CASCADE'), u);
  const bad = await verifyAs(u);
  for (const f of ['objects: function forbid_mutation is missing',
    'objects: trigger audit_log_append_only on audit_log is missing or disabled',
    'objects: trigger org_settings_history_append_only on org_settings_history is missing or disabled']) {
    assert.ok(bad.failures.includes(f), `${f}\n---\n${bad.failures.join('\n')}`);
  }
});

test('the app role owning a table fails the check', async () => {
  const u = await freshDatabase();
  await as('super', (c) => c.query('ALTER TABLE premises OWNER TO pharmacy_app'), u);
  const bad = await verifyAs(u);
  assert.ok(bad.failures.includes('ownership: premises is owned by the app role'), bad.failures.join('\n'));
});

test('DMG-13: applied migrations that differ from this build fail the check', async () => {
  const u = await freshDatabase();
  await as('migrator', (c) => c.query("UPDATE schema_migrations SET sha256 = repeat('0', 64) WHERE version = 1"), u);
  const bad = await verifyAs(u);
  assert.ok(bad.failures.includes('migrations: 001_tenancy_foundation.sql differs from the applied version'), bad.failures.join('\n'));

  const unmigrated = await freshDatabase({ migrate: false });
  const none = await verifyAs(unmigrated);
  assert.equal(none.ok, false);
  assert.ok(none.failures.some((f) => f.startsWith('check: could not run')), none.failures.join('\n'));
});

test('an unexpected error becomes a 500 with a request id, and the log carries no message text', async () => {
  usePool(urls.app);
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try {
    const boom = gated(async () => {
      throw new Error('Sunita Patil +91 98000 00001');
    });
    const res = await boom(new Request('http://x/api/boom'), {});
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'requestId']);
    assert.equal(body.code, 'INTERNAL');
    assert.ok(!lines.join('\n').includes('Sunita') && !lines.join('\n').includes('98000'));
  } finally {
    restore();
  }
});
