// 06b §5 cross-tenant rows for the PR 2 endpoints (DX-01, DX-02, DX-04, DX-08's token half) and
// the route gate (DX-77). Not here yet:
// - DX-03 (OTP): Milestone 2 (D-39);
// - DX-01's device-cookie half, DX-05 … DX-07 and DX-08's device_mismatch half: PR 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrg, createStaff, inOrg } from './harness/fixtures';
import { call, signIn } from './harness/http';
import { signSessionToken } from '../lib/auth/token';
import { ROUTES } from '../lib/routes';
import { GET as contextRoute } from '../app/api/auth/context/route';
import { POST as signInRoute } from '../app/api/auth/sign-in/route';
import { GET as meRoute } from '../app/api/auth/me/route';
import { PUT as passwordRoute } from '../app/api/account/password/route';
import { POST as revokeAllRoute } from '../app/api/account/sessions/revoke/route';
import { POST as signOutRoute } from '../app/api/auth/sign-out/route';
import { GET as healthRoute } from '../app/api/health/route';

test("DX-01: A-01 gives another organisation's display name for its public link, never an id", async () => {
  const B = await createOrg('dxb');
  const r = await call(contextRoute, { path: `/api/auth/context?org=${B.slug}` });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { org: { slug: B.slug, displayName: 'Synthetic dxb' }, trustedDevice: false });
  assert.ok(!JSON.stringify(r.body).includes(B.orgId));
  const none = await call(contextRoute, { path: '/api/auth/context?org=no-such-clinic' });
  assert.deepEqual([none.status, none.body.code], [404, 'ORG_NOT_FOUND']);
  const suspended = await createOrg('dxs', { status: 'SUSPENDED' });
  assert.equal((await call(contextRoute, { path: `/api/auth/context?org=${suspended.slug}` })).status, 404);
});

test("DX-02: B's login and password at A's link get the unknown-login answer; B's counters are untouched", async () => {
  const A = await createOrg('dxa2');
  const B = await createOrg('dxb2');
  const bUser = await createStaff(B);
  const r = await call(signInRoute, { body: { orgSlug: A.slug, login: bUser.login, password: bUser.password }, ip: '10.40.0.1' });
  const unknown = await call(signInRoute, { body: { orgSlug: A.slug, login: 'never-existed', password: 'x' }, ip: '10.40.0.2' });
  assert.deepEqual([r.status, r.body.code, r.body.error], [unknown.status, unknown.body.code, unknown.body.error]);
  const counters = await inOrg(B.orgId, async (c) => (await c.query('SELECT password_failures AS f, password_paused_until AS p FROM staff_users WHERE id = $1', [bUser.id])).rows[0]);
  assert.deepEqual(counters, { f: 0, p: null });
});

test('DX-04: self-only endpoints refuse any field naming another user, organisation or session', async () => {
  const A = await createOrg('dxa4');
  const a = await createStaff(A);
  const cookie = await signIn(A.slug, a.login, a.password, '10.41.0.1');
  for (const extra of [{ staffUserId: a.id }, { orgId: A.orgId }, { sessionId: '00000000-0000-4000-8000-000000000000' }]) {
    const r = await call(passwordRoute, { cookie, method: 'PUT', body: { current: a.password, next: 'unused-new-pass-1', ...extra } });
    assert.deepEqual([r.status, r.body.code, r.body.details.field], [422, 'UNKNOWN_FIELD', Object.keys(extra)[0]]);
    const s = await call(signInRoute, { body: { orgSlug: A.slug, login: a.login, password: a.password, ...extra }, ip: '10.41.0.2' });
    assert.equal(s.status, 422);
  }
  const who = await call(meRoute, { cookie });
  assert.deepEqual(who.body.org, { slug: A.slug, displayName: 'Synthetic dxa4' });
});

test("DX-08: a token naming another organisation with this session's id finds nothing; a token re-signed with a wrong key is refused", async () => {
  const A = await createOrg('dxa8');
  const B = await createOrg('dxb8');
  const a = await createStaff(A);
  const cookie = await signIn(A.slug, a.login, a.password, '10.42.0.1');
  const sid = JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[1], 'base64url').toString()).sid;
  // Even with the real key (a server bug, not an attacker), B's tenant cannot see A's session row.
  const crossed = await signSessionToken(B.orgId, sid, new Date(Date.now() + 3600_000));
  assert.equal((await call(meRoute, { cookie: `pharm_session=${crossed}` })).body.code, 'session_revoked');
  const saved = process.env.SESSION_SECRET!;
  process.env.SESSION_SECRET = 'an-attackers-guess-at-the-secret-key-123';
  const forged = await signSessionToken(B.orgId, sid, new Date(Date.now() + 3600_000));
  process.env.SESSION_SECRET = saved;
  assert.equal((await call(meRoute, { cookie: `pharm_session=${forged}` })).body.code, 'unauthenticated');
});

const HANDLERS: Record<string, Record<string, unknown>> = {
  '/api/health': { GET: healthRoute },
  '/api/auth/context': { GET: contextRoute },
  '/api/auth/sign-in': { POST: signInRoute },
  '/api/auth/sign-out': { POST: signOutRoute },
  '/api/auth/me': { GET: meRoute },
  '/api/account/password': { PUT: passwordRoute },
  '/api/account/sessions/revoke': { POST: revokeAllRoute },
};

test('DX-77: every route is driven against its access rule', async () => {
  const A = await createOrg('dx77');
  const a = await createStaff(A);
  let n = 0;
  for (const r of ROUTES) {
    for (const m of r.methods) {
      const h = HANDLERS[r.path]?.[m];
      assert.ok(h, `test/auth-isolation.test.ts has no handler for ${m} ${r.path}`);
      const anon = await call(h, { method: m, path: r.path, body: m === 'GET' ? undefined : {} });
      if (r.access === 'public') {
        assert.notEqual(anon.status, 401, `${m} ${r.path} is public`);
      } else if (r.access === 'self') {
        assert.deepEqual([anon.status, anon.body.code], [401, 'unauthenticated'], `${m} ${r.path} needs a session`);
        // A fresh session per route: A-16 ends every session it finds.
        const cookie = await signIn(A.slug, a.login, a.password, `10.43.${n++}.1`);
        const signed = await call(h, { method: m, path: r.path, cookie, body: m === 'GET' ? undefined : {} });
        assert.notEqual(signed.status, 401, `${m} ${r.path} accepts a session`);
      } else {
        assert.fail(`${m} ${r.path}: permission routes arrive in PR 4; extend this test then`);
      }
    }
  }
});
