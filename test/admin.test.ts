// PR 4, administration (M-01 … M-09, M-12): 06b DX-09 … DX-17, DX-19; DN-10, DN-17, DN-18;
// DI-02 (the administration half), DI-12 (the grant mechanism; its E-28 half comes with PR 9),
// DI-21; DPN-08 (staff.manage, roles.manage, org.settings); DPN-14 (the role-change half);
// DAU-04 (the administration events); DAU-06.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrg, createStaff, inOrg, type OrgFixture, type StaffFixture } from './harness/fixtures';
import { Browser } from './harness/http';
import { setLogSink } from '../lib/log';
import { GET as meRoute } from '../app/api/auth/me/route';
import { POST as reauthRoute } from '../app/api/auth/reauth/route';
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
import { POST as signInRoute } from '../app/api/auth/sign-in/route';

const NONEXIST = '00000000-0000-4000-8000-000000000000';

interface World { org: OrgFixture; aa: StaffFixture; af: StaffFixture; a1: StaffFixture; owner: Browser }
async function world(label: string): Promise<World> {
  const org = await createOrg(label);
  const [aa, af, a1] = await Promise.all([
    createStaff(org, { role: 'owner', name: `Owner ${label}` }),
    createStaff(org, { role: 'reception', name: `Af ${label}` }),
    createStaff(org, { role: 'doctor', name: `A1 ${label}` }),
  ]);
  const owner = new Browser();
  assert.equal((await owner.signIn(org.slug, aa.login, aa.password)).status, 200);
  return { org, aa, af, a1, owner };
}
async function grant(b: Browser, person: StaffFixture, purpose: string, entityId: string): Promise<string> {
  const r = await b.call(reauthRoute, { body: { pin: person.signingPin, purpose, entityId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.grantId;
}
const signedIn = async (org: OrgFixture, p: StaffFixture) => { const b = new Browser(); await b.signIn(org.slug, p.login, p.password); return b; };
const auditCount = (orgId: string, action: string) => inOrg(orgId, async (c) => Number((await c.query('SELECT count(*) AS n FROM audit_log WHERE action = $1', [action])).rows[0].n));

test('M-01 / DW-10: settings need If-Match and an org.settings grant; ranges are enforced; each change is snapshotted and audited', async () => {
  const { org, aa, owner } = await world('m01');
  const g = await owner.call(settingsGet);
  assert.deepEqual([g.status, g.headers.get('etag'), g.body.deviceLockMinutes, g.body.dayResetTimeIst, g.body.untrustedIdleMinutes], [200, '"1"', 3, '04:00', null]);
  const body = { deviceLockMinutes: 5, dayResetTimeIst: '03:30', untrustedIdleMinutes: 60 };
  assert.equal((await owner.call(settingsPut, { method: 'PUT', body, headers: { 'if-match': '"1"' } })).body.code, 'reauth_required');
  assert.equal((await owner.call(settingsPut, { method: 'PUT', body, headers: { 'reauth-grant': await grant(owner, aa, 'org.settings', org.orgId) } })).status, 428);
  for (const bad of [{ deviceLockMinutes: 0 }, { deviceLockMinutes: 11 }, { untrustedIdleMinutes: 4 }, { dayResetTimeIst: '25:00' }]) {
    const r = await owner.call(settingsPut, { method: 'PUT', body: { ...body, ...bad }, headers: { 'if-match': '"1"' } });
    assert.deepEqual([r.status, r.body.code], [422, 'FIELD_INVALID'], JSON.stringify(bad));
  }
  const ok = await owner.call(settingsPut, { method: 'PUT', body, headers: { 'if-match': '"1"', 'reauth-grant': await grant(owner, aa, 'org.settings', org.orgId) } });
  assert.deepEqual([ok.status, ok.body.version, ok.body.deviceLockMinutes, ok.headers.get('etag')], [200, 2, 5, '"2"']);
  const stale = await owner.call(settingsPut, { method: 'PUT', body: { ...body, deviceLockMinutes: 4 }, headers: { 'if-match': '"1"', 'reauth-grant': await grant(owner, aa, 'org.settings', org.orgId) } });
  assert.deepEqual([stale.status, stale.body.code], [412, 'VERSION_CONFLICT']);
  const facts = await inOrg(org.orgId, async (c) => ({
    history: Number((await c.query('SELECT count(*) AS n FROM org_settings_history')).rows[0].n),
    audit: (await c.query("SELECT detail FROM audit_log WHERE action = 'org.settings_changed'")).rows.map((r) => r.detail),
  }));
  assert.equal(facts.history, 2);
  assert.deepEqual(facts.audit, [{ fields: ['device_lock_minutes', 'day_reset_time_ist', 'untrusted_idle_minutes'], version: 2 }]);
});

test('DX-09: an organisation reads and writes only its own settings', async () => {
  const A = await world('dx9a');
  const B = await world('dx9b');
  await A.owner.call(settingsPut, { method: 'PUT', body: { deviceLockMinutes: 7, dayResetTimeIst: '04:00', untrustedIdleMinutes: null },
    headers: { 'if-match': '"1"', 'reauth-grant': await grant(A.owner, A.aa, 'org.settings', A.org.orgId) } });
  const b = await B.owner.call(settingsGet);
  assert.deepEqual([b.body.version, b.body.deviceLockMinutes], [1, 3]);
});

test('M-02 / DX-10: the owner sees every premises of the organisation; a member sees only theirs', async () => {
  const A = await world('dx10a');
  const B = await world('dx10b');
  await inOrg(A.org.orgId, (c) => c.query("INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, 'Second', 'x', '27')", [A.org.orgId]));
  assert.deepEqual((await A.owner.call(premisesGet)).body.items.map((p: { name: string }) => p.name), ['Main', 'Second']);
  const af = await signedIn(A.org, A.af);
  assert.deepEqual((await af.call(premisesGet)).body.items.map((p: { id: string }) => p.id), [A.org.premisesId]);
  assert.ok(!(await A.owner.call(premisesGet)).body.items.some((p: { id: string }) => p.id === B.org.premisesId));
});

test('M-03 / DX-11: creating a premises needs a grant, checks the GSTIN against the state, refuses a duplicate name, and stays in its organisation', async () => {
  const A = await world('dx11a');
  const B = await world('dx11b');
  const body = { name: 'Second Branch', address: '2 Test Road, Maharashtra', stateCode: '27', gstin: '27AAAAA0000A1Z9' };
  assert.equal((await A.owner.call(premisesPost, { body })).body.code, 'reauth_required');
  const mismatch = await A.owner.call(premisesPost, { body: { ...body, gstin: '24AAAAA0000A1Z5' }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'org.settings', A.org.orgId) } });
  assert.deepEqual([mismatch.status, mismatch.body.code], [422, 'GSTIN_STATE_MISMATCH']);
  const r = await A.owner.call(premisesPost, { body, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'org.settings', A.org.orgId) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const dup = await A.owner.call(premisesPost, { body: { ...body, name: 'second branch' }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'org.settings', A.org.orgId) } });
  assert.deepEqual([dup.status, dup.body.code], [409, 'PREMISES_NAME_TAKEN']);
  const orgOf = await inOrg(A.org.orgId, async (c) => (await c.query('SELECT org_id FROM premises WHERE id = $1', [r.body.id])).rows[0].org_id);
  assert.equal(orgOf, A.org.orgId);
  assert.ok(!(await B.owner.call(premisesGet)).body.items.some((p: { id: string }) => p.id === r.body.id));
  assert.equal(await auditCount(A.org.orgId, 'premises.created'), 1);
});

test('M-04 / DX-12: editing another organisation\'s premises is 404 like a random id, and changes nothing', async () => {
  const A = await world('dx12a');
  const B = await world('dx12b');
  const g = await grant(A.owner, A.aa, 'org.settings', A.org.orgId);
  const cross = await A.owner.call(premisesPatch, { method: 'PATCH', body: { name: 'Taken over' }, params: { id: B.org.premisesId }, headers: { 'reauth-grant': g } });
  const rand = await A.owner.call(premisesPatch, { method: 'PATCH', body: { name: 'Taken over' }, params: { id: NONEXIST }, headers: { 'reauth-grant': g } });
  assert.deepEqual([cross.status, cross.body.code, cross.body.error], [rand.status, rand.body.code, rand.body.error]);
  assert.equal(cross.body.code, 'PREMISES_NOT_FOUND');
  const name = await inOrg(B.org.orgId, async (c) => (await c.query('SELECT name FROM premises WHERE id = $1', [B.org.premisesId])).rows[0].name);
  assert.equal(name, 'Main');
  const own = await A.owner.call(premisesPatch, { method: 'PATCH', body: { name: 'Main Clinic' }, params: { id: A.org.premisesId }, headers: { 'reauth-grant': g } });
  assert.deepEqual([own.status, own.body.name], [200, 'Main Clinic'], 'the unused grant still works for A\'s own premises');
});

test('M-05 / DX-13 / DN-17 (one-time password): create returns the password once; it signs in only to change it; it is never logged or audited', async () => {
  const A = await world('m05a');
  const B = await world('m05b');
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  let otp = '';
  try {
    const list = await A.owner.call(staffList);
    assert.ok(!list.body.items.some((s: { id: string }) => s.id === B.aa.id), 'DX-13: the list excludes B');
    const crossBody = { name: 'Cross Person', login: 'crossperson', role: 'reception', premisesIds: [B.org.premisesId] };
    const cross = await A.owner.call(staffPost, { body: crossBody, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', A.org.orgId) } });
    assert.deepEqual([cross.status, cross.body.code], [404, 'PREMISES_NOT_FOUND']);
    const r = await A.owner.call(staffPost, { body: { ...crossBody, premisesIds: [A.org.premisesId] }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', A.org.orgId) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    otp = r.body.oneTimePassword;
    assert.match(otp, /^[A-Za-z2-9]{12}$/);
    assert.deepEqual([r.body.staff.login, r.body.staff.mustChangePassword, r.body.staff.premisesIds], ['crossperson', true, [A.org.premisesId]]);
    assert.equal((await A.owner.call(staffGet, { params: { id: r.body.staff.id } })).body.oneTimePassword, undefined, 'never shown again');
  } finally {
    restore();
  }
  const rows = await inOrg(A.org.orgId, async (c) => ({
    staff: Number((await c.query("SELECT count(*) AS n FROM staff_users WHERE login = 'crossperson'")).rows[0].n),
    audit: (await c.query('SELECT detail::text AS d FROM audit_log')).rows.map((x) => x.d).join(' '),
  }));
  assert.equal(rows.staff, 1, 'the cross-tenant create wrote nothing');
  assert.ok(!lines.join('\n').includes(otp) && !rows.audit.includes(otp));
  const first = await new Browser().signIn(A.org.slug, 'crossperson', otp);
  assert.deepEqual([first.status, first.body.next], [200, '/account/password']);
});

test('DX-14: reading or editing another organisation\'s person is 404 like a random id', async () => {
  const A = await world('dx14a');
  const B = await world('dx14b');
  for (const id of [B.aa.id, NONEXIST]) {
    assert.equal((await A.owner.call(staffGet, { params: { id } })).body.code, 'STAFF_NOT_FOUND');
    const p = await A.owner.call(staffPatch, { method: 'PATCH', body: { name: 'Renamed' }, params: { id }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', id) } });
    assert.deepEqual([p.status, p.body.code], [404, 'STAFF_NOT_FOUND']);
  }
  const name = await inOrg(B.org.orgId, async (c) => (await c.query('SELECT name FROM staff_users WHERE id = $1', [B.aa.id])).rows[0].name);
  assert.equal(name, B.aa.name);
});

test('DN-10: a role change ends the person\'s sessions (role_changed) and is audited from → to', async () => {
  const A = await world('dn10');
  const af = await signedIn(A.org, A.af);
  const r = await A.owner.call(staffPatch, { method: 'PATCH', body: { role: 'doctor' }, params: { id: A.af.id }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', A.af.id) } });
  assert.deepEqual([r.status, r.body.role], [200, 'doctor']);
  assert.equal((await af.call(meRoute)).body.code, 'session_revoked');
  const facts = await inOrg(A.org.orgId, async (c) => ({
    reason: (await c.query('SELECT revoked_reason AS r FROM sessions WHERE staff_user_id = $1', [A.af.id])).rows[0].r,
    audit: (await c.query("SELECT detail FROM audit_log WHERE action = 'staff.role_changed'")).rows[0].detail,
  }));
  assert.equal(facts.reason, 'role_changed');
  assert.deepEqual(facts.audit, { from: 'reception', to: 'doctor', count: 1 });
});

test('DN-17 / DX-15: a reset returns a password once, clears both PINs and the sign-in pause, ends every session; another organisation\'s person is 404', async () => {
  const A = await world('dn17');
  const B = await world('dn17b');
  const af = await signedIn(A.org, A.af);
  for (let i = 0; i < 5; i++) await new Browser().signIn(A.org.slug, A.af.login, 'wrong-password');
  assert.equal((await new Browser().signIn(A.org.slug, A.af.login, A.af.password)).status, 429, 'paused');
  const r = await A.owner.call(staffReset, { method: 'POST', body: {}, params: { id: A.af.id }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', A.af.id) } });
  assert.equal(r.status, 200);
  const facts = await inOrg(A.org.orgId, async (c) => (await c.query(
    'SELECT switch_pin_hash AS s, signing_pin_hash AS g, must_change_password AS m FROM staff_users WHERE id = $1', [A.af.id])).rows[0]);
  assert.deepEqual(facts, { s: null, g: null, m: true });
  assert.equal((await af.call(meRoute)).body.code, 'session_revoked');
  assert.equal(await auditCount(A.org.orgId, 'staff.password_reset'), 1);
  const again = await new Browser().signIn(A.org.slug, A.af.login, r.body.oneTimePassword);
  assert.deepEqual([again.status, again.body.next], [200, '/account/password'], 'the reset also lifted the pause');
  const before = await inOrg(B.org.orgId, async (c) => (await c.query('SELECT password_hash AS h FROM staff_users WHERE id = $1', [B.aa.id])).rows[0].h);
  const cross = await A.owner.call(staffReset, { method: 'POST', body: {}, params: { id: B.aa.id }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', B.aa.id) } });
  assert.deepEqual([cross.status, cross.body.code], [404, 'STAFF_NOT_FOUND']);
  const after = await inOrg(B.org.orgId, async (c) => (await c.query('SELECT password_hash AS h FROM staff_users WHERE id = $1', [B.aa.id])).rows[0].h);
  assert.equal(after, before);
});

test('DN-18: the only active owner can be neither deactivated nor demoted; with a second owner it works', async () => {
  const A = await world('dn18');
  for (const body of [{ active: false }, { role: 'doctor' }]) {
    const r = await A.owner.call(staffPatch, { method: 'PATCH', body, params: { id: A.aa.id }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', A.aa.id) } });
    assert.deepEqual([r.status, r.body.code], [409, 'last_owner'], JSON.stringify(body));
  }
  await A.owner.call(staffPatch, { method: 'PATCH', body: { role: 'owner' }, params: { id: A.a1.id }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', A.a1.id) } });
  const ok = await A.owner.call(staffPatch, { method: 'PATCH', body: { active: false }, params: { id: A.aa.id }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', A.aa.id) } });
  assert.equal(ok.status, 200);
  assert.equal((await A.owner.call(meRoute)).body.code, 'session_revoked', 'deactivating yourself ends your session too');
});

test('R7-1: only an owner can give or take the owner role', async () => {
  const A = await world('r71');
  await inOrg(A.org.orgId, async (c) => {
    await c.query("INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'manager', 'Manager')", [A.org.orgId]);
    await c.query("INSERT INTO role_grants (org_id, role_key, permission, allowed) VALUES ($1, 'manager', 'staff.manage', true), ($1, 'manager', 'stock.adjust', true)", [A.org.orgId]);
  });
  const mgr = await createStaff(A.org, { role: 'manager' });
  const mb = await signedIn(A.org, mgr);
  const promote = await mb.call(staffPatch, { method: 'PATCH', body: { role: 'owner' }, params: { id: A.af.id }, headers: { 'reauth-grant': await grant(mb, mgr, 'staff.manage', A.af.id) } });
  assert.deepEqual([promote.status, promote.body.code], [403, 'forbidden']);
  const ok = await mb.call(staffPatch, { method: 'PATCH', body: { role: 'doctor' }, params: { id: A.af.id }, headers: { 'reauth-grant': await grant(mb, mgr, 'staff.manage', A.af.id) } });
  assert.equal(ok.status, 200, 'other roles are fine');
});

test('DX-16 / M-08: ending another organisation\'s person\'s sessions is 404; for one\'s own staff it ends them all', async () => {
  const A = await world('dx16a');
  const B = await world('dx16b');
  const cross = await A.owner.call(staffRevoke, { method: 'POST', body: {}, params: { id: B.aa.id } });
  assert.deepEqual([cross.status, cross.body.code], [404, 'STAFF_NOT_FOUND']);
  assert.equal((await B.owner.call(meRoute)).status, 200, 'BA is still signed in');
  const af = await signedIn(A.org, A.af);
  const r = await A.owner.call(staffRevoke, { method: 'POST', body: {}, params: { id: A.af.id } });
  assert.deepEqual([r.status, r.body.ended], [200, 1]);
  assert.equal((await af.call(meRoute)).body.code, 'session_revoked');
});

test('DX-17 / DI-21: roles list only this organisation\'s; a role that exists only elsewhere is 404; the owner keeps its locked grants', async () => {
  const A = await world('dx17a');
  const B = await world('dx17b');
  await inOrg(B.org.orgId, (c) => c.query("INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'bonly', 'B only')", [B.org.orgId]));
  assert.deepEqual((await A.owner.call(rolesGet)).body.items.map((r: { key: string }) => r.key).sort(), ['doctor', 'owner', 'reception']);
  const g = await grant(A.owner, A.aa, 'roles.manage', A.org.orgId);
  const cross = await A.owner.call(rolePatch, { method: 'PATCH', body: { grants: { 'stock.view': true } }, params: { key: 'bonly' }, headers: { 'reauth-grant': g } });
  assert.deepEqual([cross.status, cross.body.code], [404, 'ROLE_NOT_FOUND']);
  const bGrants = await inOrg(B.org.orgId, async (c) => Number((await c.query('SELECT count(*) AS n FROM role_grants')).rows[0].n));
  assert.equal(bGrants, 0);
  for (const p of ['org.settings', 'staff.manage', 'roles.manage']) {
    const r = await A.owner.call(rolePatch, { method: 'PATCH', body: { grants: { [p]: false } }, params: { key: 'owner' }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'roles.manage', A.org.orgId) } });
    assert.deepEqual([r.status, r.body.code], [422, 'OWNER_GRANT_LOCKED'], p);
  }
});

test('DI-12 (grant mechanism): an override takes effect on the next request, is audited from → to, and can be restored; another organisation is unaffected', async () => {
  const A = await world('di12a');
  const B = await world('di12b');
  const af = await signedIn(A.org, A.af);
  const bf = await signedIn(B.org, B.af);
  assert.ok((await af.call(meRoute)).body.permissions.includes('stock.dispense'));
  const set = async (allowed: boolean) => A.owner.call(rolePatch, { method: 'PATCH', body: { grants: { 'stock.dispense': allowed } }, params: { key: 'reception' },
    headers: { 'reauth-grant': await grant(A.owner, A.aa, 'roles.manage', A.org.orgId) } });
  assert.equal((await set(false)).status, 200);
  assert.ok(!(await af.call(meRoute)).body.permissions.includes('stock.dispense'), 'on the next request, no session ended');
  assert.ok((await bf.call(meRoute)).body.permissions.includes('stock.dispense'), "B's reception is unaffected");
  const audit = await inOrg(A.org.orgId, async (c) => (await c.query("SELECT detail FROM audit_log WHERE action = 'role.grant_changed'")).rows.map((r) => r.detail));
  assert.deepEqual(audit, [{ role: 'reception', permission: 'stock.dispense', from: true, to: false }]);
  await set(true);
  assert.ok((await af.call(meRoute)).body.permissions.includes('stock.dispense'));
});

test('DPN-14 (role-change half): losing the last PIN-gated permission clears the signing PIN in the same transaction, audited', async () => {
  const A = await world('dpn14b');
  const hash = () => inOrg(A.org.orgId, async (c) => (await c.query('SELECT signing_pin_hash AS h FROM staff_users WHERE id = $1', [A.af.id])).rows[0].h);
  assert.ok(await hash(), 'AF has a signing PIN (reception holds stock.backdate)');
  const r = await A.owner.call(rolePatch, { method: 'PATCH', body: { grants: { 'stock.backdate': false } }, params: { key: 'reception' },
    headers: { 'reauth-grant': await grant(A.owner, A.aa, 'roles.manage', A.org.orgId) } });
  assert.equal(r.status, 200);
  assert.equal(await hash(), null);
  assert.equal(await auditCount(A.org.orgId, 'staff.signing_pin_cleared'), 1);
  // The same through M-06: a doctor moved to a stock-only role.
  await A.owner.call(rolesPost, { body: { key: 'store', name: 'Store', grants: { 'stock.view': true, 'stock.receive': true } },
    headers: { 'reauth-grant': await grant(A.owner, A.aa, 'roles.manage', A.org.orgId) } });
  await A.owner.call(staffPatch, { method: 'PATCH', body: { role: 'store' }, params: { id: A.a1.id }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'staff.manage', A.a1.id) } });
  const a1 = await inOrg(A.org.orgId, async (c) => (await c.query('SELECT signing_pin_hash AS h FROM staff_users WHERE id = $1', [A.a1.id])).rows[0].h);
  assert.equal(a1, null);
});

test('M-09: custom roles: unknown permissions and taken keys are refused; grants are rows', async () => {
  const A = await world('m09');
  const g = () => grant(A.owner, A.aa, 'roles.manage', A.org.orgId);
  const unknown = await A.owner.call(rolesPost, { body: { key: 'clerk', name: 'Clerk', grants: { 'stock.launch_rockets': true } }, headers: { 'reauth-grant': await g() } });
  assert.deepEqual([unknown.status, unknown.body.code], [422, 'UNKNOWN_PERMISSION']);
  const taken = await A.owner.call(rolesPost, { body: { key: 'doctor', name: 'Doc', grants: {} }, headers: { 'reauth-grant': await g() } });
  assert.deepEqual([taken.status, taken.body.code], [409, 'ROLE_KEY_TAKEN']);
  const ok = await A.owner.call(rolesPost, { body: { key: 'clerk', name: 'Clerk', grants: { 'stock.view': true, 'stock.reports': true } }, headers: { 'reauth-grant': await g() } });
  assert.deepEqual([ok.status, ok.body.permissions], [201, ['stock.reports', 'stock.view']]);
  const rename = await A.owner.call(rolePatch, { method: 'PATCH', body: { name: 'Front' }, params: { key: 'reception' }, headers: { 'reauth-grant': await g() } });
  assert.deepEqual([rename.status, rename.body.code], [422, 'BUILTIN_ROLE']);
});

test('DPN-08 (staff.manage, roles.manage, org.settings): no grant, or one for another entity, is 401; a matching one works', async () => {
  const A = await world('dpn8b');
  const calls = [
    { purpose: 'staff.manage', entity: A.af.id, run: (h: Record<string, string>) => A.owner.call(staffPatch, { method: 'PATCH', body: { name: 'Renamed Af' }, params: { id: A.af.id }, headers: h }) },
    { purpose: 'roles.manage', entity: A.org.orgId, run: (h: Record<string, string>) => A.owner.call(rolePatch, { method: 'PATCH', body: { grants: { 'stock.reports': true } }, params: { key: 'reception' }, headers: h }) },
    { purpose: 'org.settings', entity: A.org.orgId, run: (h: Record<string, string>) => A.owner.call(premisesPatch, { method: 'PATCH', body: { address: '9 New Road' }, params: { id: A.org.premisesId }, headers: h }) },
  ];
  for (const c of calls) {
    assert.equal((await c.run({})).body.code, 'reauth_required', `${c.purpose}: no grant`);
    assert.equal((await c.run({ 'reauth-grant': await grant(A.owner, A.aa, c.purpose, NONEXIST) })).body.code, 'reauth_required', `${c.purpose}: another entity`);
    assert.equal((await c.run({ 'reauth-grant': await grant(A.owner, A.aa, c.purpose, c.entity) })).status, 200, `${c.purpose}: matching`);
  }
});

test('DI-02 (administration): reception cannot manage staff or read the audit log', async () => {
  const A = await world('di2');
  const af = await signedIn(A.org, A.af);
  for (const [h, opts] of [[staffList, {}], [auditGet, {}], [rolesGet, {}], [settingsGet, {}]] as const) {
    assert.deepEqual([(await af.call(h, opts)).status, (await af.call(h, opts)).body.code], [403, 'forbidden']);
  }
});

test('DAU-04 (administration) / DAU-06 / DX-19: one audit row per event; M-12 shows only this organisation, newest first, in pages', async () => {
  const A = await world('dau6a');
  const B = await world('dau6b');
  const g = (p: string, e: string) => grant(A.owner, A.aa, p, e);
  const created = await A.owner.call(staffPost, { body: { name: 'New Person', login: 'newperson', role: 'reception', premisesIds: [A.org.premisesId] }, headers: { 'reauth-grant': await g('staff.manage', A.org.orgId) } });
  const id = created.body.staff.id;
  await A.owner.call(staffPatch, { method: 'PATCH', body: { role: 'doctor' }, params: { id }, headers: { 'reauth-grant': await g('staff.manage', id) } });
  await A.owner.call(staffReset, { method: 'POST', body: {}, params: { id }, headers: { 'reauth-grant': await g('staff.manage', id) } });
  await A.owner.call(staffPatch, { method: 'PATCH', body: { active: false }, params: { id }, headers: { 'reauth-grant': await g('staff.manage', id) } });
  await A.owner.call(rolePatch, { method: 'PATCH', body: { grants: { 'stock.reports': true } }, params: { key: 'reception' }, headers: { 'reauth-grant': await g('roles.manage', A.org.orgId) } });
  await A.owner.call(settingsPut, { method: 'PUT', body: { deviceLockMinutes: 4, dayResetTimeIst: '04:00', untrustedIdleMinutes: null }, headers: { 'if-match': '"1"', 'reauth-grant': await g('org.settings', A.org.orgId) } });
  for (const a of ['staff.created', 'staff.role_changed', 'staff.password_reset', 'staff.deactivated', 'role.grant_changed', 'org.settings_changed']) {
    assert.equal(await auditCount(A.org.orgId, a), 1, a);
  }
  const all = (await A.owner.call(auditGet, { path: '/api/audit?limit=200' })).body.items;
  const times = all.map((r: { at: string }) => r.at);
  assert.deepEqual(times, [...times].sort().reverse(), 'newest first');
  assert.equal(all.length, 7, "the owner's sign-in and the six events");
  const p1 = await A.owner.call(auditGet, { path: '/api/audit?limit=3' });
  const p2 = await A.owner.call(auditGet, { path: `/api/audit?limit=3&cursor=${p1.body.nextCursor}` });
  assert.deepEqual([...p1.body.items, ...p2.body.items].map((r: { id: string }) => r.id), all.slice(0, 6).map((r: { id: string }) => r.id), 'pages join without gaps or repeats');
  const bIds = new Set((await B.owner.call(auditGet, { path: '/api/audit?limit=200' })).body.items.map((r: { id: string }) => r.id));
  assert.ok(all.every((r: { id: string }) => !bIds.has(r.id)), "A's rows only");
  assert.deepEqual((await A.owner.call(auditGet, { path: `/api/audit?staffId=${B.aa.id}` })).body.items, [], 'DX-19: ?staffId=BA is empty');
  const text = JSON.stringify(all.map((r: { detail: unknown }) => r.detail));
  assert.ok(!/98000|\+91|New Person|newperson/.test(text), 'no names, logins or phone numbers in any detail');
});

test('strictBody: integers, nulls, UUID lists and permission maps are checked; errors name the field, never the value', async () => {
  const A = await world('sb');
  const g = await grant(A.owner, A.aa, 'staff.manage', A.org.orgId);
  for (const [body, field] of [
    [{ name: 'X Y', login: 'xy-person', role: 'reception', premisesIds: ['not-a-uuid'] }, 'premisesIds'],
    [{ name: 'X Y', login: 'xy-person', role: 'reception', premisesIds: 'nope' }, 'premisesIds'],
    [{ name: 'X Y', login: 'xy-person', role: 'reception', premisesIds: [], prescriberId: 42 }, 'prescriberId'],
  ] as const) {
    const r = await A.owner.call(staffPost, { body, headers: { 'reauth-grant': g } });
    assert.deepEqual([r.status, r.body.code, r.body.details.field], [422, 'FIELD_INVALID', field]);
    assert.ok(!JSON.stringify(r.body).includes('not-a-uuid'));
  }
  const flags = await A.owner.call(rolesPost, { body: { key: 'k1', name: 'K', grants: { 'stock.view': 'yes' } }, headers: { 'reauth-grant': await grant(A.owner, A.aa, 'roles.manage', A.org.orgId) } });
  assert.deepEqual([flags.status, flags.body.details.field], [422, 'grants']);
  void signInRoute;
});
