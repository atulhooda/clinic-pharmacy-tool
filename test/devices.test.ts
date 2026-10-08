// 06b §8 (DW): trusted PCs, "Who's working?", switching and the idle lock; the device rows of
// §5 (DX-01's device half, DX-05, DX-06, DX-08's device half, DX-18); DN-05; and the DC-11
// mechanism (no write straddles a switch). Not here yet: DW-04 (a dispense's actor, PR 9) and
// DW-09's ledger snapshot (PR 7) — DW-09 is checked with a write that exists now.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createOrg, createStaff, inOrg, type OrgFixture, type StaffFixture } from './harness/fixtures';
import { as } from './harness/env';
import { Browser, call, signIn } from './harness/http';
import { setClockForTests } from '../lib/clock';
import { pinCounters } from '../lib/auth/pins';
import { GET as contextRoute } from '../app/api/auth/context/route';
import { GET as meRoute } from '../app/api/auth/me/route';
import { POST as signOutRoute } from '../app/api/auth/sign-out/route';
import { POST as activityRoute } from '../app/api/auth/activity/route';
import { POST as lockRoute } from '../app/api/auth/lock/route';
import { GET as peopleRoute } from '../app/api/auth/device/people/route';
import { POST as switchRoute } from '../app/api/auth/device/switch/route';
import { POST as reauthRoute } from '../app/api/auth/reauth/route';
import { PUT as switchPinRoute } from '../app/api/account/switch-pin/route';
import { GET as devicesGet, POST as devicesPost } from '../app/api/devices/route';
import { POST as deviceRevokeRoute } from '../app/api/devices/[id]/revoke/route';

afterEach(() => setClockForTests(null));
const IST = (iso: string) => new Date(`${iso}+05:30`);
const NONEXIST = '00000000-0000-4000-8000-000000000000';
const min = (n: number) => n * 60_000;

/** The owner trusts a fresh browser through the real flow: sign in, a devices.register grant, M-10. */
async function trustedPc(org: OrgFixture, owner: StaffFixture, name = 'Front Desk', premisesId = org.premisesId): Promise<Browser> {
  const b = new Browser();
  assert.equal((await b.signIn(org.slug, owner.login, owner.password)).status, 200);
  const g = await b.call(reauthRoute, { body: { pin: owner.signingPin, purpose: 'devices.register', entityId: org.orgId } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const r = await b.call(devicesPost, { body: { name, premisesId }, headers: { 'reauth-grant': g.body.grantId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return b;
}
const me = (b: Browser) => b.call(meRoute, { path: '/api/auth/me' });
const people = (b: Browser) => b.call(peopleRoute, { path: '/api/auth/device/people' });
const lock = (b: Browser) => b.call(lockRoute, { method: 'POST', body: {} });
async function sessionIdOf(b: Browser): Promise<string> {
  return JSON.parse(Buffer.from(b.jar.get('pharm_session')!.split('.')[1], 'base64url').toString()).sid;
}
async function switchTo(b: Browser, person: StaffFixture, pin = person.switchPin!) {
  const list = await people(b);
  const p = list.body.people.find((x: { name: string }) => x.name === person.name);
  assert.ok(p, `${person.name} is on the lock screen`);
  return b.call(switchRoute, { body: { sessionId: p.sessionId, pin } });
}
async function world(label: string) {
  const org = await createOrg(label);
  const [owner, af, a1] = await Promise.all([
    createStaff(org, { role: 'owner', name: `Owner ${label}` }),
    createStaff(org, { role: 'reception', name: `Af ${label}`, switchPin: '135790', signingPin: '246802' }),
    createStaff(org, { role: 'doctor', name: `A1 ${label}`, switchPin: '975318', signingPin: '864208' }),
  ]);
  return { org, owner, af, a1 };
}

test('DW-01: trusting a PC needs a devices.register grant; it sets a signed httpOnly device cookie and is audited', async () => {
  const { org, owner } = await world('dw1');
  const b = new Browser();
  await b.signIn(org.slug, owner.login, owner.password);
  const without = await b.call(devicesPost, { body: { name: 'Desk', premisesId: org.premisesId } });
  assert.deepEqual([without.status, without.body.code], [401, 'reauth_required']);
  const g = await b.call(reauthRoute, { body: { pin: owner.signingPin, purpose: 'devices.register', entityId: org.orgId } });
  const r = await b.call(devicesPost, { body: { name: 'Desk', premisesId: org.premisesId }, headers: { 'reauth-grant': g.body.grantId } });
  assert.equal(r.status, 201);
  const cookie = r.setCookies.find((c) => c.startsWith('pharm_device='))!;
  assert.match(cookie, /; HttpOnly; SameSite=Lax; Max-Age=34560000/);
  const facts = await inOrg(org.orgId, async (c) => ({
    devices: Number((await c.query('SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL')).rows[0].n),
    audit: (await c.query("SELECT detail->>'device_id' AS d FROM audit_log WHERE action = 'auth.device_registered'")).rows,
  }));
  assert.equal(facts.devices, 1);
  assert.equal(facts.audit.length, 1);
  // The owner's own session is now bound to the PC and is its active one.
  const who = await me(b);
  assert.deepEqual([who.status, who.body.device?.name], [200, 'Desk']);
  assert.equal(facts.audit[0].d, who.body.device.id);
});

test('DW-02: two people sign in on one PC: both sessions live, the second becomes active, A-10 lists both (name and role only)', async () => {
  const { org, owner, af, a1 } = await world('dw2');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  const afTab = pc.clone();
  const r = await pc.signIn(org.slug, a1.login, a1.password);
  assert.deepEqual([r.status, r.body.trustedDevice], [200, true]);
  assert.equal((await me(pc)).body.name, a1.name);
  assert.deepEqual([(await me(afTab)).status, (await me(afTab)).body.code], [401, 'device_locked'], "AF's session is live but not active");
  const list = await people(pc);
  assert.deepEqual(list.body.people.map((p: { name: string }) => p.name).sort(), [af.name, a1.name, owner.name].sort());
  for (const p of list.body.people) assert.deepEqual(Object.keys(p).sort(), ['name', 'role', 'sessionId']);
});

test('DW-03 / DW-19: "Switch person" locks at once; picking a name and the right switch PIN makes that session active, audited', async () => {
  const { org, owner, af, a1 } = await world('dw3');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  const afSid = await sessionIdOf(pc);
  await pc.signIn(org.slug, a1.login, a1.password);
  const a1Sid = await sessionIdOf(pc);
  assert.equal((await lock(pc)).status, 200);
  assert.deepEqual([(await me(pc)).status, (await me(pc)).body.code], [401, 'device_locked'], 'DW-19: locked at once');
  const r = await switchTo(pc, af);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.setCookies.some((c) => c.startsWith('pharm_session=')), 'the session cookie is reissued');
  assert.equal((await me(pc)).body.name, af.name);
  const detail = await inOrg(org.orgId, async (c) => (await c.query("SELECT detail FROM audit_log WHERE action = 'auth.switched'")).rows);
  assert.equal(detail.length, 1);
  assert.equal(detail[0].detail.to_session_id, afSid);
  assert.equal(detail[0].detail.from_session_id, null, 'the PC was locked when AF switched in');
  // Switching again from AF to A1 records the from-session.
  await lock(pc);
  await switchTo(pc, a1);
  const second = await inOrg(org.orgId, async (c) => (await c.query("SELECT detail FROM audit_log WHERE action = 'auth.switched' ORDER BY at DESC, id LIMIT 1")).rows[0].detail);
  assert.equal(second.to_session_id, a1Sid);
});

test('DW-05 / DW-09: a tab still holding the previous person\'s cookie gets device_locked and writes nothing', async () => {
  const { org, owner, af, a1 } = await world('dw5');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, a1.login, a1.password);
  await pc.signIn(org.slug, af.login, af.password);
  const staleTab = pc.clone();
  await lock(pc);
  await switchTo(pc, a1);
  const hashBefore = await inOrg(org.orgId, async (c) => (await c.query('SELECT switch_pin_hash AS h FROM staff_users WHERE id = $1', [af.id])).rows[0].h);
  const write = await staleTab.call(switchPinRoute, { method: 'PUT', body: { pin: '192837' } });
  assert.deepEqual([write.status, write.body.code], [401, 'device_locked']);
  const hashAfter = await inOrg(org.orgId, async (c) => (await c.query('SELECT switch_pin_hash AS h FROM staff_users WHERE id = $1', [af.id])).rows[0].h);
  assert.equal(hashAfter, hashBefore);
});

test('DW-06 / DW-09: after 3 minutes without input both reads and writes get device_locked; no session ends', async () => {
  const { org, owner, af, a1 } = await world('dw6');
  setClockForTests(IST('2026-10-07T10:00:00'));
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  await pc.signIn(org.slug, a1.login, a1.password);
  setClockForTests(IST('2026-10-07T10:03:01'));
  const write = await pc.call(switchPinRoute, { method: 'PUT', body: { pin: '192837' } });
  assert.deepEqual([write.status, write.body.code], [401, 'device_locked'], 'DW-09: a write one second after the lock time');
  assert.deepEqual([(await me(pc)).status, (await me(pc)).body.code], [401, 'device_locked']);
  const state = await inOrg(org.orgId, async (c) => ({
    active: (await c.query('SELECT active_session_id AS a FROM device_state')).rows[0].a,
    live: Number((await c.query('SELECT count(*) AS n FROM sessions WHERE device_id IS NOT NULL AND revoked_at IS NULL')).rows[0].n),
  }));
  assert.deepEqual(state, { active: null, live: 3 });
  assert.equal((await people(pc)).body.people.length, 3);
});

test('DW-07: GET polls every 10 s are not input: the PC still locks at 3 minutes', async () => {
  const { org, owner, af } = await world('dw7');
  const start = IST('2026-10-07T11:00:00').getTime();
  setClockForTests(new Date(start));
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  for (let t = 10_000; t <= 170_000; t += 10_000) {
    setClockForTests(new Date(start + t));
    assert.equal((await me(pc)).status, 200, `poll at ${t / 1000}s`);
  }
  setClockForTests(new Date(start + min(3) + 1000));
  assert.equal((await me(pc)).body.code, 'device_locked');
});

test('DW-08: activity pings every 30 s keep the PC unlocked; it locks 3 minutes after the last', async () => {
  const { org, owner, af } = await world('dw8');
  const start = IST('2026-10-07T12:00:00').getTime();
  setClockForTests(new Date(start));
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  let t = 0;
  for (; t <= min(10); t += 30_000) {
    setClockForTests(new Date(start + t));
    const r = await pc.call(activityRoute, { method: 'POST', body: {} });
    assert.equal(r.status, 200, `ping at ${t / 1000}s`);
  }
  const lastPing = start + t - 30_000;
  setClockForTests(new Date(lastPing + min(3) - 1000));
  assert.equal((await me(pc)).status, 200);
  setClockForTests(new Date(lastPing + min(3) + 1000));
  assert.equal((await me(pc)).body.code, 'device_locked');
});

test('DW-10: the lock time is data: device_lock_minutes 5 locks at 5 minutes, not 3', async () => {
  const { org, owner, af } = await world('dw10');
  await inOrg(org.orgId, (c) => c.query('UPDATE org_settings SET device_lock_minutes = 5, version = version + 1'));
  const start = IST('2026-10-07T13:00:00').getTime();
  setClockForTests(new Date(start));
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  setClockForTests(new Date(start + min(4)));
  assert.equal((await me(pc)).status, 200);
  assert.equal((await me(pc)).body.lockAt, new Date(start + min(5)).toISOString());
  setClockForTests(new Date(start + min(5) + 1000));
  assert.equal((await me(pc)).body.code, 'device_locked');
});

test('DW-11: switch-PIN failures count per person across PCs; 5 block PIN switching everywhere until a full sign-in', async () => {
  const { org, owner, af, a1 } = await world('dw11');
  const pc1 = await trustedPc(org, owner, 'Desk 1');
  const pc2 = await trustedPc(org, owner, 'Desk 2');
  for (const pc of [pc1, pc2]) await pc.signIn(org.slug, af.login, af.password);
  await pc1.signIn(org.slug, a1.login, a1.password);
  for (const [pc, n] of [[pc1, 3], [pc2, 2]] as const) {
    await lock(pc);
    for (let i = 0; i < n; i++) await switchTo(pc, af, '000111');
  }
  for (const pc of [pc1, pc2]) {
    const r = await switchTo(pc, af);
    assert.deepEqual([r.status, r.body.code], [403, 'switch_pin_blocked'], 'blocked even with the right PIN');
  }
  assert.equal((await switchTo(pc1, a1)).status, 200, 'A1 is unaffected');
  const live = await inOrg(org.orgId, async (c) => Number((await c.query('SELECT count(*) AS n FROM sessions WHERE staff_user_id = $1 AND revoked_at IS NULL', [af.id])).rows[0].n));
  assert.equal(live, 2, "AF's sessions are not revoked");
  await pc2.signIn(org.slug, af.login, af.password);
  await lock(pc1);
  assert.equal((await switchTo(pc1, af)).status, 200, 'a full sign-in cleared the block');
});

test('DW-12: four wrong switch PINs, then one more 16 minutes after the first: not blocked', async () => {
  const { org, owner, af } = await world('dw12');
  const start = IST('2026-10-07T14:00:00').getTime();
  setClockForTests(new Date(start));
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  await lock(pc);
  for (let i = 0; i < 4; i++) assert.equal((await switchTo(pc, af, '000111')).body.code, 'wrong_secret');
  setClockForTests(new Date(start + min(16)));
  assert.equal((await switchTo(pc, af, '000111')).body.code, 'wrong_secret');
  // AF's session expired? No: same day. The right PIN still works.
  assert.equal((await switchTo(pc, af)).status, 200);
});

test('DW-13: thirty parallel wrong switch PINs check at most five', async () => {
  const { org, owner, af } = await world('dw13');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  await lock(pc);
  const sid = (await people(pc)).body.people.find((p: { name: string }) => p.name === af.name).sessionId;
  const before = pinCounters.checks;
  const results = await Promise.all(Array.from({ length: 30 }, () => pc.clone().call(switchRoute, { body: { sessionId: sid, pin: '000111' } })));
  assert.ok(results.every((r) => r.status === 401 || r.status === 403), results.map((r) => r.status).join());
  assert.ok(pinCounters.checks - before <= 5, `checked ${pinCounters.checks - before} PINs`);
});

test('DW-14: the lock screen and switch need a trusted-device cookie', async () => {
  const b = new Browser();
  assert.deepEqual([(await people(b)).status, (await people(b)).body.code], [401, 'device_required']);
  const r = await b.call(switchRoute, { body: { sessionId: NONEXIST, pin: '135790' } });
  assert.deepEqual([r.status, r.body.code], [401, 'device_required']);
});

test('DW-15: revoking a PC ends every session on it at the next request; its cookie no longer opens the lock screen', async () => {
  const { org, owner, af } = await world('dw15');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  const admin = new Browser();
  await admin.signIn(org.slug, owner.login, owner.password);
  const id = (await admin.call(devicesGet)).body.items[0].id;
  const r = await admin.call(deviceRevokeRoute, { method: 'POST', body: {}, params: { id } });
  assert.deepEqual([r.status, r.body.endedSessions], [200, 2]);
  assert.deepEqual([(await me(pc)).status, (await me(pc)).body.code], [401, 'session_revoked']);
  assert.deepEqual([(await people(pc)).status, (await people(pc)).body.code], [401, 'device_required']);
  const audit = await inOrg(org.orgId, async (c) => (await c.query("SELECT count(*) AS n FROM audit_log WHERE action = 'auth.device_revoked'")).rows[0].n);
  assert.equal(Number(audit), 1);
  // Signing in on that browser now gives an untrusted session and clears the stale cookie.
  const again = await pc.signIn(org.slug, af.login, af.password);
  assert.deepEqual([again.status, again.body.trustedDevice], [200, false]);
  assert.ok(!pc.jar.has('pharm_device'));
  assert.equal((await me(pc)).status, 200);
});

test('DW-15 (guard): a PC revoked outside M-11 still ends its sessions on their next request', async () => {
  const { org, owner, af } = await world('dw15g');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  // Only the device row changes (e.g. a support fix in SQL); its sessions are still open.
  await inOrg(org.orgId, (c) => c.query('UPDATE devices SET revoked_at = now(), revoked_by = $2 WHERE org_id = $1', [org.orgId, owner.id]));
  assert.deepEqual([(await me(pc)).status, (await me(pc)).body.code], [401, 'session_revoked']);
  const reason = await inOrg(org.orgId, async (c) => (await c.query('SELECT revoked_reason AS r FROM sessions WHERE staff_user_id = $1', [af.id])).rows[0].r);
  assert.equal(reason, 'device_revoked');
});

test('DW-16: on a trusted PC, a person without a switch PIN can only set one or sign out', async () => {
  const { org, owner } = await world('dw16');
  const nopin = await createStaff(org, { switchPin: null, signingPin: null });
  const pc = await trustedPc(org, owner);
  const r = await pc.signIn(org.slug, nopin.login, nopin.password);
  assert.equal(r.body.next, '/account/switch-pin');
  for (const [h, opts] of [[meRoute, {}], [lockRoute, { method: 'POST', body: {} }], [reauthRoute, { body: { password: nopin.password, purpose: 'devices.register', entityId: org.orgId } }]] as const) {
    const x = await pc.call(h, opts);
    assert.deepEqual([x.status, x.body.code], [403, 'switch_pin_required']);
  }
  assert.equal((await pc.call(switchPinRoute, { method: 'PUT', body: { pin: '582014' } })).status, 200);
  assert.equal((await me(pc)).status, 200);
});

test('DW-17 / DX-08: a session from one PC with another PC\'s cookie, or another organisation\'s, gets device_mismatch', async () => {
  const { org, owner, af } = await world('dw17');
  const B = await world('dw17b');
  const pc1 = await trustedPc(org, owner, 'Desk 1');
  const pc2 = await trustedPc(org, owner, 'Desk 2');
  const pcB = await trustedPc(B.org, B.owner, 'B Desk');
  await pc1.signIn(org.slug, af.login, af.password);
  for (const other of [pc2, pcB]) {
    const mixed = pc1.clone();
    mixed.jar.set('pharm_device', other.jar.get('pharm_device')!);
    const r = await me(mixed);
    assert.deepEqual([r.status, r.body.code], [401, 'device_mismatch']);
  }
  // §3.5: the reverse too — an untrusted session in a browser holding a valid device cookie.
  const untrusted = new Browser();
  await untrusted.signIn(org.slug, af.login, af.password);
  untrusted.jar.set('pharm_device', pc2.jar.get('pharm_device')!);
  assert.equal((await me(untrusted)).body.code, 'device_mismatch');
});

test('DW-18: signing in again on the same PC replaces that person\'s earlier session there; others are untouched', async () => {
  const { org, owner, af, a1 } = await world('dw18');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, a1.login, a1.password);
  await pc.signIn(org.slug, af.login, af.password);
  const first = await sessionIdOf(pc);
  await pc.signIn(org.slug, af.login, af.password);
  const rows = await inOrg(org.orgId, async (c) => (await c.query('SELECT id, staff_user_id AS u, revoked_reason AS r FROM sessions WHERE device_id IS NOT NULL')).rows);
  assert.equal(rows.find((x) => x.id === first).r, 'replaced');
  assert.equal(rows.filter((x) => x.u === af.id && !x.r).length, 1);
  assert.equal(rows.find((x) => x.u === a1.id).r, null, "A1's session is untouched");
  assert.equal((await me(pc)).body.name, af.name, 'the new session is active');
});

test('A-11 only switches to sessions on this PC: another PC\'s session id is 404 like a random one', async () => {
  const { org, owner, af } = await world('a11x');
  const pc1 = await trustedPc(org, owner, 'Desk 1');
  const pc2 = await trustedPc(org, owner, 'Desk 2');
  await pc2.signIn(org.slug, af.login, af.password);
  const onPc2 = await sessionIdOf(pc2);
  await lock(pc1);
  const r = await pc1.call(switchRoute, { body: { sessionId: onPc2, pin: af.switchPin } });
  assert.deepEqual([r.status, r.body.code], [404, 'SESSION_NOT_FOUND']);
});

test('DW-20: switching to a session that has expired answers session_expired', async () => {
  const { org, owner, af } = await world('dw20');
  setClockForTests(IST('2026-10-07T13:00:00'));
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  setClockForTests(IST('2026-10-07T23:00:00'));
  await pc.signIn(org.slug, owner.login, owner.password);
  await lock(pc);
  const sid = (await people(pc)).body.people.find((p: { name: string }) => p.name === af.name).sessionId;
  setClockForTests(IST('2026-10-08T04:00:01'));
  const r = await pc.call(switchRoute, { body: { sessionId: sid, pin: af.switchPin } });
  assert.deepEqual([r.status, r.body.code], [401, 'session_expired']);
});

test('DN-05: on a trusted PC the first 5 failures do not count toward the username\'s limit; from the 6th they do', async () => {
  const { org, owner, af } = await world('dn5');
  const pc = await trustedPc(org, owner);
  const codes: number[] = [];
  for (let i = 0; i < 10; i++) codes.push((await pc.signIn(org.slug, af.login, 'wrong-password')).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 401, 401, 401, 401, 429]);
  const elsewhere = await new Browser().signIn(org.slug, af.login, af.password);
  assert.equal(elsewhere.status, 429, 'the username is paused everywhere');
});

test('DX-01 (device half): A-01 on a trusted PC names it; a device cookie signed with a wrong key is ignored', async () => {
  const { org, owner } = await world('dx1d');
  const pc = await trustedPc(org, owner, 'Front Desk');
  const ctx = await pc.call(contextRoute, { path: '/api/auth/context' });
  assert.deepEqual(ctx.body, { org: { slug: org.slug, displayName: 'Synthetic dx1d' }, trustedDevice: true, device: { name: 'Front Desk', premisesName: 'Main' } });
  const claims = JSON.parse(Buffer.from(pc.jar.get('pharm_device')!.split('.')[1], 'base64url').toString());
  const forged = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('a-wrong-key-a-wrong-key-a-wrong-key-123'));
  const r = await call(contextRoute, { path: `/api/auth/context?org=${org.slug}`, cookie: `pharm_device=${forged}` });
  assert.deepEqual([r.status, r.body.trustedDevice], [200, false]);
});

test('DX-05: the lock screen lists only this organisation\'s sessions on this PC', async () => {
  const A = await world('dx5a');
  const B = await world('dx5b');
  const pcA = await trustedPc(A.org, A.owner);
  const pcB = await trustedPc(B.org, B.owner);
  await pcB.signIn(B.org.slug, B.af.login, B.af.password);
  await pcA.signIn(A.org.slug, A.af.login, A.af.password);
  const names = (await people(pcA)).body.people.map((p: { name: string }) => p.name).sort();
  assert.deepEqual(names, [A.af.name, A.owner.name].sort());
});

test('DX-06: switching on A\'s PC to B\'s session id, with B\'s right PIN, is 404 like a random id; B\'s counter is untouched', async () => {
  const A = await world('dx6a');
  const B = await world('dx6b');
  const pcA = await trustedPc(A.org, A.owner);
  const pcB = await trustedPc(B.org, B.owner);
  await pcB.signIn(B.org.slug, B.af.login, B.af.password);
  const bSid = await sessionIdOf(pcB);
  const cross = await pcA.call(switchRoute, { body: { sessionId: bSid, pin: B.af.switchPin } });
  const random = await pcA.call(switchRoute, { body: { sessionId: NONEXIST, pin: B.af.switchPin } });
  assert.deepEqual([cross.status, cross.body.code, cross.body.error], [random.status, random.body.code, random.body.error]);
  assert.equal(cross.status, 404);
  const counter = await inOrg(B.org.orgId, async (c) => (await c.query('SELECT switch_pin_failures AS f FROM staff_users WHERE id = $1', [B.af.id])).rows[0].f);
  assert.equal(counter, 0);
});

test('DX-18: M-10 lists only this organisation\'s PCs; M-11 on another organisation\'s PC is 404 and changes nothing', async () => {
  const A = await world('dx18a');
  const B = await world('dx18b');
  await trustedPc(A.org, A.owner, 'A Desk');
  const pcB = await trustedPc(B.org, B.owner, 'B Desk');
  const bId = (await pcB.call(devicesGet)).body.items[0].id;
  const admin = new Browser();
  await admin.signIn(A.org.slug, A.owner.login, A.owner.password);
  assert.deepEqual((await admin.call(devicesGet)).body.items.map((d: { name: string }) => d.name), ['A Desk']);
  const r = await admin.call(deviceRevokeRoute, { method: 'POST', body: {}, params: { id: bId } });
  const rand = await admin.call(deviceRevokeRoute, { method: 'POST', body: {}, params: { id: NONEXIST } });
  assert.deepEqual([r.status, r.body.code, r.body.error], [rand.status, rand.body.code, rand.body.error]);
  assert.equal(r.body.code, 'DEVICE_NOT_FOUND');
  assert.equal((await me(pcB)).status, 200, "B's PC is still trusted");
});

test('DC-11 mechanism: a write waits for a switch in flight and is refused if the switch moved the PC to someone else', async () => {
  const { org, owner, af, a1 } = await world('dc11');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, a1.login, a1.password);
  const a1Sid = await sessionIdOf(pc);
  await pc.signIn(org.slug, af.login, af.password);
  const hash = async () => (await inOrg(org.orgId, async (c) => (await c.query('SELECT switch_pin_hash AS h FROM staff_users WHERE id = $1', [af.id])).rows[0].h));
  const before = await hash();
  const deviceId = (await me(pc)).body.device.id;
  // A switch in flight: it holds the device's state row.
  await as('app', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    await c.query('SELECT 1 FROM device_state WHERE org_id = $1 AND device_id = $2 FOR UPDATE', [org.orgId, deviceId]);
    let settled = false;
    const write = pc.call(switchPinRoute, { method: 'PUT', body: { pin: '192837' } }).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(settled, false, 'the write waits for the switch');
    await c.query('UPDATE device_state SET active_session_id = $3 WHERE org_id = $1 AND device_id = $2', [org.orgId, deviceId, a1Sid]);
    await c.query('COMMIT');
    const r = await write;
    assert.deepEqual([r.status, r.body.code], [401, 'device_locked']);
  });
  assert.equal(await hash(), before, 'nothing was written under AF after the switch');
});

test('sign-out on a trusted PC takes the person off the lock screen and leaves the PC locked', async () => {
  const { org, owner, af } = await world('so');
  const pc = await trustedPc(org, owner);
  await pc.signIn(org.slug, af.login, af.password);
  assert.equal((await pc.call(signOutRoute, { method: 'POST' })).status, 200);
  assert.deepEqual((await people(pc)).body.people.map((p: { name: string }) => p.name), [owner.name]);
  const active = await inOrg(org.orgId, async (c) => (await c.query('SELECT active_session_id AS a FROM device_state')).rows[0].a);
  assert.equal(active, null);
});

test('an untrusted sign-in still works after PR 3: no device, no switch PIN needed', async () => {
  const { org, af } = await world('untr');
  const cookie = await signIn(org.slug, af.login, af.password);
  const r = await call(meRoute, { cookie });
  assert.deepEqual([r.status, r.body.device, r.body.lockAt], [200, null, null]);
});
