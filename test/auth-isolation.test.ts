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
import { POST as activityRoute } from '../app/api/auth/activity/route';
import { POST as lockRoute } from '../app/api/auth/lock/route';
import { GET as peopleRoute } from '../app/api/auth/device/people/route';
import { POST as switchRoute } from '../app/api/auth/device/switch/route';
import { POST as reauthRoute } from '../app/api/auth/reauth/route';
import { PUT as switchPinRoute } from '../app/api/account/switch-pin/route';
import { PUT as signingPinRoute } from '../app/api/account/signing-pin/route';
import { GET as devicesGet, POST as devicesPost } from '../app/api/devices/route';
import { POST as deviceRevokeRoute } from '../app/api/devices/[id]/revoke/route';
import { effectivePermissions } from '../lib/auth/permissions';
import { GET as settingsGet, PUT as settingsPut } from '../app/api/org/settings/route';
import { GET as premisesGet, POST as premisesPost } from '../app/api/premises/route';
import { PATCH as premisesPatch } from '../app/api/premises/[id]/route';
import { GET as staffList, POST as staffPost } from '../app/api/staff/route';
import { GET as staffGet, PATCH as staffPatch } from '../app/api/staff/[id]/route';
import { POST as staffReset } from '../app/api/staff/[id]/reset/route';
import { POST as staffRevoke } from '../app/api/staff/[id]/sessions/revoke/route';
import { GET as rolesGet, POST as rolesPost } from '../app/api/roles/route';
import { PATCH as rolePatch } from '../app/api/roles/[key]/route';
import { GET as auditGet } from '../app/api/audit/route';
import { GET as dSettingsGet, PUT as dSettingsPut } from '../app/api/dispensary/settings/route';
import { POST as dSetup } from '../app/api/dispensary/setup/route';
import { GET as dPremises } from '../app/api/dispensary/premises/route';
import { POST as dPremisesSetup } from '../app/api/dispensary/premises/[id]/setup/route';
import { PUT as dPremisesSettings } from '../app/api/dispensary/premises/[id]/settings/route';
import { PATCH as dLocation } from '../app/api/dispensary/locations/[id]/route';
import { GET as dMaster } from '../app/api/dispensary/master/route';
import { GET as dMasterOne } from '../app/api/dispensary/master/[id]/route';
import { GET as dItems, POST as dItemsPost } from '../app/api/dispensary/items/route';
import { GET as dItem, PATCH as dItemPatch, DELETE as dItemDelete } from '../app/api/dispensary/items/[id]/route';
import { POST as dUnitPost } from '../app/api/dispensary/items/[id]/units/route';
import { GET as dMovements } from '../app/api/dispensary/items/[id]/movements/route';
import { GET as dGrns, POST as dGrnPost } from '../app/api/dispensary/goods-receipts/route';
import { GET as dGrn, PATCH as dGrnPatch } from '../app/api/dispensary/goods-receipts/[id]/route';
import { POST as dGrnPostIt } from '../app/api/dispensary/goods-receipts/[id]/post/route';
import { POST as dGrnDiscard } from '../app/api/dispensary/goods-receipts/[id]/discard/route';
import { GET as dAdjs, POST as dAdjPost } from '../app/api/dispensary/adjustments/route';
import { GET as dAdj } from '../app/api/dispensary/adjustments/[id]/route';
import { POST as dBatchDetails } from '../app/api/dispensary/adjustments/batch-details/route';
import { POST as dWriteOff } from '../app/api/dispensary/adjustments/write-off/route';
import { GET as dBatchHint } from '../app/api/dispensary/items/[id]/batch-hint/route';
import { GET as dStatement } from '../app/api/dispensary/reports/stock-statement/route';
import { POST as dReadBill } from '../app/api/dispensary/goods-receipts/read-bill/route';
import { PATCH as dUnitPatch } from '../app/api/dispensary/items/[id]/units/[unitId]/route';
import { GET as dSuppliers, POST as dSuppliersPost } from '../app/api/dispensary/suppliers/route';
import { GET as dSupplier, PATCH as dSupplierPatch } from '../app/api/dispensary/suppliers/[id]/route';
import { GET as deskItems } from '../app/api/integrations/desk/items/route';
import { POST as deskSales } from '../app/api/integrations/desk/sales/route';
import { POST as deskReturns } from '../app/api/integrations/desk/returns/route';
import { GET as dDeskSales } from '../app/api/dispensary/desk-sales/route';
import { POST as dDeskResolve } from '../app/api/dispensary/desk-sales/[id]/resolve/route';

test("DX-01: A-01 gives another organisation's display name for its public link, never an id", async () => {
  const B = await createOrg('dxb');
  const r = await call(contextRoute, { path: `/api/auth/context?org=${B.slug}` });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { org: { slug: B.slug, displayName: 'Synthetic dxb' }, trustedDevice: false, device: null });
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
  const bRows = await inOrg(B.orgId, async (c) => Number((await c.query('SELECT count(*) AS n FROM sign_in_throttle')).rows[0].n));
  assert.equal(bRows, 0, "no sign_in_throttle row of B's is created or changed");
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
  assert.deepEqual(who.body.org, { id: A.orgId, slug: A.slug, displayName: 'Synthetic dxa4' }, 'only the caller\'s organisation');
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
  '/api/auth/activity': { POST: activityRoute },
  '/api/auth/lock': { POST: lockRoute },
  '/api/auth/device/people': { GET: peopleRoute },
  '/api/auth/device/switch': { POST: switchRoute },
  '/api/auth/reauth': { POST: reauthRoute },
  '/api/account/switch-pin': { PUT: switchPinRoute },
  '/api/account/signing-pin': { PUT: signingPinRoute },
  '/api/devices': { GET: devicesGet, POST: devicesPost },
  '/api/devices/[id]/revoke': { POST: deviceRevokeRoute },
  '/api/org/settings': { GET: settingsGet, PUT: settingsPut },
  '/api/premises': { GET: premisesGet, POST: premisesPost },
  '/api/premises/[id]': { PATCH: premisesPatch },
  '/api/staff': { GET: staffList, POST: staffPost },
  '/api/staff/[id]': { GET: staffGet, PATCH: staffPatch },
  '/api/staff/[id]/reset': { POST: staffReset },
  '/api/staff/[id]/sessions/revoke': { POST: staffRevoke },
  '/api/roles': { GET: rolesGet, POST: rolesPost },
  '/api/roles/[key]': { PATCH: rolePatch },
  '/api/audit': { GET: auditGet },
  '/api/dispensary/settings': { GET: dSettingsGet, PUT: dSettingsPut },
  '/api/dispensary/setup': { POST: dSetup },
  '/api/dispensary/premises': { GET: dPremises },
  '/api/dispensary/premises/[id]/setup': { POST: dPremisesSetup },
  '/api/dispensary/premises/[id]/settings': { PUT: dPremisesSettings },
  '/api/dispensary/locations/[id]': { PATCH: dLocation },
  '/api/dispensary/master': { GET: dMaster },
  '/api/dispensary/master/[id]': { GET: dMasterOne },
  '/api/dispensary/items': { GET: dItems, POST: dItemsPost },
  '/api/dispensary/items/[id]': { GET: dItem, PATCH: dItemPatch, DELETE: dItemDelete },
  '/api/dispensary/items/[id]/movements': { GET: dMovements },
  '/api/dispensary/items/[id]/units': { POST: dUnitPost },
  '/api/dispensary/items/[id]/units/[unitId]': { PATCH: dUnitPatch },
  '/api/dispensary/goods-receipts': { GET: dGrns, POST: dGrnPost },
  '/api/dispensary/goods-receipts/read-bill': { POST: dReadBill },
  '/api/dispensary/goods-receipts/[id]': { GET: dGrn, PATCH: dGrnPatch },
  '/api/dispensary/goods-receipts/[id]/post': { POST: dGrnPostIt },
  '/api/dispensary/goods-receipts/[id]/discard': { POST: dGrnDiscard },
  '/api/dispensary/adjustments': { GET: dAdjs, POST: dAdjPost },
  '/api/dispensary/adjustments/[id]': { GET: dAdj },
  '/api/dispensary/adjustments/batch-details': { POST: dBatchDetails },
  '/api/dispensary/adjustments/write-off': { POST: dWriteOff },
  '/api/dispensary/items/[id]/batch-hint': { GET: dBatchHint },
  '/api/dispensary/reports/stock-statement': { GET: dStatement },
  '/api/dispensary/suppliers': { GET: dSuppliers, POST: dSuppliersPost },
  '/api/dispensary/suppliers/[id]': { GET: dSupplier, PATCH: dSupplierPatch },
  '/api/integrations/desk/items': { GET: deskItems },
  '/api/integrations/desk/sales': { POST: deskSales },
  '/api/integrations/desk/returns': { POST: deskReturns },
  '/api/dispensary/desk-sales': { GET: dDeskSales },
  '/api/dispensary/desk-sales/[id]/resolve': { POST: dDeskResolve },
};
const NONEXIST = '00000000-0000-4000-8000-000000000000';
const paramsFor = (path: string): Record<string, string> | undefined => {
  const names = [...path.matchAll(/\[([a-zA-Z]+)\]/g)].map((m) => m[1]);
  return names.length ? Object.fromEntries(names.map((n) => [n, n === 'key' ? 'no_such_role' : NONEXIST])) : undefined;
};

test('DX-04: every self-only endpoint refuses a body field naming another user or session', async () => {
  const A = await createOrg('dx4b');
  const a = await createStaff(A);
  for (const [path, method, handler] of [
    ['/api/auth/sign-out', 'POST', signOutRoute], ['/api/auth/activity', 'POST', activityRoute], ['/api/auth/lock', 'POST', lockRoute],
    ['/api/account/password', 'PUT', passwordRoute], ['/api/account/switch-pin', 'PUT', switchPinRoute],
    ['/api/account/signing-pin', 'PUT', signingPinRoute], ['/api/account/sessions/revoke', 'POST', revokeAllRoute],
    ['/api/auth/reauth', 'POST', reauthRoute],
  ] as const) {
    const cookie = await signIn(A.slug, a.login, a.password);
    const r = await call(handler, { cookie, method, path, body: { staffUserId: a.id } });
    assert.deepEqual([r.status, r.body.code], [422, 'UNKNOWN_FIELD'], `${method} ${path}`);
  }
});

test('DX-77: every route is driven against its access rule, as owner, doctor, reception, store and a role with no grants', async () => {
  const A = await createOrg('dx77');
  await inOrg(A.orgId, async (c) => {
    await c.query("INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'store', 'Store'), ($1, 'nothing', 'No grants')", [A.orgId]);
    await c.query(`INSERT INTO role_grants (org_id, role_key, permission, allowed) VALUES
                   ($1, 'store', 'stock.view', true), ($1, 'store', 'stock.receive', true), ($1, 'store', 'stock.reports', true)`, [A.orgId]);
  });
  const roles = ['owner', 'doctor', 'reception', 'store', 'nothing'];
  const staff = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await createStaff(A, { role: r, signingPin: r === 'store' || r === 'nothing' ? null : undefined })])));
  const as = async (role: string) => signIn(A.slug, staff[role].login, staff[role].password);
  for (const r of ROUTES) {
    for (const m of r.methods) {
      const h = HANDLERS[r.path]?.[m];
      assert.ok(h, `test/auth-isolation.test.ts has no handler for ${m} ${r.path}`);
      const body = m === 'GET' ? undefined : {};
      const params = paramsFor(r.path);
      const anon = await call(h, { method: m, path: r.path, body, params });
      if (r.access === 'public') {
        assert.notEqual(anon.status, 401, `${m} ${r.path} is public`);
      } else if (r.access === 'device') {
        assert.deepEqual([anon.status, anon.body.code], [401, 'device_required'], `${m} ${r.path} needs a trusted-device cookie`);
      } else if (r.access === 'desk') {
        // D-57: off by default (no DESK_SYNC_* here), so it is not there at all, even to a signed-in owner.
        assert.deepEqual([anon.status, anon.body.code], [404, 'not_found'], `${m} ${r.path} is off`);
        const owner = await call(h, { method: m, path: r.path, cookie: await as('owner'), body, params });
        assert.deepEqual([owner.status, owner.body.code], [404, 'not_found'], `${m} ${r.path} takes no session`);
      } else if (r.access === 'self') {
        assert.deepEqual([anon.status, anon.body.code], [401, 'unauthenticated'], `${m} ${r.path} needs a session`);
        const signed = await call(h, { method: m, path: r.path, cookie: await as('reception'), body, params });
        // A-09 locks a trusted PC; in an untrusted browser it answers device_required.
        assert.ok(signed.status !== 401 || signed.body.code === 'device_required', `${m} ${r.path} accepts a session (${signed.status} ${signed.body.code})`);
        assert.notEqual(signed.status, 403, `${m} ${r.path} is self-only, never forbidden`);
      } else {
        assert.deepEqual([anon.status, anon.body.code], [401, 'unauthenticated'], `${m} ${r.path} needs a session`);
        for (const role of roles) {
          const res = await call(h, { method: m, path: r.path, cookie: await as(role), body, params });
          const allowed = effectivePermissions(role, ['owner', 'doctor', 'reception'].includes(role),
            role === 'store' ? ['stock.view', 'stock.receive', 'stock.reports'].map((p) => ({ permission: p, allowed: true })) : []).has(r.access.permission);
          if (allowed) assert.ok(res.status !== 401 && res.status !== 403, `${role} may ${m} ${r.path} (${res.status} ${res.body.code})`);
          else assert.deepEqual([res.status, res.body.code], [403, 'forbidden'], `${role} may not ${m} ${r.path}`);
        }
      }
    }
  }
});

test('DK-07: every write route needs an Idempotency-Key, except the documented exemptions (06a §12.2)', async () => {
  const A = await createOrg('dk7');
  const owner = await createStaff(A, { role: 'owner' });
  // 06a §12.2's documented exemptions: auth, account, and the read-only POSTs that exist so far.
  // D-57: the desk's signed routes key each line instead (and are off here: 404).
  const exempt = (p: string) => /^\/api\/(auth|account|integrations\/desk)\//.test(p) || p === '/api/dispensary/goods-receipts/read-bill';
  let checked = 0;
  for (const r of ROUTES) {
    for (const m of r.methods.filter((x) => x !== 'GET')) {
      // A fresh session each time: A-16 and sign-out end the caller's sessions.
      const cookie = await signIn(A.slug, owner.login, owner.password);
      const res = await call(HANDLERS[r.path][m], { method: m, path: r.path, cookie, body: {}, params: paramsFor(r.path), noIdempotencyKey: true });
      if (exempt(r.path)) {
        assert.notEqual(res.body.code, 'IDEMPOTENCY_KEY_REQUIRED', `${m} ${r.path} is exempt`);
      } else {
        assert.deepEqual([res.status, res.body.code], [400, 'IDEMPOTENCY_KEY_REQUIRED'], `${m} ${r.path}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 22, `only ${checked} write routes were checked`);
});
