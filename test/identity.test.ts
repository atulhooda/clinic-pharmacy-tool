// 06b §7 (DN): password sign-in and sessions. Not here yet:
// - DN-03's OTP half: Milestone 2 (D-39: no OTP in Milestone 1);
// - the device halves of DN-01 and DN-15, and DN-05: PR 3 (trusted devices);
// - DN-10, DN-17, DN-18 (role change, reset, last owner): PR 4 (administration).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { SignJWT } from 'jose';
import { createOrg, createStaff, inOrg } from './harness/fixtures';
import { call, cookieOf, signIn } from './harness/http';
import { as, urls } from './harness/env';
import { setClockForTests } from '../lib/clock';
import { verifyCounters } from '../lib/auth/password';
import { setLogSink } from '../lib/log';
import { setQueryListener } from '../lib/db/db';
import { signSessionToken } from '../lib/auth/token';
import { POST as signInRoute } from '../app/api/auth/sign-in/route';
import { POST as signOutRoute } from '../app/api/auth/sign-out/route';
import { GET as meRoute } from '../app/api/auth/me/route';
import { PUT as passwordRoute } from '../app/api/account/password/route';
import { POST as revokeAllRoute } from '../app/api/account/sessions/revoke/route';

afterEach(() => setClockForTests(null));
const IST = (iso: string) => new Date(`${iso}+05:30`);
const me = (cookie: string) => call(meRoute, { cookie, path: '/api/auth/me' });
const sign = (orgSlug: string, login: string, password: string, ip: string) =>
  call(signInRoute, { body: { orgSlug, login, password }, ip, path: '/api/auth/sign-in' });

test('DN-01: a right password opens a session with a safe cookie, audited in the same transaction', async () => {
  const org = await createOrg('dn1');
  const s = await createStaff(org);
  const r = await sign(org.slug, s.login.toUpperCase(), s.password, '10.1.0.1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.next, '/');
  assert.match(r.setCookie!, /^pharm_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Expires=/);
  assert.ok(!/Secure/.test(r.setCookie!), 'not Secure outside production');
  const who = await me(cookieOf(r.setCookie));
  assert.equal(who.status, 200);
  assert.equal(who.body.name, s.name);
  const rows = await inOrg(org.orgId, async (c) => (await c.query(
    `SELECT a.detail, a.session_id = s.id AS same FROM audit_log a JOIN sessions s ON s.staff_user_id = a.staff_user_id
      WHERE a.action = 'auth.sign_in_succeeded' AND a.staff_user_id = $1`, [s.id])).rows);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { detail: { method: 'password' }, same: true });
});

test('DN-01: the cookie is Secure when COOKIE_SECURE=1 (production behaviour)', async () => {
  const org = await createOrg('dn1s');
  const s = await createStaff(org);
  process.env.COOKIE_SECURE = '1';
  try {
    const r = await sign(org.slug, s.login, s.password, '10.1.0.2');
    assert.match(r.setCookie!, /; Secure$/);
  } finally {
    delete process.env.COOKIE_SECURE;
  }
});

test('DN-02: an unknown login gets the same answer after one dummy check, and is never logged or audited', async () => {
  const org = await createOrg('dn2');
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  const before = { ...verifyCounters };
  try {
    const r = await sign(org.slug, 'nobody-typed-this', 'whatever-password', '10.2.0.1');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'invalid_credentials');
    assert.equal(verifyCounters.dummy - before.dummy, 1);
    assert.equal(verifyCounters.real - before.real, 0);
  } finally {
    restore();
  }
  assert.ok(!lines.join('\n').includes('nobody-typed-this'));
  const audit = await inOrg(org.orgId, async (c) => (await c.query('SELECT detail::text AS d FROM audit_log')).rows.map((x) => x.d).join());
  assert.ok(!audit.includes('nobody-typed-this'));
  assert.match(audit, /unknown_login/);
});

test('DN-03: five wrong passwords pause password sign-in; during the pause the right one is refused the same way; live sessions keep working', async () => {
  const org = await createOrg('dn3');
  const s = await createStaff(org);
  const live = await signIn(org.slug, s.login, s.password, '10.3.0.1');
  for (let i = 0; i < 5; i++) assert.equal((await sign(org.slug, s.login, 'wrong-password', '10.3.0.2')).status, 401);
  const paused = await sign(org.slug, s.login, s.password, '10.3.0.3');
  assert.deepEqual([paused.status, paused.body.code], [401, 'invalid_credentials']);
  assert.equal((await me(live)).status, 200, 'a pause never ends a live session');
  // After 15 minutes the pause lapses.
  setClockForTests(new Date(Date.now() + 16 * 60_000));
  assert.equal((await sign(org.slug, s.login, s.password, '10.3.0.4')).status, 200);
});

test('DN-04: thirty parallel wrong passwords check at most five', async () => {
  const org = await createOrg('dn4');
  const s = await createStaff(org);
  const before = verifyCounters.real;
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => sign(org.slug, s.login, `wrong-${i}`, `10.4.${i}.1`)));
  assert.ok(results.every((r) => r.status === 401));
  assert.ok(verifyCounters.real - before <= 5, `checked ${verifyCounters.real - before} passwords`);
});

test('DN-06: the 21st failed sign-in from one IP within 15 minutes is refused with 429 and Retry-After', async () => {
  const org = await createOrg('dn6');
  const ip = '10.6.6.6';
  for (let i = 0; i < 20; i++) assert.equal((await sign(org.slug, `ghost${i}`, 'x-password', ip)).status, 401);
  const r = await sign(org.slug, 'ghost', 'x-password', ip);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'too_many_attempts');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('DN-07: a session ends at the next 04:00 IST, or 16 hours after sign-in if that comes first', async () => {
  const org = await createOrg('dn7');
  const s = await createStaff(org);
  setClockForTests(IST('2026-10-07T13:00:00'));
  const afternoon = await signIn(org.slug, s.login, s.password, '10.7.0.1');
  assert.equal((await me(afternoon)).body.sessionExpiresAt, IST('2026-10-08T04:00:00').toISOString());
  setClockForTests(IST('2026-10-07T10:00:00'));
  const morning = await signIn(org.slug, s.login, s.password, '10.7.0.2');
  assert.equal((await me(morning)).body.sessionExpiresAt, IST('2026-10-08T02:00:00').toISOString());
  setClockForTests(IST('2026-10-08T04:00:01'));
  const late = await me(afternoon);
  assert.deepEqual([late.status, late.body.code], [401, 'session_expired']);
});

test('DN-08: changing day_reset_time_ist is data, not a deploy; existing sessions keep their stored expiry', async () => {
  const org = await createOrg('dn8');
  const s = await createStaff(org);
  setClockForTests(IST('2026-10-07T13:00:00'));
  const before = await signIn(org.slug, s.login, s.password, '10.8.0.1');
  await inOrg(org.orgId, (c) => c.query("UPDATE org_settings SET day_reset_time_ist = '02:00', version = version + 1"));
  const after = await signIn(org.slug, s.login, s.password, '10.8.0.2');
  assert.equal((await me(after)).body.sessionExpiresAt, IST('2026-10-08T02:00:00').toISOString());
  assert.equal((await me(before)).body.sessionExpiresAt, IST('2026-10-08T04:00:00').toISOString());
  const history = await inOrg(org.orgId, async (c) => (await c.query('SELECT day_reset_time_ist::text AS t FROM org_settings_history ORDER BY created_at')).rows.map((r) => r.t));
  assert.deepEqual(history, ['04:00:00', '02:00:00'], 'every change is snapshotted');
});

test('DN-09: deactivating a person ends their session on the next request', async () => {
  const org = await createOrg('dn9');
  const s = await createStaff(org);
  const cookie = await signIn(org.slug, s.login, s.password, '10.9.0.1');
  await inOrg(org.orgId, (c) => c.query('UPDATE staff_users SET active = false WHERE id = $1', [s.id]));
  const r = await me(cookie);
  assert.deepEqual([r.status, r.body.code], [401, 'session_revoked']);
  const reason = await inOrg(org.orgId, async (c) => (await c.query('SELECT revoked_reason FROM sessions WHERE staff_user_id = $1', [s.id])).rows[0].revoked_reason);
  assert.equal(reason, 'deactivated');
});

test('DN-11: removing a premises membership takes effect on the next request without ending the session', async () => {
  const org = await createOrg('dn11');
  const s = await createStaff(org);
  const cookie = await signIn(org.slug, s.login, s.password, '10.11.0.1');
  assert.deepEqual((await me(cookie)).body.premises.map((p: { id: string }) => p.id), [org.premisesId]);
  await inOrg(org.orgId, (c) => c.query('UPDATE staff_premises SET active = false WHERE staff_user_id = $1', [s.id]));
  const r = await me(cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.premises, []);
});

test('DN-11: the owner holds every premises without membership rows', async () => {
  const org = await createOrg('dn11o');
  const owner = await createStaff(org, { role: 'owner', premises: [] });
  await inOrg(org.orgId, (c) => c.query("INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, 'Second', 'x', '27')", [org.orgId]));
  const r = await me(await signIn(org.slug, owner.login, owner.password, '10.11.1.1'));
  assert.equal(r.body.premises.length, 2);
});

test('DN-12: the guard reads the session, user, role, grants and memberships in one query', async () => {
  const org = await createOrg('dn12');
  const s = await createStaff(org);
  const cookie = await signIn(org.slug, s.login, s.password, '10.12.0.1');
  const seen: string[] = [];
  setQueryListener((sql) => seen.push(sql));
  try {
    assert.equal((await me(cookie)).status, 200);
  } finally {
    setQueryListener(null);
  }
  // The self-check runs on every request in tests (TTL 0); its catalog queries are not the guard's.
  const guard = seen.filter((q) => !/\bpg_[a-z_]+\b|schema_migrations/.test(q));
  assert.equal(guard.length, 1, guard.join('\n---\n'));
  assert.match(guard[0], /FROM sessions s[\s\S]*JOIN staff_users[\s\S]*JOIN org_roles[\s\S]*JOIN organisations/);
});

test('DN-13: with a one-time password, only sign-in, "me" and the password change are allowed', async () => {
  const org = await createOrg('dn13');
  const s = await createStaff(org, { mustChange: true });
  const r = await sign(org.slug, s.login, s.password, '10.13.0.1');
  assert.equal(r.body.next, '/account/password');
  const cookie = cookieOf(r.setCookie);
  assert.equal((await me(cookie)).status, 200);
  const blocked = await call(revokeAllRoute, { cookie, method: 'POST', path: '/api/account/sessions/revoke' });
  assert.deepEqual([blocked.status, blocked.body.code], [403, 'password_change_required']);
  const changed = await call(passwordRoute, { cookie, method: 'PUT', body: { current: s.password, next: 'a-much-better-pass' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await me(cookie)).body.mustChangePassword, false);
});

test('DN-14: changing the password ends the other sessions, keeps this one, and applies the policy', async () => {
  const org = await createOrg('dn14');
  const s = await createStaff(org, { login: 'dn14user', name: 'Dn Fourteen' });
  const here = await signIn(org.slug, s.login, s.password, '10.14.0.1');
  const elsewhere = await signIn(org.slug, s.login, s.password, '10.14.0.2');
  for (const [next, rule] of [['short', 'length'], ['dn14user', 'same_as_login_or_name'], ['password123', 'too_common']]) {
    const r = await call(passwordRoute, { cookie: here, method: 'PUT', body: { current: s.password, next } });
    assert.deepEqual([r.status, r.body.code, r.body.details?.rule], [422, 'PASSWORD_POLICY', rule]);
  }
  const ok = await call(passwordRoute, { cookie: here, method: 'PUT', body: { current: s.password, next: 'river-stone-lamp-9' } });
  assert.equal(ok.status, 200);
  assert.equal((await me(here)).status, 200);
  assert.equal((await me(elsewhere)).body.code, 'session_revoked');
  assert.equal((await sign(org.slug, s.login, 'river-stone-lamp-9', '10.14.0.3')).status, 200);
});

test('DN-14: wrong current passwords count against the session; the 5th ends it', async () => {
  const org = await createOrg('dn14w');
  const s = await createStaff(org);
  const cookie = await signIn(org.slug, s.login, s.password, '10.14.1.1');
  for (let i = 1; i <= 4; i++) {
    const r = await call(passwordRoute, { cookie, method: 'PUT', body: { current: 'not-it', next: 'whatever-new-1' } });
    assert.deepEqual([r.status, r.body.code, r.body.details.remaining], [401, 'wrong_secret', 5 - i]);
  }
  const fifth = await call(passwordRoute, { cookie, method: 'PUT', body: { current: 'not-it', next: 'whatever-new-1' } });
  assert.deepEqual([fifth.status, fifth.body.code], [401, 'session_revoked']);
  assert.equal((await me(cookie)).body.code, 'session_revoked');
  assert.equal((await sign(org.slug, s.login, s.password, '10.14.1.2')).status, 200, 'the account itself is not locked');
});

test('DN-15: signing out ends the session; signing out again still answers 200', async () => {
  const org = await createOrg('dn15');
  const s = await createStaff(org);
  const cookie = await signIn(org.slug, s.login, s.password, '10.15.0.1');
  const out = await call(signOutRoute, { cookie, method: 'POST', path: '/api/auth/sign-out' });
  assert.equal(out.status, 200);
  assert.match(out.setCookie!, /^pharm_session=; .*Max-Age=0/);
  assert.equal((await me(cookie)).body.code, 'session_revoked');
  assert.equal((await call(signOutRoute, { cookie, method: 'POST' })).status, 200);
});

test('DN-15: ending all my sessions ends this one too', async () => {
  const org = await createOrg('dn15b');
  const s = await createStaff(org);
  const a = await signIn(org.slug, s.login, s.password, '10.15.1.1');
  const b = await signIn(org.slug, s.login, s.password, '10.15.1.2');
  const r = await call(revokeAllRoute, { cookie: a, method: 'POST' });
  assert.deepEqual([r.status, r.body.ended], [200, 2]);
  assert.equal((await me(a)).body.code, 'session_revoked');
  assert.equal((await me(b)).body.code, 'session_revoked');
});

test('DN-16: a token with a wrong key, a lapsed expiry or the wrong version is refused', async () => {
  const org = await createOrg('dn16');
  const s = await createStaff(org);
  const good = await signIn(org.slug, s.login, s.password, '10.16.0.1');
  const token = good.split('=')[1];
  const [h, p] = token.split('.');
  assert.equal((await me(`pharm_session=${h}.${p}.AAAA`)).body.code, 'unauthenticated');
  const saved = process.env.SESSION_SECRET!;
  process.env.SESSION_SECRET = 'a-completely-different-secret-of-forty-chars';
  const forged = await signSessionToken(org.orgId, '00000000-0000-4000-8000-000000000000', new Date(Date.now() + 3600_000));
  process.env.SESSION_SECRET = saved;
  assert.equal((await me(`pharm_session=${forged}`)).body.code, 'unauthenticated');
  // Signed with the right key but the wrong version.
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const v2 = await new SignJWT({ ...claims, v: 2 }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(saved));
  assert.equal((await me(`pharm_session=${v2}`)).body.code, 'unauthenticated');
  assert.equal((await me('')).body.code, 'unauthenticated');
});

test('DN-19: untrusted browsers have no idle timeout unless the organisation sets one', async () => {
  const org = await createOrg('dn19');
  const s = await createStaff(org);
  setClockForTests(IST('2026-10-07T09:00:00'));
  const cookie = await signIn(org.slug, s.login, s.password, '10.19.0.1');
  setClockForTests(IST('2026-10-07T14:00:00'));
  assert.equal((await me(cookie)).status, 200, '5 hours idle is fine with the setting off');
  await inOrg(org.orgId, (c) => c.query('UPDATE org_settings SET untrusted_idle_minutes = 30, version = version + 1'));
  const fresh = await signIn(org.slug, s.login, s.password, '10.19.0.2');
  setClockForTests(IST('2026-10-07T14:31:00'));
  const r = await me(fresh);
  assert.deepEqual([r.status, r.body.code], [401, 'session_idle']);
  const audited = await inOrg(org.orgId, async (c) => (await c.query("SELECT count(*) AS n FROM audit_log WHERE action = 'auth.session_ended'")).rows[0].n);
  assert.equal(audited, 1);
});

test('DN-20: a suspended organisation cannot sign in, and its live sessions end', async () => {
  const org = await createOrg('dn20');
  const s = await createStaff(org);
  const cookie = await signIn(org.slug, s.login, s.password, '10.20.0.1');
  await as('super', (c) => c.query("UPDATE organisations SET status = 'SUSPENDED' WHERE id = $1", [org.orgId]));
  assert.equal((await me(cookie)).body.code, 'session_revoked');
  const r = await sign(org.slug, s.login, s.password, '10.20.0.2');
  assert.deepEqual([r.status, r.body.code], [401, 'invalid_credentials']);
});

test('DN-21: the founder CLI creates an organisation, its premises, roles, settings and owner, printing the one-time password once', async () => {
  const slug = `cli-${Date.now().toString(36)}`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/create-org.ts', '--slug', slug, '--name', 'CLI Clinic',
    '--premises-name', 'Main', '--address', '1 Road, Gujarat', '--state-code', '24', '--owner-name', 'Cli Owner', '--owner-login', 'cliowner'],
  { cwd: process.cwd(), env: { ...process.env, OPS_DATABASE_URL: urls.ops } as NodeJS.ProcessEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const pw = /one-time password[^:]*: (\S+)/.exec(r.stdout)?.[1];
  assert.ok(pw && pw.length === 12);
  assert.equal(r.stdout.split(pw).length - 1, 1, 'printed once');
  const orgId = /organisation ([0-9a-f-]{36})/.exec(r.stdout)![1];
  const facts = await inOrg(orgId, async (c) => ({
    roles: (await c.query('SELECT key FROM org_roles WHERE builtin ORDER BY key')).rows.map((x) => x.key),
    premises: Number((await c.query('SELECT count(*) AS n FROM premises')).rows[0].n),
    settings: Number((await c.query('SELECT count(*) AS n FROM org_settings')).rows[0].n),
    owner: (await c.query("SELECT must_change_password AS m, password_hash AS h FROM staff_users WHERE login = 'cliowner'")).rows[0],
    audit: (await c.query('SELECT action FROM audit_log ORDER BY action')).rows.map((x) => x.action),
  }));
  assert.deepEqual(facts.roles, ['doctor', 'owner', 'reception']);
  assert.deepEqual([facts.premises, facts.settings, facts.owner.m], [1, 1, true]);
  assert.ok(!facts.owner.h.includes(pw), 'stored hashed');
  assert.deepEqual(facts.audit, ['org.created', 'staff.owner_bootstrapped']);
  const first = await sign(slug, 'cliowner', pw, '10.21.0.1');
  assert.deepEqual([first.status, first.body.next], [200, '/account/password']);
});
