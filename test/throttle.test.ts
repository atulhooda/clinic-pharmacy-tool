// D-45 (06a §3.8): failed sign-ins are counted per submitted username, whether or not the
// account exists. 06b DN-02 (storage), DN-22, DN-23.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOrg, createStaff, inOrg } from './harness/fixtures';
import { call } from './harness/http';
import { setClockForTests } from '../lib/clock';
import { POST as signInRoute } from '../app/api/auth/sign-in/route';

afterEach(() => setClockForTests(null));
const IST = (iso: string) => new Date(`${iso}+05:30`);
let ipN = 0;
const sign = (orgSlug: string, login: string, password: string) =>
  call(signInRoute, { body: { orgSlug, login, password }, ip: `10.60.${Math.floor(ipN / 200)}.${ipN++ % 200}` });
const strip = (b: Record<string, unknown>) => { const { requestId, ...rest } = b; void requestId; return rest; };

test('DN-22: a username that does not exist is paused exactly like a real one: identical status, body and Retry-After', async () => {
  const org = await createOrg('dn22');
  const real = await createStaff(org);
  setClockForTests(IST('2026-10-07T10:00:00'));
  const run = async (login: string) => {
    const out = [];
    for (let i = 0; i < 6; i++) out.push(await sign(org.slug, login, 'wrong-password'));
    return out;
  };
  const ghost = await run('ghost');
  const known = await run(real.login);
  assert.deepEqual(ghost.map((r) => r.status), [401, 401, 401, 401, 429, 429]);
  for (let i = 0; i < 6; i++) {
    assert.deepEqual([ghost[i].status, strip(ghost[i].body), ghost[i].headers.get('retry-after')],
      [known[i].status, strip(known[i].body), known[i].headers.get('retry-after')], `try ${i + 1}`);
  }
  assert.equal(ghost[4].headers.get('retry-after'), '900');
  assert.equal(ghost[4].body.error, 'Too many attempts. Try again in 15 minutes.');
  setClockForTests(IST('2026-10-07T10:15:01'));
  const after = await sign(org.slug, 'ghost', 'wrong-password');
  assert.deepEqual([after.status, after.body.code], [401, 'invalid_credentials'], 'after 15 minutes: 401 again');
});

test('DN-23: failures count within 15 minutes of the first; a success clears the count', async () => {
  const org = await createOrg('dn23');
  const s = await createStaff(org);
  setClockForTests(IST('2026-10-07T09:00:00'));
  for (let i = 0; i < 4; i++) assert.equal((await sign(org.slug, s.login, 'wrong')).status, 401);
  setClockForTests(IST('2026-10-07T09:16:00'));
  assert.equal((await sign(org.slug, s.login, 'wrong')).status, 401, 'the window restarted: no pause');
  setClockForTests(IST('2026-10-07T11:00:00'));
  for (let i = 0; i < 3; i++) await sign(org.slug, s.login, 'wrong');
  assert.equal((await sign(org.slug, s.login, s.password)).status, 200);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await sign(org.slug, s.login, 'wrong')).status);
  assert.deepEqual(codes, [401, 401, 401, 401], 'the success cleared the count');
});

test('DN-02 / R6-10: the throttle stores only an HMAC of the login, per organisation', async () => {
  const A = await createOrg('dn2a');
  const B = await createOrg('dn2b');
  await sign(A.slug, '  Nobody-Typed-This  ', 'x');
  const rows = await inOrg(A.orgId, async (c) => (await c.query('SELECT row_to_json(t)::text AS j, login_hmac AS h FROM sign_in_throttle t')).rows);
  assert.equal(rows.length, 1);
  assert.match(rows[0].h, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!rows[0].j.toLowerCase().includes('nobody-typed-this'));
  // The same username elsewhere is a different count.
  for (let i = 0; i < 5; i++) await sign(A.slug, 'shared-name', 'x');
  assert.equal((await sign(B.slug, 'shared-name', 'x')).status, 401, "A's pause does not reach B");
  const bRow = await inOrg(B.orgId, async (c) => (await c.query('SELECT login_hmac AS h FROM sign_in_throttle')).rows[0].h);
  const aRows = await inOrg(A.orgId, async (c) => (await c.query('SELECT login_hmac AS h FROM sign_in_throttle')).rows.map((r) => r.h));
  assert.ok(!aRows.includes(bRow), 'the HMAC is keyed by the organisation too');
});
