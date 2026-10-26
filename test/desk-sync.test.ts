// D-57: the pharmacy half of the desk ⇄ pharmacy stock sync (migrations 027, 028; E-52 … E-56).
// The desk's signed calls are driven in-process through the real route handlers, against the real
// database, with synthetic organisations, items and bills only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { batch, createItem, grant, post, snapshot, stockWorld, asAppIn, type Item, type StockWorld } from './harness/stock';
import { createOrg, inOrg } from './harness/fixtures';
import { as } from './harness/env';
import { call, signIn } from './harness/http';
import { now, setClockForTests } from '../lib/clock';
import { setQueryListener, wrap } from '../lib/db/db';
import { verifySchema } from '../lib/db/selfcheck';
import { signDeskRequest } from '../lib/integrations/desk/signature';
import { GET as deskItemsRoute } from '../app/api/integrations/desk/items/route';
import { POST as deskSalesRoute } from '../app/api/integrations/desk/sales/route';
import { POST as deskReturnsRoute } from '../app/api/integrations/desk/returns/route';
import { GET as deskSalesList } from '../app/api/dispensary/desk-sales/route';
import { POST as deskResolve } from '../app/api/dispensary/desk-sales/[id]/resolve/route';
import { GET as staffList } from '../app/api/staff/route';

const KEY = 'synthetic-desk-sync-key-for-tests-only-0123456789';
const ITEMS = '/api/integrations/desk/items';
const SALES = '/api/integrations/desk/sales';
const RETURNS = '/api/integrations/desk/returns';

function on(w: { org: { slug: string }; main: { id: string } }, key = KEY): void {
  process.env.DESK_SYNC_KEY = key;
  process.env.DESK_SYNC_ORG_SLUG = w.org.slug;
  process.env.DESK_SYNC_PREMISES_ID = w.main.id;
}
afterEach(() => {
  setClockForTests(null);
  delete process.env.DESK_SYNC_KEY;
  delete process.env.DESK_SYNC_ORG_SLUG;
  delete process.env.DESK_SYNC_PREMISES_ID;
});

/** A request signed as the desk signs it; `opts` breaks one part of it. */
async function desk(handler: unknown, method: 'GET' | 'POST', path: string, body?: unknown,
  opts: { key?: string; ts?: number; nonce?: string; sendBody?: string; signPath?: string; noSignature?: boolean } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(now().getTime() / 1000));
  const nonce = opts.nonce ?? randomUUID();
  const headers: Record<string, string> = { 'x-desk-ts': ts, 'x-desk-nonce': nonce };
  if (!opts.noSignature) headers['x-desk-signature'] = signDeskRequest(opts.key ?? KEY, method, opts.signPath ?? path, ts, nonce, text);
  const sent = opts.sendBody ?? text;
  return call(handler, { method, path, body: sent ? sent : undefined, headers });
}

const sale = (lines: { lineKey: string; itemId: string; qtyBase: number }[], billId = randomUUID()) =>
  ({ billId, serial: `B-${billId.slice(0, 6)}`, issuedAt: now().toISOString(), lines });

async function retail(w: StockWorld, name: string, extra: Record<string, unknown> = {}): Promise<Item> {
  return createItem(w.owner, { category: 'RETAIL_PRODUCT', displayName: `${name} ${randomUUID().slice(0, 4)}`, baseUnit: 'PIECE', ...extra }, { name: 'box', factor: 10 });
}

/** Opening stock on a batch of the item at the main store (or another location). */
async function stock(w: StockWorld, item: Item, qty: number, expiry: string, opts: { mrpPaise?: number; locationId?: string } = {}): Promise<string> {
  const id = await batch(w, { item, expiry, mrpPaise: opts.mrpPaise ?? 1000 });
  await post(w, [{ type: 'OPENING_BALANCE', itemId: item.id, batchId: id, qtyDelta: qty, locationId: opts.locationId ?? w.main.store }]);
  return id;
}

/** D-55: stock on the item's placeholder batch at the main store. */
async function placeholder(w: StockWorld, item: Item, qty: number): Promise<string> {
  const id = await inOrg(w.org.orgId, async (c) => (await c.query(
    `INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id, details_pending)
     VALUES ($1, $2, $3, 'DETAILS PENDING', DATE '2099-12-31', 1, $4, true) RETURNING id`, [w.org.orgId, w.main.id, item.id, item.baseUnitId])).rows[0].id as string);
  await post(w, [{ type: 'OPENING_BALANCE', itemId: item.id, batchId: id, qtyDelta: qty }]);
  return id;
}

const onHand = async (w: StockWorld, batchId: string, locationId = w.main.store) =>
  (await snapshot(w.org.orgId)).cache.get(`${w.main.id}/${(await itemOf(w, batchId))}/${batchId}/${locationId}`) ?? 0;
const itemOf = async (w: StockWorld, batchId: string) =>
  inOrg(w.org.orgId, async (c) => (await c.query('SELECT item_id FROM batches WHERE id = $1', [batchId])).rows[0].item_id as string);

interface Mv { type: string; qty: number; batchId: string | null; locationId: string; referenceType: string; actor: string; system: string | null }
const movements = async (w: StockWorld, itemId: string): Promise<Mv[]> => inOrg(w.org.orgId, async (c) => (await c.query(
  `SELECT m.movement_type AS type, m.qty_delta AS qty, m.batch_id AS "batchId", m.location_id AS "locationId", m.reference_type AS "referenceType",
          m.actor_label AS actor, u.system_kind AS system
     FROM stock_movements m JOIN staff_users u ON u.org_id = m.org_id AND u.id = m.actor_staff_id
    WHERE m.item_id = $1 AND m.movement_type <> 'OPENING_BALANCE' ORDER BY m.seq`, [itemId])).rows as Mv[]);

const day = (n: number) => new Date(now().getTime() + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- the switch and the signature

test('D-57: off unless DESK_SYNC_KEY (≥ 32), DESK_SYNC_ORG_SLUG and DESK_SYNC_PREMISES_ID are all set: every desk route is 404, signed or not', async () => {
  const w = await stockWorld('dsoff');
  const item = await retail(w, 'Sunscreen');
  const body = sale([{ lineKey: 'l1', itemId: item.id, qtyBase: 1 }]);
  for (const [h, m, p, b] of [[deskItemsRoute, 'GET', ITEMS, undefined], [deskSalesRoute, 'POST', SALES, body],
    [deskReturnsRoute, 'POST', RETURNS, { creditNoteId: randomUUID(), billId: body.billId, lines: [{ lineKey: 'l1', qtyBase: 1 }] }]] as const) {
    const r = await desk(h, m, p, b);
    assert.deepEqual([r.status, r.body.code], [404, 'not_found'], `${m} ${p} with nothing set`);
  }
  on(w, 'too-short-key');
  assert.equal((await desk(deskItemsRoute, 'GET', ITEMS, undefined, { key: 'too-short-key' })).status, 404, 'a key under 32 characters keeps it off');
  on(w);
  delete process.env.DESK_SYNC_PREMISES_ID;
  assert.equal((await desk(deskSalesRoute, 'POST', SALES, body)).status, 404, 'no premises: off');
  on(w);
  delete process.env.DESK_SYNC_ORG_SLUG;
  assert.equal((await desk(deskSalesRoute, 'POST', SALES, body)).status, 404, 'no organisation: off');
  assert.equal((await movements(w, item.id)).length, 0);
  on(w);
  assert.equal((await desk(deskItemsRoute, 'GET', ITEMS)).status, 200, 'all three set: on');
});

test('D-57: the signature, the timestamp window and the single-use nonce are checked before anything moves', async () => {
  const w = await stockWorld('dssig');
  const item = await retail(w, 'Lip balm');
  await stock(w, item, 20, day(200));
  on(w);
  const body = sale([{ lineKey: 'l1', itemId: item.id, qtyBase: 2 }]);
  const expect401 = async (r: Awaited<ReturnType<typeof desk>>, code: string, what: string) => assert.deepEqual([r.status, r.body.code], [401, code], what);
  await expect401(await desk(deskSalesRoute, 'POST', SALES, body, { noSignature: true }), 'bad_signature', 'no signature');
  await expect401(await call(deskSalesRoute, { method: 'POST', path: SALES, body }), 'bad_signature', 'no desk headers at all');
  await expect401(await desk(deskSalesRoute, 'POST', SALES, body, { key: 'another-key-of-the-same-length-0123456789xyz' }), 'bad_signature', 'the wrong key');
  await expect401(await desk(deskSalesRoute, 'POST', SALES, body, { sendBody: JSON.stringify({ ...body, lines: [{ ...body.lines[0], qtyBase: 20 }] }) }),
    'bad_signature', 'a body changed after signing');
  await expect401(await desk(deskSalesRoute, 'POST', SALES, body, { signPath: RETURNS }), 'bad_signature', 'signed for another path');
  // The server's clock is pinned, so the window is measured exactly however slow the run is.
  setClockForTests(new Date(Math.floor(Date.now() / 1000) * 1000));
  const nowS = Math.floor(now().getTime() / 1000);
  await expect401(await desk(deskSalesRoute, 'POST', SALES, body, { ts: nowS - 121 }), 'stale_timestamp', '121 s old');
  await expect401(await desk(deskSalesRoute, 'POST', SALES, body, { ts: nowS + 121 }), 'stale_timestamp', '121 s ahead');
  assert.equal((await movements(w, item.id)).length, 0, 'nothing moved on a refused request');
  assert.equal((await desk(deskSalesRoute, 'POST', SALES, body, { ts: nowS - 120 })).status, 200, 'inside the window (120 s is the edge)');
  setClockForTests(null);
  const nonce = randomUUID();
  assert.equal((await desk(deskItemsRoute, 'GET', ITEMS, undefined, { nonce })).status, 200);
  await expect401(await desk(deskItemsRoute, 'GET', ITEMS, undefined, { nonce }), 'nonce_reused', 'a nonce is single-use');
  const fresh = sale([{ lineKey: 'l1', itemId: item.id, qtyBase: 1 }]);
  const n2 = randomUUID();
  assert.equal((await desk(deskSalesRoute, 'POST', SALES, fresh, { nonce: n2 })).status, 200);
  await expect401(await desk(deskSalesRoute, 'POST', SALES, fresh, { nonce: n2 }), 'nonce_reused', 'a replayed sale');
  assert.equal((await movements(w, item.id)).length, 2, 'two sales, one movement each; the replays moved nothing');
});

test('D-57: the organisation and premises come only from the env: a body cannot name them, and another organisation\'s item is unknown', async () => {
  const w = await stockWorld('dsenv');
  const other = await stockWorld('dsenv2');
  const theirs = await retail(other, 'Their cream');
  await stock(other, theirs, 10, day(200));
  on(w);
  const r = await desk(deskSalesRoute, 'POST', SALES, { ...sale([{ lineKey: 'l1', itemId: theirs.id, qtyBase: 1 }]), orgId: other.org.orgId });
  assert.deepEqual([r.status, r.body.code], [422, 'UNKNOWN_FIELD']);
  const r2 = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'l1', itemId: theirs.id, qtyBase: 1 }]));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual(r2.body.lines[0], { lineKey: 'l1', status: 'rejected', allocatedBase: 0, shortBase: 0, reason: 'unknown_item' });
  assert.equal((await movements(other, theirs.id)).length, 0, 'the other organisation\'s stock never moves');
  const items = (await desk(deskItemsRoute, 'GET', ITEMS)).body.items as { id: string }[];
  assert.ok(!items.some((i) => i.id === theirs.id));
});

// ---------------------------------------------------------------- E-52

test('E-52 / D-59: only active retail products and medicines given to patients, with on-hand, dispensable and the highest MRP per base unit (rounded up)', async () => {
  const w = await stockWorld('dsitems');
  const cream = await retail(w, 'Cream');
  const both = await retail(w, 'Shampoo', { useFor: 'BOTH' });
  const clinicOnly = await retail(w, 'Peel', { useFor: 'IN_CLINIC' });
  const removed = await retail(w, 'Old soap');
  await w.owner.call((await import('../app/api/dispensary/items/[id]/route')).PATCH, { method: 'PATCH', params: { id: removed.id }, body: { active: false } });
  // Box of 10: 1005 paise a box is 100.5 a piece → 101; 900 a box → 90. Quarantined and placeholder stock count on hand only.
  await stock(w, cream, 7, day(100), { mrpPaise: 1005 });
  await stock(w, cream, 5, day(300), { mrpPaise: 900 });
  await stock(w, cream, 4, day(200), { mrpPaise: 5000, locationId: w.main.quarantine });
  await placeholder(w, cream, 3);
  on(w);
  const r = await desk(deskItemsRoute, 'GET', ITEMS);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = (r.body.items as { id: string }[]).map((i) => i.id);
  assert.ok(ids.includes(cream.id) && ids.includes(both.id) && ids.includes(w.pcm.id), 'retail products and medicines (D-59)');
  assert.ok(!ids.includes(clinicOnly.id) && !ids.includes(removed.id) && !ids.includes(w.glv.id), 'given to patients, active, never a consumable');
  const c = r.body.items.find((i: { id: string }) => i.id === cream.id);
  assert.deepEqual({ onHand: c.onHandBase, dispensable: c.dispensableBase, maxMrp: c.maxMrpPaisePerBase, category: c.category, baseUnit: c.baseUnit, active: c.active },
    { onHand: 19, dispensable: 12, maxMrp: 101, category: 'RETAIL_PRODUCT', baseUnit: 'PIECE', active: true });
  assert.equal(r.body.items.find((i: { id: string }) => i.id === both.id).maxMrpPaisePerBase, null, 'no stock: no MRP');
});

// ---------------------------------------------------------------- E-53

test('E-53: FEFO across two batches, posted as DISPENSE movements by the "Ritu Desk" system actor', async () => {
  const w = await stockWorld('dsfefo');
  const item = await retail(w, 'Serum');
  const later = await stock(w, item, 5, day(300));
  const sooner = await stock(w, item, 3, day(60));
  on(w);
  const r = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'line-1', itemId: item.id, qtyBase: 6 }]));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.lines, [{ lineKey: 'line-1', status: 'posted', allocatedBase: 6, shortBase: 0, reason: null }]);
  const mv = await movements(w, item.id);
  assert.deepEqual(mv.map((m) => [m.type, m.qty, m.batchId, m.referenceType, m.actor, m.system]), [
    ['DISPENSE', -3, sooner, 'DESK_SALE_ALLOCATION', 'Ritu Desk', 'DESK_SYNC'],
    ['DISPENSE', -3, later, 'DESK_SALE_ALLOCATION', 'Ritu Desk', 'DESK_SYNC'],
  ].sort((a, b) => (a[2]! < b[2]! ? -1 : 1)), 'the earliest expiry first, then the next');
  assert.deepEqual([await onHand(w, sooner), await onHand(w, later)], [0, 2]);
});

test('E-53: the same bill line again returns its stored result and moves nothing', async () => {
  const w = await stockWorld('dsidem');
  const item = await retail(w, 'Toner');
  const b = await stock(w, item, 10, day(200));
  on(w);
  const body = sale([{ lineKey: 'a', itemId: item.id, qtyBase: 4 }, { lineKey: 'b', itemId: item.id, qtyBase: 50 }]);
  const first = await desk(deskSalesRoute, 'POST', SALES, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.lines.map((l: { status: string }) => l.status), ['posted', 'short']);
  const before = await snapshot(w.org.orgId);
  for (let i = 0; i < 3; i++) {
    const again = await desk(deskSalesRoute, 'POST', SALES, body);
    assert.deepEqual(again.body, first.body, 'the stored result');
  }
  // A retry that also changes the quantity still answers what was stored (the line key is the key).
  const changed = await desk(deskSalesRoute, 'POST', SALES, { ...body, lines: [{ lineKey: 'a', itemId: item.id, qtyBase: 9 }] });
  assert.deepEqual(changed.body.lines, [first.body.lines[0]]);
  assert.deepEqual(await snapshot(w.org.orgId), before, 'nothing moved');
  assert.equal(await onHand(w, b), 6);
  assert.equal((await movements(w, item.id)).length, 1);
});

test('E-53: expired, quarantined and placeholder stock is never taken; a short line posts nothing and is stored short', async () => {
  const w = await stockWorld('dsskip');
  const item = await retail(w, 'Gel');
  const real = await stock(w, item, 2, day(200));
  const expired = await stock(w, item, 10, day(100));
  await stock(w, item, 10, day(150), { locationId: w.main.quarantine });
  const pending = await placeholder(w, item, 10);
  // The batch expired yesterday (an expiry date is fixed in the app; the owner role sets up the case).
  const { asOwnerIn } = await import('./harness/stock');
  assert.equal(await asOwnerIn(w.org.orgId, 'UPDATE batches SET expiry_date = $2 WHERE org_id = $1 AND id = $3', [w.org.orgId, day(-1), expired]), null);
  on(w);
  const r = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'x', itemId: item.id, qtyBase: 3 }]));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.lines[0], { lineKey: 'x', status: 'short', allocatedBase: 0, shortBase: 1, reason: 'details_pending' },
    'only 2 are takeable; the placeholder would cover the rest, so its details are what is missing');
  assert.equal((await movements(w, item.id)).length, 0, 'nothing posted for a short line');
  assert.deepEqual([await onHand(w, real), await onHand(w, expired), await onHand(w, pending)], [2, 10, 10]);
  const big = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'x', itemId: item.id, qtyBase: 40 }]));
  assert.deepEqual(big.body.lines[0], { lineKey: 'x', status: 'short', allocatedBase: 0, shortBase: 38, reason: 'insufficient_stock' });
  const ok = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'x', itemId: item.id, qtyBase: 2 }]));
  assert.equal(ok.body.lines[0].status, 'posted');
  assert.deepEqual((await movements(w, item.id)).map((m) => [m.batchId, m.qty]), [[real, -2]], 'only the real, unexpired store batch');
});

test('E-53 / D-59: a medicine sells like a retail product; a consumable, an item used in clinic, or one not in this pharmacy is rejected and moves nothing', async () => {
  const w = await stockWorld('dsrej');
  const peel = await retail(w, 'Peel', { useFor: 'IN_CLINIC' });
  await stock(w, peel, 10, day(200));
  const pcmBatch = await batch(w, { expiry: day(200) });
  await post(w, [{ type: 'OPENING_BALANCE', batchId: pcmBatch, qtyDelta: 30 }]);
  await post(w, [{ type: 'OPENING_BALANCE', itemId: w.glv.id, batchId: null, qtyDelta: 100 }]);
  on(w);
  const r = await desk(deskSalesRoute, 'POST', SALES, sale([
    { lineKey: 'med', itemId: w.pcm.id, qtyBase: 1 }, { lineKey: 'gloves', itemId: w.glv.id, qtyBase: 1 }, { lineKey: 'peel', itemId: peel.id, qtyBase: 1 },
    { lineKey: 'ghost', itemId: randomUUID(), qtyBase: 1 }]));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.lines.map((l: { status: string; reason?: string }) => [l.status, l.reason ?? null]),
    [['posted', null], ['rejected', 'not_retail_product'], ['rejected', 'not_for_patients'], ['rejected', 'unknown_item']]);
  assert.deepEqual((await movements(w, w.pcm.id)).map((m) => [m.batchId, m.qty]), [[pcmBatch, -1]], 'the medicine moved, by FEFO');
  assert.equal((await movements(w, w.glv.id)).length + (await movements(w, peel.id)).length, 0);
  const bad = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'a', itemId: peel.id, qtyBase: 1 }, { lineKey: 'a', itemId: peel.id, qtyBase: 1 }]));
  assert.deepEqual([bad.status, bad.body.code], [422, 'DUPLICATE_LINE_KEY']);
  assert.equal((await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'a', itemId: peel.id, qtyBase: 0 }]))).status, 422);
});

test('E-53: two posts of the same line at once give one set of movements and the same answer', async () => {
  const w = await stockWorld('dsrace');
  const item = await retail(w, 'Mask');
  await stock(w, item, 4, day(90));
  await stock(w, item, 4, day(400));
  on(w);
  for (let round = 0; round < 3; round++) {
    const body = sale([{ lineKey: 'k', itemId: item.id, qtyBase: 2 }]);
    const [a, b] = await Promise.all([desk(deskSalesRoute, 'POST', SALES, body), desk(deskSalesRoute, 'POST', SALES, body)]);
    assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
    assert.deepEqual(a.body, b.body);
  }
  assert.deepEqual((await movements(w, item.id)).map((m) => m.qty), [-2, -2, -2], 'three bills, three movements');
  const lines = await inOrg(w.org.orgId, async (c) => (await c.query('SELECT count(*)::int AS n FROM desk_sale_allocations WHERE item_id = $1', [item.id])).rows[0].n);
  assert.equal(lines, 3);
});

// ---------------------------------------------------------------- E-54

test('E-54: a credit note puts back what the bill line took, newest allocation first, never more; idempotent per (credit note, line)', async () => {
  const w = await stockWorld('dsret');
  const item = await retail(w, 'Cleanser');
  const later = await stock(w, item, 3, day(300));
  const sooner = await stock(w, item, 3, day(60));
  await stock(w, item, 1, day(500));
  on(w);
  const billId = randomUUID();
  const s = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 6 }, { lineKey: 'L2', itemId: item.id, qtyBase: 99 }], billId));
  assert.deepEqual(s.body.lines.map((l: { status: string }) => l.status), ['posted', 'short']);
  const cn1 = randomUUID();
  const ret = (creditNoteId: string, lines: { lineKey: string; qtyBase: number }[]) => desk(deskReturnsRoute, 'POST', RETURNS, { creditNoteId, billId, lines });
  const r1 = await ret(cn1, [{ lineKey: 'L1', qtyBase: 4 }]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(r1.body.lines, [{ lineKey: 'L1', status: 'returned', returnedBase: 4, reason: null }]);
  assert.deepEqual([await onHand(w, later), await onHand(w, sooner)], [3, 1], 'the later batch (taken last) comes back first');
  assert.deepEqual(await ret(cn1, [{ lineKey: 'L1', qtyBase: 4 }]).then((r) => r.body), r1.body, 'the same credit-note line again');
  assert.deepEqual([await onHand(w, later), await onHand(w, sooner)], [3, 1], 'and nothing moved');
  const r2 = await ret(randomUUID(), [{ lineKey: 'L1', qtyBase: 5 }, { lineKey: 'L2', qtyBase: 1 }]);
  assert.deepEqual(r2.body.lines, [
    { lineKey: 'L1', status: 'returned', returnedBase: 2, reason: 'more_than_taken' },
    { lineKey: 'L2', status: 'nothing_to_return', returnedBase: 0, reason: 'not_posted' },
  ]);
  const r3 = await ret(randomUUID(), [{ lineKey: 'L1', qtyBase: 1 }]);
  assert.deepEqual(r3.body.lines, [{ lineKey: 'L1', status: 'nothing_to_return', returnedBase: 0, reason: 'already_returned' }]);
  assert.deepEqual([await onHand(w, later), await onHand(w, sooner)], [3, 3], 'exactly what was taken, no more');
  const mv = await movements(w, item.id);
  assert.equal(mv.filter((m) => m.type === 'PATIENT_RETURN').reduce((n, m) => n + m.qty, 0), 6);
  assert.ok(mv.filter((m) => m.type === 'PATIENT_RETURN').every((m) => m.referenceType === 'DESK_RETURN_ALLOCATION' && m.system === 'DESK_SYNC'));
});

test('E-54: the database refuses a return allocation beyond what the sale took (the backstop under the service)', async () => {
  const w = await stockWorld('dsretdb');
  const item = await retail(w, 'Wash');
  const b = await stock(w, item, 5, day(300));
  on(w);
  const billId = randomUUID();
  await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 2 }], billId));
  await desk(deskReturnsRoute, 'POST', RETURNS, { creditNoteId: randomUUID(), billId, lines: [{ lineKey: 'L1', qtyBase: 1 }] });
  const ids = await inOrg(w.org.orgId, async (c) => (await c.query(
    `SELECT a.id AS alloc, r.id AS ret FROM desk_sale_allocations a JOIN desk_return_allocations x ON x.sale_allocation_id = a.id
       JOIN desk_return_lines r ON r.id = x.return_line_id WHERE a.item_id = $1`, [item.id])).rows[0] as { alloc: string; ret: string });
  const err = await asAppIn(w.org.orgId, `INSERT INTO desk_return_allocations (org_id, premises_id, return_line_id, sale_allocation_id, item_id, batch_id, location_id, qty_base, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 2, now())`, [w.org.orgId, w.main.id, ids.ret, ids.alloc, item.id, b, w.main.store]);
  assert.equal(err?.hint, 'DESK_RETURN_EXCEEDS_SALE');
  const partial = await asAppIn(w.org.orgId, `UPDATE desk_sale_lines SET status = 'SHORT', short_base = 1, reason = 'insufficient_stock' WHERE item_id = $1`, [item.id]);
  assert.equal(partial?.hint, 'DESK_SALE_FIXED', 'a posted line never changes');
  const half = await asAppIn(w.org.orgId, `INSERT INTO desk_sale_lines (org_id, premises_id, bill_id, line_key, bill_serial, issued_at, requested_item_id, item_id, qty_base,
      status, allocated_base, short_base, reason, location_id, received_at) VALUES ($1, $2, $3, 'z', 'S', now(), $4, $4, 5, 'POSTED', 3, 2, NULL, $5, now())`,
    [w.org.orgId, w.main.id, randomUUID(), item.id, w.main.store]);
  assert.equal(half?.constraint, 'desk_sale_lines_never_partial', 'a partly allocated line cannot be stored');
});

// ---------------------------------------------------------------- E-55, E-56 and the system actor

test('E-55 / E-56: a short line is listed for staff; after stock arrives, Retry (signed) posts it in the person\'s name', async () => {
  const w = await stockWorld('dsres');
  const item = await retail(w, 'Balm');
  on(w);
  const billId = randomUUID();
  const r = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 3 }], billId));
  assert.equal(r.body.lines[0].status, 'short');
  const list = await w.reception.call(deskSalesList, { path: '/api/dispensary/desk-sales' });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const line = list.body.items.find((i: { itemId: string }) => i.itemId === item.id);
  assert.deepEqual([line.status, line.shortBase, line.reason, list.body.open], ['SHORT', 3, 'insufficient_stock', 1]);
  assert.equal((await w.reception.call(deskResolve, { params: { id: line.id }, body: {} })).status, 403, 'reception cannot adjust stock');
  const noGrant = await w.owner.call(deskResolve, { params: { id: line.id }, body: {} });
  assert.deepEqual([noGrant.status, noGrant.body.code], [401, 'reauth_required']);
  const still = await w.owner.call(deskResolve, { params: { id: line.id }, body: {}, headers: { 'reauth-grant': await grant(w.owner, w.aa, 'stock.adjust', w.main.id) } });
  assert.deepEqual([still.status, still.body.status, still.body.shortBase], [200, 'SHORT', 3], 'still short: stays short');
  await stock(w, item, 5, day(200));
  const done = await w.owner.call(deskResolve, { params: { id: line.id }, body: {}, headers: { 'reauth-grant': await grant(w.owner, w.aa, 'stock.adjust', w.main.id) } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.status, done.body.allocatedBase, done.body.resolvedBy], ['POSTED', 3, w.aa.name]);
  assert.deepEqual((await movements(w, item.id)).map((m) => [m.qty, m.actor, m.system]), [[-3, w.aa.name, null]]);
  const again = await w.owner.call(deskResolve, { params: { id: line.id }, body: {}, headers: { 'reauth-grant': await grant(w.owner, w.aa, 'stock.adjust', w.main.id) } });
  assert.deepEqual([again.status, again.body.code], [409, 'DESK_SALE_POSTED']);
  const repeat = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 3 }], billId));
  assert.deepEqual(repeat.body.lines, [{ lineKey: 'L1', status: 'posted', allocatedBase: 3, shortBase: 0, reason: null }], 'the desk\'s retry now sees it posted');
  assert.equal((await movements(w, item.id)).length, 1, 'and moves nothing more');
  assert.equal((await w.owner.call(deskSalesList, { path: '/api/dispensary/desk-sales' })).body.open, 0);
});

test('DX (E-55, E-56): another organisation\'s desk lines are not listed, and resolving one is 404 like a line that does not exist', async () => {
  const a = await stockWorld('dsdxa');
  const b = await stockWorld('dsdxb');
  const item = await retail(b, 'B cream');
  on(b);
  await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 1 }]));
  const bLine = (await b.owner.call(deskSalesList, { path: '/api/dispensary/desk-sales' })).body.items[0];
  assert.equal(bLine.status, 'SHORT');
  assert.deepEqual((await a.owner.call(deskSalesList, { path: '/api/dispensary/desk-sales?status=all' })).body.items, []);
  const g = await grant(a.owner, a.aa, 'stock.adjust', a.main.id);
  const r = await a.owner.call(deskResolve, { params: { id: bLine.id }, body: {}, headers: { 'reauth-grant': g } });
  const none = await a.owner.call(deskResolve, { params: { id: randomUUID() }, body: {}, headers: { 'reauth-grant': g } });
  assert.deepEqual([r.status, r.body.code], [404, 'DESK_SALE_NOT_FOUND']);
  assert.deepEqual([none.status, none.body.code], [404, 'DESK_SALE_NOT_FOUND']);
});

test('D-57: the "Ritu Desk" actor is made once, cannot sign in, is not on the staff list, and the database keeps it unusable', async () => {
  const w = await stockWorld('dsactor');
  const item = await retail(w, 'Oil');
  await stock(w, item, 10, day(200));
  on(w);
  await Promise.all([1, 2, 3].map((i) => desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: `L${i}`, itemId: item.id, qtyBase: 1 }]))));
  const rows = await inOrg(w.org.orgId, async (c) => (await c.query(
    `SELECT id, login, active, switch_pin_hash, signing_pin_hash FROM staff_users WHERE system_kind = 'DESK_SYNC'`)).rows);
  assert.equal(rows.length, 1, 'one actor, even when the first three bills arrive at once');
  const actor = rows[0];
  assert.deepEqual([actor.active, actor.switch_pin_hash, actor.signing_pin_hash], [false, null, null]);
  await assert.rejects(signIn(w.org.slug, actor.login, 'anything-at-all'), /sign-in failed: 401/);
  const staff = (await w.owner.call(staffList)).body.items as { id: string }[];
  assert.ok(!staff.some((s) => s.id === actor.id), 'not on the staff list');
  for (const [sql, expect] of [
    ['UPDATE staff_users SET active = true WHERE id = $1', 'staff_users_system_unusable'],
    ["UPDATE staff_users SET switch_pin_hash = 'scrypt$15$8$1$p1$aaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE id = $1", 'staff_users_system_unusable'],
    ['UPDATE staff_users SET system_kind = NULL WHERE id = $1', 'SYSTEM_ACTOR_FIXED'],
    ["UPDATE staff_users SET password_hash = 'scrypt$15$8$1$aaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE id = $1", 'SYSTEM_ACTOR_FIXED'],
  ] as const) {
    const err = await asAppIn(w.org.orgId, sql, [actor.id]);
    assert.equal(err?.constraint ?? err?.hint, expect, sql);
  }
  const person = (await inOrg(w.org.orgId, async (c) => (await c.query('SELECT id FROM staff_users WHERE id = $1', [w.af.id])).rows[0])).id;
  assert.equal((await asAppIn(w.org.orgId, "UPDATE staff_users SET system_kind = 'DESK_SYNC' WHERE id = $1", [person]))?.hint, 'SYSTEM_ACTOR_FIXED', 'a person never becomes one');
});

test('D-57: RLS and the self-check stay green with the new tables (forced RLS, the tenant policy, the guards registered)', async () => {
  const w = await stockWorld('dsrls');
  const item = await retail(w, 'Foam');
  on(w);
  await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 1 }]));
  const other = await createOrg('dsrls2');
  for (const t of ['desk_sale_lines', 'desk_sync_nonces', 'desk_sale_allocations', 'desk_return_lines', 'desk_return_allocations']) {
    const seen = await inOrg(other.orgId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
    assert.equal(seen, 0, `${t}: another tenant sees none`);
  }
  assert.equal(await inOrg(w.org.orgId, async (c) => (await c.query('SELECT count(*)::int AS n FROM desk_sale_lines')).rows[0].n), 1);
  const status = await as('app', (c) => verifySchema(wrap(c)));
  assert.deepEqual(status.failures, []);
  assert.equal(status.ok, true);
});

// ---------------------------------------------------------------- the desk's ordering and refunded short lines

test('E-54: a credit note that arrives before its sale is a retryable 409 storing nothing; after the sale, the retry puts the stock back (net zero)', async () => {
  const w = await stockWorld('dsorder');
  const item = await retail(w, 'Soap');
  const b = await stock(w, item, 10, day(200));
  on(w);
  const billId = randomUUID();
  const creditNoteId = randomUUID();
  const credit = { creditNoteId, billId, lines: [{ lineKey: 'L1', qtyBase: 4 }] };
  for (let i = 0; i < 2; i++) {
    const early = await desk(deskReturnsRoute, 'POST', RETURNS, credit);
    assert.deepEqual([early.status, early.body.code], [409, 'sale_not_received'], 'retryable, not a final rejection');
  }
  const stored = await inOrg(w.org.orgId, async (c) => (await c.query('SELECT count(*)::int AS n FROM desk_return_lines WHERE credit_note_id = $1', [creditNoteId])).rows[0].n);
  assert.equal(stored, 0, 'nothing stored for the early credit');
  // A credit note mixing a known and a not-yet-known line stores neither (one request, one outcome).
  const s = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 4 }], billId));
  assert.equal(s.body.lines[0].status, 'posted');
  assert.equal(await onHand(w, b), 6);
  const mixed = await desk(deskReturnsRoute, 'POST', RETURNS, { creditNoteId: randomUUID(), billId, lines: [{ lineKey: 'L1', qtyBase: 1 }, { lineKey: 'L2', qtyBase: 1 }] });
  assert.deepEqual([mixed.status, mixed.body.code], [409, 'sale_not_received']);
  assert.equal(await onHand(w, b), 6, 'the known line did not move either');
  const late = await desk(deskReturnsRoute, 'POST', RETURNS, credit);
  assert.deepEqual(late.body.lines, [{ lineKey: 'L1', status: 'returned', returnedBase: 4, reason: null }]);
  assert.equal(await onHand(w, b), 10, 'net zero: the sale took 4, the credit put 4 back');
});

test('E-54 / E-56: a credit note on a short line closes it: it leaves the open list, and Retry is refused 409 even after stock arrives', async () => {
  const w = await stockWorld('dscredshort');
  const item = await retail(w, 'Scrub');
  on(w);
  const billId = randomUUID();
  const s = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 3 }], billId));
  assert.equal(s.body.lines[0].status, 'short');
  const line = (await w.owner.call(deskSalesList, { path: '/api/dispensary/desk-sales' })).body.items.find((i: { itemId: string }) => i.itemId === item.id);
  assert.equal(line.status, 'SHORT');
  const credit = await desk(deskReturnsRoute, 'POST', RETURNS, { creditNoteId: randomUUID(), billId, lines: [{ lineKey: 'L1', qtyBase: 3 }] });
  assert.deepEqual(credit.body.lines, [{ lineKey: 'L1', status: 'nothing_to_return', returnedBase: 0, reason: 'not_posted' }]);
  const open = await w.owner.call(deskSalesList, { path: '/api/dispensary/desk-sales' });
  assert.ok(!open.body.items.some((i: { id: string }) => i.id === line.id), 'not listed to fix');
  assert.equal(open.body.open, 0);
  const all = (await w.owner.call(deskSalesList, { path: '/api/dispensary/desk-sales?status=all' })).body.items.find((i: { id: string }) => i.id === line.id);
  assert.deepEqual([all.status, all.reason], ['CANCELLED', 'credited']);
  const b = await stock(w, item, 10, day(200));
  const r = await w.owner.call(deskResolve, { params: { id: line.id }, body: {}, headers: { 'reauth-grant': await grant(w.owner, w.aa, 'stock.adjust', w.main.id) } });
  assert.deepEqual([r.status, r.body.code], [409, 'DESK_SALE_CREDITED']);
  assert.equal(await onHand(w, b), 10, 'no stock went out for the refunded sale');
  assert.equal((await movements(w, item.id)).length, 0);
  const again = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L1', itemId: item.id, qtyBase: 3 }], billId));
  assert.deepEqual(again.body.lines[0], { lineKey: 'L1', status: 'cancelled', allocatedBase: 0, shortBase: 0, reason: 'credited' });
  // The database refuses it too: a credited line never becomes POSTED.
  const err = await asAppIn(w.org.orgId, `UPDATE desk_sale_lines SET status = 'POSTED', allocated_base = qty_base, location_id = $2 WHERE id = $1`, [line.id, w.main.store]);
  assert.ok(err?.hint === 'DESK_SALE_CREDITED' || err?.hint === 'DESK_SALE_FIXED', JSON.stringify(err));
  // A credit on a SHORT line that has not been cancelled yet but already has a return line (a race) is refused too.
  const s2 = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'L2', itemId: item.id, qtyBase: 99 }], billId));
  assert.equal(s2.body.lines[0].status, 'short');
  const l2 = (await w.owner.call(deskSalesList, { path: '/api/dispensary/desk-sales' })).body.items.find((i: { lineKey: string }) => i.lineKey === 'L2');
  const sneak = await asAppIn(w.org.orgId, `INSERT INTO desk_return_lines (org_id, premises_id, credit_note_id, bill_id, line_key, sale_line_id, qty_base, returned_base, status, reason, received_at)
    VALUES ($1, $2, $3, $4, 'L2', $5, 1, 0, 'NOTHING_TO_RETURN', 'not_posted', now())`, [w.org.orgId, w.main.id, randomUUID(), billId, l2.id]);
  assert.equal(sneak, null);
  const guard = await asAppIn(w.org.orgId, `UPDATE desk_sale_lines SET status = 'POSTED', allocated_base = qty_base, short_base = 0, reason = NULL, location_id = $2 WHERE id = $1`,
    [l2.id, w.main.store]);
  assert.equal(guard?.hint, 'DESK_SALE_CREDITED', 'the database never lets a credited line take stock');
  const r2 = await w.owner.call(deskResolve, { params: { id: l2.id }, body: {}, headers: { 'reauth-grant': await grant(w.owner, w.aa, 'stock.adjust', w.main.id) } });
  assert.deepEqual([r2.status, r2.body.code], [409, 'DESK_SALE_CREDITED']);
});

test('D-57: the body is capped at 256 KB while it is read (413, signed or not), and a bad signature costs no database work at all', async () => {
  const w = await stockWorld('dscap');
  const item = await retail(w, 'Talc');
  await stock(w, item, 5, day(200));
  on(w);
  const big = { ...sale([{ lineKey: 'l1', itemId: item.id, qtyBase: 1 }]), serial: 'x'.repeat(300 * 1024) };
  const signed = await desk(deskSalesRoute, 'POST', SALES, big);
  assert.deepEqual([signed.status, signed.body.code], [413, 'BODY_TOO_LARGE'], 'signed, but too large');
  const unsigned = await desk(deskSalesRoute, 'POST', SALES, big, { noSignature: true });
  assert.deepEqual([unsigned.status, unsigned.body.code], [413, 'BODY_TOO_LARGE'], 'refused before the signature is even looked at');
  assert.equal((await movements(w, item.id)).length, 0);
  let queries = 0;
  setQueryListener(() => { queries++; });
  try {
    const bad = await desk(deskSalesRoute, 'POST', SALES, sale([{ lineKey: 'l1', itemId: item.id, qtyBase: 1 }]), { key: 'another-key-of-the-same-length-0123456789xyz' });
    assert.deepEqual([bad.status, bad.body.code], [401, 'bad_signature']);
  } finally {
    setQueryListener(null);
  }
  assert.equal(queries, 0, 'no query (not even the self-check) before the signature holds');
});
