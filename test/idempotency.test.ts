// PR 7, idempotency (06a §12.2, rule 11; 06 R7-2): 06b DK-01 … 06, DK-09, DK-11, on E-13 (the
// dispense routes come with PR 9) and on an administration write (M-01). DK-07 (every write
// route) is in auth-isolation.test.ts, beside the route table; DK-08 and DK-10 need the GRN,
// reversal, import and people routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { createOrg, createStaff, inOrg } from './harness/fixtures';
import { as } from './harness/env';
import { Browser } from './harness/http';
import { grant, stockWorld } from './harness/stock';
import { POST as itemsPost } from '../app/api/dispensary/items/route';
import { PATCH as itemPatch } from '../app/api/dispensary/items/[id]/route';
import { GET as orgSettingsGet, PUT as orgSettingsPut } from '../app/api/org/settings/route';
import { POST as signInRoute } from '../app/api/auth/sign-in/route';

const count = (orgId: string, sql: string) => inOrg(orgId, async (c) => (await c.query(sql, [orgId])).rows[0].n as number);
const items = (orgId: string) => count(orgId, 'SELECT count(*)::int AS n FROM items WHERE org_id = $1');
const body = (name: string) => ({ category: 'MEDICINE', displayName: name, baseUnit: 'TABLET' });

test('DK-01: a write without an Idempotency-Key is 400 and writes nothing; a malformed key is 400 too', async () => {
  const w = await stockWorld('dk1');
  const before = await items(w.org.orgId);
  const r = await w.owner.call(itemsPost, { body: body('No key'), noIdempotencyKey: true });
  assert.deepEqual([r.status, r.body.code], [400, 'IDEMPOTENCY_KEY_REQUIRED']);
  const bad = await w.owner.call(itemsPost, { body: body('Bad key'), headers: { 'idempotency-key': 'short' } });
  assert.deepEqual([bad.status, bad.body.code], [400, 'IDEMPOTENCY_KEY_INVALID']);
  assert.equal(await items(w.org.orgId), before);
  // Permission comes first: a person without it is 403 whether or not the key is there (§9.1).
  const r2 = await w.reception.call(itemsPost, { body: body('No key 2'), noIdempotencyKey: true });
  assert.deepEqual([r2.status, r2.body.code], [403, 'forbidden']);
});

test('DK-02 / DK-03: a replay returns the same status and resource, marked, and writes nothing; the same key with another body is 422', async () => {
  const w = await stockWorld('dk2');
  const key = randomUUID();
  const first = await w.owner.call(itemsPost, { body: body('Replay me'), headers: { 'idempotency-key': key } });
  assert.equal(first.status, 201);
  const audits = await count(w.org.orgId, "SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'item.created'");
  const n = await items(w.org.orgId);
  // Keys of the same JSON in another order are the same request.
  const again = await w.owner.call(itemsPost, { body: { baseUnit: 'TABLET', displayName: 'Replay me', category: 'MEDICINE' }, headers: { 'idempotency-key': key } });
  assert.deepEqual([again.status, again.body.id, again.headers.get('idempotent-replayed')], [201, first.body.id, 'true']);
  assert.deepEqual(again.body, first.body, 'the resource, re-read');
  assert.equal(first.headers.get('idempotent-replayed'), null);
  assert.equal(await items(w.org.orgId), n);
  assert.equal(await count(w.org.orgId, "SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'item.created'"), audits);
  const other = await w.owner.call(itemsPost, { body: body('Something else'), headers: { 'idempotency-key': key } });
  assert.deepEqual([other.status, other.body.code], [422, 'IDEMPOTENCY_KEY_REUSED']);
  assert.equal(await items(w.org.orgId), n);
  // A different route with the same key is a different request too.
  const patch = await w.owner.call(itemPatch, { method: 'PATCH', body: { rackLocation: 'B2' }, params: { id: first.body.id }, headers: { 'idempotency-key': key } });
  assert.deepEqual([patch.status, patch.body.code], [422, 'IDEMPOTENCY_KEY_REUSED']);
});

test('DK-04: the same key fired twice at once makes one item; the other request replays', async () => {
  const w = await stockWorld('dk4');
  const key = randomUUID();
  const n = await items(w.org.orgId);
  const [a, b] = await Promise.all([1, 2].map(() => w.owner.call(itemsPost, { body: body('Concurrent'), headers: { 'idempotency-key': key } })));
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal(a.body.id, b.body.id);
  assert.deepEqual([a.headers.get('idempotent-replayed'), b.headers.get('idempotent-replayed')].sort(), ['true', null].sort());
  assert.equal(await items(w.org.orgId), n + 1);
});

test('DK-05: a failure is not remembered: the retry with the same key runs normally', async () => {
  const w = await stockWorld('dk5');
  const taken = await w.owner.call(itemsPost, { body: body('Taken name') });
  const key = randomUUID();
  const fail = await w.owner.call(itemsPost, { body: body('Taken name'), headers: { 'idempotency-key': key } });
  assert.deepEqual([fail.status, fail.body.code], [409, 'ITEM_NAME_TAKEN']);
  await w.owner.call(itemPatch, { method: 'PATCH', body: { displayName: 'Renamed away' }, params: { id: taken.body.id } });
  const retry = await w.owner.call(itemsPost, { body: body('Taken name'), headers: { 'idempotency-key': key } });
  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get('idempotent-replayed'), null);
});

test("DK-06: another organisation's use of the same key value is independent", async () => {
  const A = await stockWorld('dk6a');
  const B = await stockWorld('dk6b');
  const key = randomUUID();
  const a = await A.owner.call(itemsPost, { body: body('Same key'), headers: { 'idempotency-key': key } });
  const b = await B.owner.call(itemsPost, { body: body('Same key'), headers: { 'idempotency-key': key } });
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.notEqual(a.body.id, b.body.id);
  assert.equal(b.headers.get('idempotent-replayed'), null);
});

test('R7-2: an administration write replays without a second history row, and without needing a fresh grant', async () => {
  const org = await createOrg('dkadm');
  const aa = await createStaff(org, { role: 'owner' });
  const owner = new Browser();
  await owner.signIn(org.slug, aa.login, aa.password);
  const cur = await owner.call(orgSettingsGet);
  const key = randomUUID();
  const g = await grant(owner, aa, 'org.settings', org.orgId);
  const put = { deviceLockMinutes: 5, dayResetTimeIst: '04:00', untrustedIdleMinutes: null };
  const r1 = await owner.call(orgSettingsPut, { method: 'PUT', body: put, headers: { 'idempotency-key': key, 'reauth-grant': g, 'if-match': `"${cur.body.version}"` } });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const history = await count(org.orgId, 'SELECT count(*)::int AS n FROM org_settings_history WHERE org_id = $1');
  // The grant is single use: only a replay can succeed with it again.
  const r2 = await owner.call(orgSettingsPut, { method: 'PUT', body: put, headers: { 'idempotency-key': key, 'reauth-grant': g, 'if-match': `"${cur.body.version}"` } });
  assert.deepEqual([r2.status, r2.headers.get('idempotent-replayed'), r2.body.version], [200, 'true', r1.body.version]);
  assert.equal(await count(org.orgId, 'SELECT count(*)::int AS n FROM org_settings_history WHERE org_id = $1'), history);
  const fresh = await owner.call(orgSettingsPut, { method: 'PUT', body: put, headers: { 'reauth-grant': g, 'if-match': `"${r1.body.version}"` } });
  assert.deepEqual([fresh.status, fresh.body.code], [401, 'reauth_required'], 'a new request with the used grant is refused');
});

test('DK-09: the key table keeps the outcome, never a response body', async () => {
  const cols = await as('app', async (c) => (await c.query(
    "SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'idempotency_keys' ORDER BY c")).rows.map((r) => r.c));
  assert.deepEqual(cols, ['completed_at', 'created_at', 'id', 'key', 'method', 'org_id', 'path', 'request_sha256', 'resource_id', 'staff_user_id', 'status']);
});

test('DK-11: sign-in needs no key and is never replayed: two identical sign-ins make two sessions', async () => {
  const org = await createOrg('dk11');
  const s = await createStaff(org);
  const key = randomUUID();
  const sessions = () => count(org.orgId, 'SELECT count(*)::int AS n FROM sessions WHERE org_id = $1');
  for (let i = 0; i < 2; i++) {
    const b = new Browser();
    const r = await b.call(signInRoute, { body: { orgSlug: org.slug, login: s.login, password: s.password }, path: '/api/auth/sign-in', headers: { 'idempotency-key': key } });
    assert.equal(r.status, 200);
  }
  assert.equal(await sessions(), 2);
});
