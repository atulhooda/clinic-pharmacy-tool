// 06b §12 (DAU): the audit log. DAU-06 (the audit view, M-12) comes with PR 4.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { as, freshDatabase, pgCode } from './harness/env';
import { createOrg, createStaff, inOrg } from './harness/fixtures';
import { call, signIn } from './harness/http';
import { sanitizeDetail, AuditDetailError } from '../lib/audit';
import { setPoolForTests } from '../lib/db/pool';
import { resetSchemaStatusCache } from '../lib/db/selfcheck';
import { setLogSink } from '../lib/log';
import { POST as signInRoute } from '../app/api/auth/sign-in/route';
import { PUT as passwordRoute } from '../app/api/account/password/route';
import { POST as signOutRoute } from '../app/api/auth/sign-out/route';
import { POST as revokeAllRoute } from '../app/api/account/sessions/revoke/route';

const pools: pg.Pool[] = [];
after(async () => {
  setPoolForTests(undefined);
  await Promise.all(pools.map((p) => p.end()));
});

test('DAU-01: the app cannot update, delete or truncate the audit log; the migrator is stopped by the trigger', async () => {
  const org = await createOrg('dau1');
  await inOrg(org.orgId, (c) => c.query("INSERT INTO audit_log (org_id, actor_label, actor_role, action) VALUES ($1, 'x', 'system', 'test.row')", [org.orgId]));
  for (const sql of ['UPDATE audit_log SET action = $2 WHERE org_id = $1', 'DELETE FROM audit_log WHERE org_id = $1']) {
    const code = await as('app', async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      const r = await pgCode(c.query(sql, sql.startsWith('UPDATE') ? [org.orgId, 'x.y'] : [org.orgId]));
      await c.query('ROLLBACK');
      return r;
    });
    assert.equal(code, '42501', sql);
  }
  assert.equal(await as('app', (c) => pgCode(c.query('TRUNCATE audit_log'))), '42501');
  const migrator = await as('migrator', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    const r = await c.query("UPDATE audit_log SET action = 'x.y' WHERE org_id = $1", [org.orgId]).catch((e) => e);
    await c.query('ROLLBACK');
    return r;
  });
  assert.equal(migrator.hint, 'LEDGER_APPEND_ONLY');
});

test('DAU-02: the app role cannot disable the audit trigger (it does not own the table)', async () => {
  assert.equal(await as('app', (c) => pgCode(c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only'))), '42501');
});

test('DAU-03: the detail sanitiser refuses big numbers, free text, unknown keys and objects', () => {
  assert.deepEqual(sanitizeDetail({ method: 'password', count: 3, paused: false }), { method: 'password', count: 3, paused: false });
  for (const bad of [{ count: 9800000001 }, { reason: 'Sunita Patil' }, { phone: '+919800000001' }, { fields: [{ a: 1 }] }, { reason: 'x'.repeat(65) }]) {
    assert.throws(() => sanitizeDetail(bad as Record<string, unknown>), AuditDetailError, JSON.stringify(bad));
  }
});

test('DAU-03: when the audit row cannot be written, the security change rolls back with it', async () => {
  const u = await freshDatabase();
  const p = new pg.Pool({ connectionString: u.app, max: 2 });
  pools.push(p);
  setPoolForTests(p);
  resetSchemaStatusCache();
  const org = await createOrg('dau3', { from: u });
  // Create the person in the fresh database.
  const { hashPassword } = await import('../lib/auth/password');
  const hash = await hashPassword('original-pass-1');
  await as('app', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    await c.query("INSERT INTO staff_users (org_id, name, login, role_key, password_hash) VALUES ($1, 'Dau Three', 'dau3', 'reception', $2)", [org.orgId, hash]);
    await c.query('COMMIT');
  }, u);
  const login = await call(signInRoute, { body: { orgSlug: org.slug, login: 'dau3', password: 'original-pass-1' }, ip: '10.31.0.1' });
  assert.equal(login.status, 200);
  const cookie = login.setCookie!.split(';')[0];
  await as('migrator', (c) => c.query('REVOKE INSERT ON audit_log FROM pharmacy_app'), u);
  const r = await call(passwordRoute, { cookie, method: 'PUT', body: { current: 'original-pass-1', next: 'brand-new-pass-2' } });
  assert.equal(r.status, 500);
  const again = await call(signInRoute, { body: { orgSlug: org.slug, login: 'dau3', password: 'original-pass-1' }, ip: '10.31.0.2' });
  assert.equal(again.status, 500, 'sign-in success is also transactional with its audit row');
  await as('migrator', (c) => c.query('GRANT INSERT ON audit_log TO pharmacy_app'), u);
  // The old password still works and the new one does not: the change did not land without its audit row.
  assert.equal((await call(signInRoute, { body: { orgSlug: org.slug, login: 'dau3', password: 'brand-new-pass-2' }, ip: '10.31.0.4' })).status, 401);
  assert.equal((await call(signInRoute, { body: { orgSlug: org.slug, login: 'dau3', password: 'original-pass-1' }, ip: '10.31.0.3' })).status, 200);
  setPoolForTests(undefined);
  resetSchemaStatusCache();
});

test('DAU-04: each security event writes exactly one audit row', async () => {
  const org = await createOrg('dau4');
  const s = await createStaff(org);
  await call(signInRoute, { body: { orgSlug: org.slug, login: s.login, password: 'wrong-one' }, ip: '10.32.0.1' });
  const cookie = await signIn(org.slug, s.login, s.password, '10.32.0.2');
  await call(passwordRoute, { cookie, method: 'PUT', body: { current: s.password, next: 'fresh-river-pass-4' } });
  const second = await signIn(org.slug, s.login, 'fresh-river-pass-4', '10.32.0.3');
  await call(signOutRoute, { cookie: second, method: 'POST' });
  const third = await signIn(org.slug, s.login, 'fresh-river-pass-4', '10.32.0.4');
  await call(revokeAllRoute, { cookie: third, method: 'POST' });
  const counts = await inOrg(org.orgId, async (c) => Object.fromEntries((await c.query(
    'SELECT action, count(*) AS n FROM audit_log GROUP BY action')).rows.map((r) => [r.action, Number(r.n)])));
  assert.deepEqual(counts, {
    'auth.sign_in_failed': 1, 'auth.sign_in_succeeded': 3, 'auth.password_changed': 1, 'auth.sign_out': 1, 'auth.sessions_revoked': 1,
  });
});

test('DAU-05: a best-effort audit failure never turns the answer into an error; the log names the action only', async () => {
  const u = await freshDatabase();
  const p = new pg.Pool({ connectionString: u.app, max: 2 });
  pools.push(p);
  setPoolForTests(p);
  resetSchemaStatusCache();
  const org = await createOrg('dau5', { from: u });
  await as('migrator', (c) => c.query('REVOKE INSERT ON audit_log FROM pharmacy_app'), u);
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try {
    const r = await call(signInRoute, { body: { orgSlug: org.slug, login: 'secret-login-typed', password: 'x' }, ip: '10.33.0.1' });
    assert.deepEqual([r.status, r.body.code], [401, 'invalid_credentials']);
  } finally {
    restore();
    setPoolForTests(undefined);
    resetSchemaStatusCache();
  }
  const failed = lines.filter((l) => l.includes('audit_failed'));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /"action":"auth.sign_in_failed","code":"42501"/);
  assert.ok(!lines.join().includes('secret-login-typed'));
});
