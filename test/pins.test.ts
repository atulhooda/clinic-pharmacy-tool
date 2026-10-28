// 06b §9 (DPN): PINs, re-auth grants and the pepper. Rows that need a later PR's operation:
// DPN-04 / DPN-10 on a reversal (PR 10), DPN-08's other purposes (as each operation lands),
// DPN-12 (backdating, Milestone 2), DPN-13 (count corrections, PR 10), DPN-14's role-change
// half (PR 4). Here the grant mechanism is driven through M-10 (devices.register) and directly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { createOrg, createStaff, inOrg } from './harness/fixtures';
import { as, freshDatabase, urls, type Urls } from './harness/env';
import { Browser, call } from './harness/http';
import { setClockForTests } from '../lib/clock';
import { setLogSink } from '../lib/log';
import { setPoolForTests } from '../lib/db/pool';
import { withTenant } from '../lib/db/tenant';
import { getSchemaStatus, resetSchemaStatusCache } from '../lib/db/selfcheck';
import { hashPin, verifyPin, pinFormatOk } from '../lib/auth/pins';
import { hashPassword } from '../lib/auth/password';
import { consumeGrant } from '../lib/auth/reauth';
import { retirePepperVersion } from '../lib/db/pepper-retire';
import { ROUTES } from '../lib/routes';
import { PURPOSES } from '../lib/auth/reauth';
import { GET as meRoute } from '../app/api/auth/me/route';
import { POST as reauthRoute } from '../app/api/auth/reauth/route';
import { PUT as switchPinRoute } from '../app/api/account/switch-pin/route';
import { PUT as signingPinRoute } from '../app/api/account/signing-pin/route';
import { POST as devicesPost } from '../app/api/devices/route';
import { GET as peopleRoute } from '../app/api/auth/device/people/route';
import { POST as switchRoute } from '../app/api/auth/device/switch/route';
import { GET as healthRoute } from '../app/api/health/route';

const PEPPER_V1 = process.env.PIN_PEPPERS!;
const NONEXIST = '00000000-0000-4000-8000-000000000000';
const v2 = `v2:${Buffer.alloc(32, 'test-only-pepper-v2').toString('base64')}`;
const pools: pg.Pool[] = [];
after(async () => {
  process.env.PIN_PEPPERS = PEPPER_V1;
  setPoolForTests(undefined);
  await Promise.all(pools.map((p) => p.end()));
});

async function signedIn(role = 'reception', opts: Parameters<typeof createStaff>[1] = {}) {
  const org = await createOrg('pin');
  const person = await createStaff(org, { role, ...opts });
  const b = new Browser();
  assert.equal((await b.signIn(org.slug, person.login, person.password)).status, 200);
  return { org, person, b };
}
const failures = async (orgId: string, staffId: string) =>
  inOrg(orgId, async (c) => (await c.query('SELECT secret_failures AS f FROM sessions WHERE staff_user_id = $1 AND revoked_at IS NULL', [staffId])).rows.map((r) => r.f));

test('DPN-01: the switch PIN and the signing PIN can never be equal, either way round', async () => {
  const { person, b } = await signedIn();
  const s = await b.call(switchPinRoute, { method: 'PUT', body: { pin: person.signingPin } });
  assert.deepEqual([s.status, s.body.code], [422, 'PIN_SAME_AS_OTHER']);
  const g = await b.call(signingPinRoute, { method: 'PUT', body: { pin: person.switchPin, password: person.password } });
  assert.deepEqual([g.status, g.body.code], [422, 'PIN_SAME_AS_OTHER']);
});

test('DPN-02: setting the signing PIN needs the password in the request; a wrong one counts against the session', async () => {
  const { org, person, b } = await signedIn();
  const none = await b.call(signingPinRoute, { method: 'PUT', body: { pin: '582014' } });
  assert.deepEqual([none.status, none.body.code], [422, 'CREDENTIAL_REQUIRED']);
  const wrong = await b.call(signingPinRoute, { method: 'PUT', body: { pin: '582014', password: 'not-my-password' } });
  assert.deepEqual([wrong.status, wrong.body.code, wrong.body.details.remaining], [401, 'wrong_secret', 4]);
  assert.deepEqual(await failures(org.orgId, person.id), [1]);
  const ok = await b.call(signingPinRoute, { method: 'PUT', body: { pin: '582014', password: person.password } });
  assert.equal(ok.status, 200);
  const audited = await inOrg(org.orgId, async (c) => (await c.query("SELECT detail FROM audit_log WHERE action = 'auth.pin_set'")).rows.map((r) => r.detail));
  assert.deepEqual(audited, [{ kind: 'signing' }]);
});

test('DPN-03: PIN quality: 6 digits, no repeats, no straight runs', async () => {
  const { b } = await signedIn();
  for (const pin of ['000000', '123456', '654321', '012345', '987654', '12345', '1234567', '12a456']) {
    const r = await b.call(switchPinRoute, { method: 'PUT', body: { pin } });
    assert.deepEqual([r.status, r.body.code], [422, 'PIN_FORMAT'], pin);
  }
  assert.ok(pinFormatOk('135790') && pinFormatOk('112233') && !pinFormatOk('111111'));
});

test('DPN-04 / DPN-10 mechanism: a grant is single use, bound to its session, purpose and entity, and lasts 2 minutes', async () => {
  const { org, person, b } = await signedIn('owner');
  const grant = async () => (await b.call(reauthRoute, { body: { pin: person.signingPin, purpose: 'stock.adjust', entityId: org.premisesId } })).body.grantId as string;
  const sid = JSON.parse(Buffer.from(b.jar.get('pharm_session')!.split('.')[1], 'base64url').toString()).sid;
  const me = { orgId: org.orgId, sid, staffUserId: person.id };
  const use = (g: string | undefined, over: Partial<typeof me> = {}, purpose: 'stock.adjust' | 'stock.writeoff' = 'stock.adjust', entity = org.premisesId) =>
    withTenant(org.orgId, (db) => consumeGrant(db, { ...me, ...over }, purpose, entity, g)).then(() => 'ok', (e) => e.code);

  const g1 = await grant();
  assert.equal(await use(g1), 'ok');
  assert.equal(await use(g1), 'reauth_required', 'single use');
  assert.equal(await use(await grant(), {}, 'stock.adjust', NONEXIST), 'reauth_required', 'another entity');
  assert.equal(await use(await grant(), {}, 'stock.writeoff'), 'reauth_required', 'another purpose');
  assert.equal(await use(await grant(), { sid: NONEXIST }), 'reauth_required', 'another session');
  assert.equal(await use(undefined), 'reauth_required', 'no grant');
  const late = await grant();
  setClockForTests(new Date(Date.now() + 2 * 60_000 + 1000));
  try {
    assert.equal(await use(late), 'reauth_required', 'after 2 minutes');
  } finally {
    setClockForTests(null);
  }
  // DPN-10: an operation that fails after taking a grant rolls back, and the grant stays unused.
  const g2 = (await b.call(reauthRoute, { body: { pin: person.signingPin, purpose: 'devices.register', entityId: org.orgId } })).body.grantId;
  const failed = await b.call(devicesPost, { body: { name: 'Desk', premisesId: NONEXIST }, headers: { 'reauth-grant': g2 } });
  assert.deepEqual([failed.status, failed.body.code], [404, 'PREMISES_NOT_FOUND']);
  const retry = await b.call(devicesPost, { body: { name: 'Desk', premisesId: org.premisesId }, headers: { 'reauth-grant': g2 } });
  assert.equal(retry.status, 201, 'the same grant works once the operation can succeed');
});

test('DPN-05 / DPN-06: the switch PIN is never accepted for re-auth; the password is', async () => {
  const { org, person, b } = await signedIn();
  const sw = await b.call(reauthRoute, { body: { pin: person.switchPin, purpose: 'stock.backdate', entityId: org.premisesId } });
  assert.deepEqual([sw.status, sw.body.code], [401, 'wrong_secret']);
  assert.deepEqual(await failures(org.orgId, person.id), [1], 'it counts against the session');
  const pw = await b.call(reauthRoute, { body: { password: person.password, purpose: 'stock.backdate', entityId: org.premisesId } });
  assert.equal(pw.status, 201);
  assert.match(pw.body.grantId, /^[0-9a-f-]{36}$/);
  assert.equal(new Date(pw.body.expiresAt).getTime() - Date.now() <= 2 * 60_000, true);
});

test('DPN-07: the 5th wrong secret ends that session only; other sessions and the switch-PIN counter are untouched', async () => {
  const { org, person, b } = await signedIn();
  const other = new Browser();
  await other.signIn(org.slug, person.login, person.password);
  for (let i = 1; i <= 4; i++) {
    const r = await b.call(reauthRoute, { body: { pin: '000111', purpose: 'stock.backdate', entityId: org.premisesId } });
    assert.equal(r.body.code, 'wrong_secret');
  }
  const fifth = await b.call(reauthRoute, { body: { pin: '000111', purpose: 'stock.backdate', entityId: org.premisesId } });
  assert.deepEqual([fifth.status, fifth.body.code], [401, 'session_revoked']);
  assert.equal((await b.call(meRoute)).body.code, 'session_revoked');
  assert.equal((await other.call(meRoute)).status, 200);
  const counter = await inOrg(org.orgId, async (c) => (await c.query('SELECT switch_pin_failures AS f FROM staff_users WHERE id = $1', [person.id])).rows[0].f);
  assert.equal(counter, 0);
});

test('DPN-08 (devices.register): without a grant, or with one for another purpose or entity, 401; a matching one works', async () => {
  const { org, person, b } = await signedIn('owner');
  const body = { name: 'Desk', premisesId: org.premisesId };
  const g = async (purpose: string, entityId: string) => (await b.call(reauthRoute, { body: { pin: person.signingPin, purpose, entityId } })).body.grantId;
  for (const grantId of [undefined, await g('org.settings', org.orgId), await g('devices.register', org.premisesId)]) {
    const r = await b.call(devicesPost, { body, headers: grantId ? { 'reauth-grant': grantId } : {} });
    assert.deepEqual([r.status, r.body.code], [401, 'reauth_required']);
  }
  assert.equal((await b.call(devicesPost, { body, headers: { 'reauth-grant': await g('devices.register', org.orgId) } })).status, 201);
});

test('DPN-11: only routes that declare a purpose take a grant; reads never do', () => {
  for (const r of ROUTES) {
    if (r.reauth) {
      assert.ok((PURPOSES as readonly string[]).includes(r.reauth), `${r.path}: ${r.reauth} is not a §3.7 purpose`);
      assert.ok(r.methods.some((m) => m !== 'GET'), `${r.path}: a read never takes a grant`);
    }
  }
  const src = fs.readFileSync(path.join(process.cwd(), 'lib/admin/devices.ts'), 'utf8');
  assert.equal((src.match(/consumeGrant\(/g) ?? []).length, 1, 'only trusting a PC consumes a grant here');
});

test('DPN-14: a stock-only role gets no signing PIN; someone who needs one and has none is asked to set it first', async () => {
  const org = await createOrg('dpn14');
  await inOrg(org.orgId, async (c) => {
    await c.query("INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'store', 'Store')", [org.orgId]);
    await c.query("INSERT INTO role_grants (org_id, role_key, permission, allowed) VALUES ($1, 'store', 'stock.view', true), ($1, 'store', 'stock.receive', true)", [org.orgId]);
  });
  const store = await createStaff(org, { role: 'store', signingPin: null });
  const sb = new Browser();
  await sb.signIn(org.slug, store.login, store.password);
  const r = await sb.call(signingPinRoute, { method: 'PUT', body: { pin: '582014', password: store.password } });
  assert.deepEqual([r.status, r.body.code], [403, 'signing_pin_not_applicable']);
  const doctor = await createStaff(org, { role: 'doctor', signingPin: null });
  const db = new Browser();
  await db.signIn(org.slug, doctor.login, doctor.password);
  assert.equal((await db.call(meRoute)).body.needsSigningPin, true);
  const g = await db.call(reauthRoute, { body: { password: doctor.password, purpose: 'prescription.verify', entityId: NONEXIST } });
  assert.equal(g.status, 201, 'D-63: the login password confirms, with or without a signing PIN set');
});

test('DPN-15: a PIN hash checked under a different pepper fails; the pepper is in no table, migration or log line', async () => {
  const hash = await hashPin('582014');
  assert.match(hash, /^scrypt\$15\$8\$1\$p1\$/);
  assert.equal((await verifyPin('582014', hash)).ok, true);
  process.env.PIN_PEPPERS = `v1:${Buffer.alloc(32, 'a-different-pepper').toString('base64')}`;
  try {
    assert.equal((await verifyPin('582014', hash)).ok, false);
  } finally {
    process.env.PIN_PEPPERS = PEPPER_V1;
  }
  const secret = PEPPER_V1.slice(3);
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try {
    const { org, person } = await signedIn('owner');
    const pc = new Browser();
    await pc.signIn(org.slug, person.login, person.password);
    await pc.call(reauthRoute, { body: { pin: person.signingPin, purpose: 'devices.register', entityId: org.orgId } });
  } finally {
    restore();
  }
  assert.ok(!lines.join('\n').includes(secret));
  for (const f of fs.readdirSync('migrations')) assert.ok(!fs.readFileSync(path.join('migrations', f), 'utf8').includes(secret), f);
  const dump = await as('super', async (c) => (await c.query(`SELECT string_agg(t::text, ' ') AS s FROM (
      SELECT row_to_json(u)::text AS t FROM staff_users u UNION ALL SELECT row_to_json(a)::text FROM audit_log a
      UNION ALL SELECT setting FROM pg_settings) x`)).rows[0].s as string);
  assert.ok(!dump.includes(secret), 'no column or setting holds the pepper');
});

test('DPN-16: routine rotation: a switch with v2 configured re-hashes to p2; retiring v1 clears the rest and is audited', async () => {
  const u: Urls = await freshDatabase();
  const p = new pg.Pool({ connectionString: u.app, max: 4 });
  pools.push(p);
  setPoolForTests(p);
  resetSchemaStatusCache();
  try {
    const org = await createOrg('dpn16', { from: u });
    // Staff created with v1 hashes, in the fresh database.
    const mk = async (name: string, login: string, sw: string, sg: string) => {
      const [pw, s1, s2] = await Promise.all([hashPassword(`${login}-password-1`), hashPin(sw), hashPin(sg)]);
      return as('ops', async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
        const id = (await c.query(`INSERT INTO staff_users (org_id, name, login, role_key, password_hash, switch_pin_hash, signing_pin_hash)
                                   VALUES ($1, $2, $3, 'owner', $4, $5, $6) RETURNING id`, [org.orgId, name, login, pw, s1, s2])).rows[0].id;
        await c.query('COMMIT');
        return id as string;
      }, u);
    };
    await mk('Owner Rot', 'ownerrot', '135790', '246802');
    await mk('Other Rot', 'otherrot', '975318', '864208');
    const census = async () => as('app', async (c) => Object.fromEntries((await c.query(
      'SELECT kind, version, hashes FROM pin_pepper_census ORDER BY 1, 2')).rows.map((r) => [`${r.kind}:v${r.version}`, Number(r.hashes)])), u);
    assert.deepEqual(await census(), { 'signing:v1': 2, 'switch:v1': 2 });

    // The owner trusts a PC (v1 still current), then v2 is added and the app restarted.
    const pc = new Browser();
    await pc.signIn(org.slug, 'ownerrot', 'ownerrot-password-1');
    const g = await pc.call(reauthRoute, { body: { pin: '246802', purpose: 'devices.register', entityId: org.orgId } });
    assert.equal((await pc.call(devicesPost, { body: { name: 'Desk', premisesId: org.premisesId }, headers: { 'reauth-grant': g.body.grantId } })).status, 201);
    process.env.PIN_PEPPERS = `${PEPPER_V1},${v2}`;
    await pc.call((await import('../app/api/auth/lock/route')).POST, { method: 'POST', body: {} });
    const sid = (await pc.call(peopleRoute)).body.people[0].sessionId;
    assert.equal((await pc.call(switchRoute, { body: { sessionId: sid, pin: '135790' } })).status, 200);
    assert.deepEqual(await census(), { 'signing:v1': 2, 'switch:v1': 1, 'switch:v2': 1 }, 'the switch re-hashed to p2; v1 dropped by one');

    const mig = new pg.Pool({ connectionString: u.migrator, max: 1 });
    pools.push(mig);
    assert.deepEqual(await retirePepperVersion(mig, 1), { orgs: 1, cleared: 3 });
    assert.deepEqual(await census(), { 'signing:v1': 0, 'switch:v1': 0, 'switch:v2': 1 });
    const audit = await as('app', async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      const r = (await c.query("SELECT detail FROM audit_log WHERE action = 'auth.pin_pepper_retired'")).rows;
      await c.query('COMMIT');
      return r;
    }, u);
    assert.deepEqual(audit.map((r) => r.detail), [{ version: 1, count: 3 }]);
    const force = await as('super', async (c) => (await c.query("SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'staff_users'")).rows[0].f, u);
    assert.equal(force, true, 'FORCE RLS is restored');
    // Now v1 can leave PIN_PEPPERS, and the self-check is happy.
    process.env.PIN_PEPPERS = v2;
    resetSchemaStatusCache();
    assert.equal((await getSchemaStatus(p)).ok, true);
  } finally {
    process.env.PIN_PEPPERS = PEPPER_V1;
    setPoolForTests(undefined);
    resetSchemaStatusCache();
  }
});

test('DPN-17: the app refuses to start with PIN_PEPPERS missing, malformed, short, or lacking a stored version; it names the check, never the value', async () => {
  // A stored v1 hash exists in the main database (every fixture has PINs).
  await createStaff(await createOrg('dpn17'));
  const cases: [string | undefined, RegExp][] = [
    [undefined, /PIN_PEPPERS is missing/],
    ['not-a-pepper', /PIN_PEPPERS is malformed/],
    [`v1:${Buffer.alloc(16, 1).toString('base64')}`, /version 1 is shorter than 32 bytes/],
    [v2, /stored PIN hashes use pepper version 1, which PIN_PEPPERS lacks/],
  ];
  for (const [value, expected] of cases) {
    const env = { ...process.env, DATABASE_URL: urls.app } as NodeJS.ProcessEnv;
    if (value === undefined) delete env.PIN_PEPPERS; else env.PIN_PEPPERS = value;
    const r = spawnSync(process.execPath, ['scripts/check-startup.cjs'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, String(value));
    assert.match(r.stderr, expected);
    if (value && value.includes(':')) assert.ok(!r.stderr.includes(value.split(':')[1]), 'the value is never printed');
    // The running app's self-check gates every route the same way.
    if (value === undefined) delete process.env.PIN_PEPPERS; else process.env.PIN_PEPPERS = value;
    resetSchemaStatusCache();
    try {
      const res = await call((await import('../app/api/auth/sign-in/route')).POST, { body: { orgSlug: 'x-clinic', login: 'x', password: 'x' } });
      assert.deepEqual([res.status, res.body.code], [503, 'CONFIG_INVALID']);
      assert.equal((await call(healthRoute)).status, 200, '/api/health stays exempt');
    } finally {
      process.env.PIN_PEPPERS = PEPPER_V1;
      resetSchemaStatusCache();
    }
  }
  const ok = spawnSync(process.execPath, ['scripts/check-startup.cjs'], { env: { ...process.env, DATABASE_URL: urls.app } as NodeJS.ProcessEnv, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});
