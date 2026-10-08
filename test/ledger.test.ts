// PR 7, the ledger (06a §6.6, §7, §8; migrations 019–021): 06b DL-01 … 10, 12 … 14, 17, 21 … 23,
// the movement halves of DL-28 and DL-29, and the L-3b/L-7 guards; DA-01 … 08; DP-01 … 07 and
// DP-10 over the ledger's own operations (receipts, opening balances, FEFO draws, write-offs,
// count corrections, reversals; DP-08 and DP-12 need returns and prescriptions: PRs 9 and 10);
// the catalogue's stock reads E-12 (balance, filters), E-14 (batches) and E-18 (history), DX-43.
// DL-11, DL-15, DL-16, DL-24 … 27 and DL-30 need the dispensing documents (PRs 9, 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import fc from 'fast-check';
import { as, connect, pgCode } from './harness/env';
import { wrap } from '../lib/db/db';
import { inOrg } from './harness/fixtures';
import { asAppIn, asOwnerIn, batch, createItem, post, snapshot, stockWorld, type StockWorld } from './harness/stock';
import { setClockForTests, now, istDate, addDays } from '../lib/clock';
import { withTenant } from '../lib/db/tenant';
import { allocate, allocateLines, isInsufficient, type BatchStock } from '../lib/stock/allocate';
import { candidatesAt, lockBalances, postMovements, resolveBatch } from '../lib/stock/ledger';
import { setLogSink } from '../lib/log';
import { GET as itemsGet } from '../app/api/dispensary/items/route';
import { GET as itemGet } from '../app/api/dispensary/items/[id]/route';
import { GET as movementsGet } from '../app/api/dispensary/items/[id]/movements/route';

const T0 = new Date('2026-10-07T04:30:00Z'); // 2026-10-07 10:00 IST (06b §2)
const MOVE_COLS = `org_id, premises_id, item_id, batch_id, location_id, movement_type, qty_delta, reference_type, reference_id,
                   reason_code, note, actor_staff_id, actor_label, occurred_at, recorded_at, reverses_movement_id`;
/** A direct-SQL movement (the DL rows bypass the service on purpose). */
function sqlMove(w: StockWorld, m: { premisesId?: string; itemId?: string; batchId?: string | null; locationId?: string; type: string; qty: number;
  refType?: string; reason?: string | null; note?: string | null; reverses?: string | null; at?: Date; recordedAt?: Date }): [string, unknown[]] {
  const at = m.at ?? now();
  return [`INSERT INTO stock_movements (${MOVE_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'T', $13, $14, $15)`,
    [w.org.orgId, m.premisesId ?? w.main.id, m.itemId ?? w.pcm.id, m.batchId === undefined ? null : m.batchId, m.locationId ?? w.main.store, m.type, m.qty,
      m.refType ?? ({ DISPENSE: 'DISPENSE_ALLOCATION', RECEIPT: 'GOODS_RECEIPT_LINE', REVERSAL: 'STOCK_REVERSAL', SUPPLIER_RETURN: 'SUPPLIER_RETURN_LINE' } as Record<string, string>)[m.type] ?? 'STOCK_ADJUSTMENT_LINE',
      randomUUID(), m.reason === undefined ? null : m.reason, m.note ?? null, w.aa.id, at, m.recordedAt ?? at, m.reverses ?? null]];
}
const app = (w: StockWorld, m: Parameters<typeof sqlMove>[1]) => asAppIn(w.org.orgId, ...sqlMove(w, m));
const onHand = async (w: StockWorld, batchId: string | null, locationId = w.main.store, itemId = w.pcm.id) =>
  inOrg(w.org.orgId, async (c) => (await c.query('SELECT on_hand FROM stock_balances WHERE org_id = $1 AND item_id = $2 AND location_id = $3 AND batch_id IS NOT DISTINCT FROM $4',
    [w.org.orgId, itemId, locationId, batchId])).rows[0]?.on_hand ?? 0) as Promise<number>;

// ---------------------------------------------------------------- DL: DB enforcement

test('DL-01 / DL-02 / DL-05: the ledger is append-only for every role; the app cannot truncate it', async () => {
  const w = await stockWorld('dl1');
  const b = await batch(w, { expiry: '2027-03-31' });
  const [id] = await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 30, batchId: b }]);
  assert.equal((await asAppIn(w.org.orgId, 'UPDATE stock_movements SET qty_delta = 99 WHERE org_id = $1 AND id = $2', [w.org.orgId, id]))?.code, '42501');
  assert.equal((await asOwnerIn(w.org.orgId, 'UPDATE stock_movements SET qty_delta = 99 WHERE org_id = $1 AND id = $2', [w.org.orgId, id]))?.hint, 'LEDGER_APPEND_ONLY');
  assert.equal((await asAppIn(w.org.orgId, 'DELETE FROM stock_movements WHERE org_id = $1 AND id = $2', [w.org.orgId, id]))?.code, '42501');
  assert.equal((await asOwnerIn(w.org.orgId, 'DELETE FROM stock_movements WHERE org_id = $1 AND id = $2', [w.org.orgId, id]))?.hint, 'LEDGER_APPEND_ONLY');
  assert.equal((await asAppIn(w.org.orgId, 'TRUNCATE stock_movements'))?.code, '42501');
  assert.equal((await asAppIn(w.org.orgId, 'TRUNCATE stock_balances'))?.code, '42501');
  // The app never writes the cache itself.
  assert.equal((await asAppIn(w.org.orgId, 'UPDATE stock_balances SET on_hand = 999 WHERE org_id = $1', [w.org.orgId]))?.code, '42501');
  assert.equal(await onHand(w, b), 30, 'the row is unchanged');
});

test('DL-03: deleting an item with movements is refused by the FK; nothing cascades', async () => {
  const w = await stockWorld('dl3');
  const b = await batch(w, { expiry: '2027-03-31' });
  await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 5, batchId: b }]);
  assert.equal((await asOwnerIn(w.org.orgId, 'DELETE FROM items WHERE org_id = $1 AND id = $2', [w.org.orgId, w.pcm.id]))?.code, '23503');
  assert.equal(await onHand(w, b), 5);
});

test('DL-04: a direct insert that would take on_hand to −1 fails the CHECK and rolls back', async () => {
  const w = await stockWorld('dl4');
  const b = await batch(w, { expiry: '2027-03-31' });
  await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 2, batchId: b }]);
  const e = await app(w, { type: 'DISPENSE', qty: -3, batchId: b });
  assert.deepEqual([e?.code, e?.constraint], ['23514', 'stock_balances_on_hand']);
  // A new key starting below zero fails too.
  const b2 = await batch(w, { expiry: '2027-04-30' });
  assert.equal((await app(w, { type: 'DISPENSE', qty: -1, batchId: b2 }))?.constraint, 'stock_balances_on_hand');
  assert.equal(await onHand(w, b), 2);
  const n = await inOrg(w.org.orgId, async (c) => (await c.query("SELECT count(*)::int AS n FROM stock_movements WHERE org_id = $1 AND movement_type = 'DISPENSE'", [w.org.orgId])).rows[0].n);
  assert.equal(n, 0, 'no movement survived');
  // Taking it exactly to zero is fine, and the row stays.
  assert.equal(await app(w, { type: 'DISPENSE', qty: -2, batchId: b }), null);
  assert.equal(await onHand(w, b), 0);
});

test('DL-06 / DL-07 / DL-08: sign per type; a reason where required; OTHER needs a note', async () => {
  const w = await stockWorld('dl6');
  const b = await batch(w, { expiry: '2027-03-31' });
  await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 10, batchId: b }]);
  assert.deepEqual((({ code, constraint }) => [code, constraint])((await app(w, { type: 'DISPENSE', qty: 5, batchId: b }))!), ['23514', 'stock_movements_sign']);
  assert.equal((await app(w, { type: 'RECEIPT', qty: -1, batchId: b }))?.constraint, 'stock_movements_sign');
  assert.equal((await app(w, { type: 'DAMAGE_WRITEOFF', qty: -1, batchId: b }))?.constraint, 'stock_movements_reason');
  assert.equal((await app(w, { type: 'DAMAGE_WRITEOFF', qty: -1, batchId: b, reason: 'OTHER' }))?.constraint, 'stock_movements_reason_note');
  assert.equal(await app(w, { type: 'DAMAGE_WRITEOFF', qty: -1, batchId: b, reason: 'OTHER', note: 'dropped in the sink' }), null);
  // The reference type must suit the movement (§7.1).
  assert.equal((await app(w, { type: 'DISPENSE', qty: -1, batchId: b, refType: 'GOODS_RECEIPT_LINE' }))?.constraint, 'stock_movements_reference');
  assert.equal((await app(w, { type: 'OPENING_BALANCE', qty: 0, batchId: b }))?.constraint, 'stock_movements_nonzero');
});

test('DL-09: a tracked item needs a batch; an untracked one must not have one', async () => {
  const w = await stockWorld('dl9');
  const b = await batch(w, { expiry: '2027-03-31' });
  assert.equal((await app(w, { type: 'OPENING_BALANCE', qty: 1, batchId: null }))?.hint, 'BATCH_TRACKING_MISMATCH');
  assert.equal((await app(w, { type: 'OPENING_BALANCE', qty: 1, itemId: w.glv.id, batchId: b }))?.code, 'P0001');
  assert.equal(await app(w, { type: 'OPENING_BALANCE', qty: 1, itemId: w.glv.id, batchId: null }), null);
});

test("DL-10 / DL-28 / DL-29: no movement or balance names another tenant's or another premises' batch or location", async () => {
  const A = await stockWorld('dl10a');
  const B = await stockWorld('dl10b');
  const bA = await batch(A, { expiry: '2027-03-31' });
  const bB = await batch(B, { expiry: '2027-03-31' });
  const bAmh = await batch(A, { premisesId: A.second.id, expiry: '2027-03-31' });
  // DL-10, as the migrator (past RLS visibility): A's movement naming B's batch.
  assert.equal((await asOwnerIn(A.org.orgId, ...sqlMove(A, { type: 'OPENING_BALANCE', qty: 1, batchId: bB })))?.code, '23503');
  // DL-28 (movement half): a dispense at main naming the second premises' batch row.
  assert.equal((await app(A, { type: 'OPENING_BALANCE', qty: 1, batchId: bAmh }))?.code, '23503');
  // DL-29: the main store with the second premises' batch, as a movement and as a balance row.
  assert.equal((await app(A, { type: 'OPENING_BALANCE', qty: 1, premisesId: A.second.id, batchId: bAmh, locationId: A.main.store }))?.code, '23503');
  assert.equal((await asOwnerIn(A.org.orgId, `INSERT INTO stock_balances (org_id, premises_id, item_id, batch_id, location_id, on_hand, last_movement_seq)
    VALUES ($1, $2, $3, $4, $5, 0, 0)`, [A.org.orgId, A.main.id, A.pcm.id, bAmh, A.main.store]))?.code, '23503');
  assert.equal(await app(A, { type: 'OPENING_BALANCE', qty: 1, batchId: bA }), null, 'the control row is fine');
});

test('DL-12 / DL-13 / DL-14: one movement per line and type; one reversal per movement, mirroring it', async () => {
  const w = await stockWorld('dl12');
  const b = await batch(w, { expiry: '2027-03-31' });
  const b2 = await batch(w, { expiry: '2027-04-30' });
  const ref = randomUUID();
  const [first] = await post(w, [{ type: 'RECEIPT', qtyDelta: 10, batchId: b, referenceId: ref }]);
  await post(w, [{ type: 'RECEIPT', qtyDelta: 10, batchId: b2 }]);
  await assert.rejects(post(w, [{ type: 'RECEIPT', qtyDelta: 10, batchId: b, referenceId: ref }]), { code: 'ALREADY_POSTED' });
  // DL-14: the wrong qty, the wrong batch, reversing a reversal.
  await assert.rejects(post(w, [{ type: 'REVERSAL', qtyDelta: -9, batchId: b, reversesMovementId: first }]), { code: 'REVERSAL_MISMATCH' });
  await assert.rejects(post(w, [{ type: 'REVERSAL', qtyDelta: -10, batchId: b2, reversesMovementId: first }]), { code: 'REVERSAL_MISMATCH' });
  const [rev] = await post(w, [{ type: 'REVERSAL', qtyDelta: -10, batchId: b, reversesMovementId: first }]);
  await assert.rejects(post(w, [{ type: 'REVERSAL', qtyDelta: 10, batchId: b, reversesMovementId: rev }]), { code: 'REVERSAL_MISMATCH' });
  // DL-13: a second reversal of the same movement.
  await post(w, [{ type: 'RECEIPT', qtyDelta: 10, batchId: b }]);
  await assert.rejects(post(w, [{ type: 'REVERSAL', qtyDelta: -10, batchId: b, reversesMovementId: first }]), { code: 'ALREADY_REVERSED' });
  assert.equal(await onHand(w, b), 10);
});

test('DL-17 / L-13: unit factors never change; an item with movements keeps its identity, one without may still change', async () => {
  const w = await stockWorld('dl17');
  const b = await batch(w, { expiry: '2027-03-31' });
  await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 1, batchId: b }]);
  assert.equal((await asAppIn(w.org.orgId, 'UPDATE item_units SET base_units_per_unit = 10 WHERE org_id = $1 AND id = $2', [w.org.orgId, w.pcm.packUnitId]))?.hint, 'UNIT_IMMUTABLE');
  for (const set of ["track_batches = false, category = 'CONSUMABLE'", "base_unit = 'CAPSULE'"]) {
    assert.equal((await asAppIn(w.org.orgId, `UPDATE items SET ${set} WHERE org_id = $1 AND id = $2`, [w.org.orgId, w.pcm.id]))?.hint, 'ITEM_IDENTITY_LOCKED', set);
  }
  assert.equal(await asAppIn(w.org.orgId, "UPDATE items SET rack_location = 'A3' WHERE org_id = $1 AND id = $2", [w.org.orgId, w.pcm.id]), null, 'other fields still change');
  const fresh = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Unmoved dl17', baseUnit: 'TABLET' });
  assert.equal(await asAppIn(w.org.orgId, "UPDATE items SET base_unit = 'CAPSULE' WHERE org_id = $1 AND id = $2", [w.org.orgId, fresh.id]), null);
});

test('DL-21 / DL-22 / DL-23 / L-20: quarantine is a one-way door to disposal', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('dl21');
    const q = await batch(w, { no: 'PCM-Q', expiry: '2026-08-31' });
    await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 12, batchId: q, locationId: w.main.quarantine }]);
    assert.equal((await app(w, { type: 'DISPENSE', qty: -1, batchId: q, locationId: w.main.quarantine }))?.hint, 'BATCH_EXPIRED');
    const fresh = await batch(w, { no: 'PCM-FRESH', expiry: '2027-12-31' });
    await post(w, [{ type: 'PATIENT_RETURN', qtyDelta: 3, batchId: fresh, locationId: w.main.quarantine }]);
    assert.equal((await app(w, { type: 'DISPENSE', qty: -1, batchId: fresh, locationId: w.main.quarantine }))?.hint, 'QUARANTINED', 'DL-21');
    assert.equal((await app(w, { type: 'STOCKTAKE_ADJUSTMENT', qty: -1, batchId: q, locationId: w.main.quarantine, reason: 'COUNT_CORRECTION' }))?.hint, 'QUARANTINED', 'DL-22');
    for (const [type, reason] of [['EXPIRY_WRITEOFF', 'EXPIRED'], ['DAMAGE_WRITEOFF', 'DAMAGED'], ['SUPPLIER_RETURN', 'EXPIRED']]) {
      assert.equal(await app(w, { type, qty: -1, batchId: q, locationId: w.main.quarantine, reason }), null, `DL-23 ${type}`);
    }
    // Stock can still come INTO quarantine: a count correction upward.
    assert.equal(await app(w, { type: 'STOCKTAKE_ADJUSTMENT', qty: 1, batchId: q, locationId: w.main.quarantine, reason: 'FOUND' }), null);
    assert.equal(await onHand(w, q, w.main.quarantine), 10);
  } finally {
    setClockForTests(null);
  }
});

test('L-7 / §11.3: expiry is checked on the IST date of occurred_at; corrections are never blocked', async () => {
  const w = await stockWorld('dl7');
  const today = await batch(w, { no: 'EXP-TODAY', expiry: '2026-10-07' });
  const at = (iso: string) => ({ at: new Date(iso) });
  await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 10, batchId: today }], new Date('2026-10-07T04:30:00Z'));
  // Usable at 23:59:59 IST on its expiry date; blocked from 00:00:00 IST the next day (18:30:00Z).
  assert.equal(await app(w, { type: 'DISPENSE', qty: -1, batchId: today, ...at('2026-10-07T18:29:59Z') }), null);
  assert.equal((await app(w, { type: 'DISPENSE', qty: -1, batchId: today, ...at('2026-10-07T18:30:00Z') }))?.hint, 'BATCH_EXPIRED');
  assert.equal((await app(w, { type: 'RECEIPT', qty: 5, batchId: today, ...at('2026-10-07T18:30:00Z') }))?.hint, 'BATCH_EXPIRED', 'expired goods are not received');
  assert.equal((await app(w, { type: 'EXPIRY_WRITEOFF', qty: -1, batchId: today, reason: 'EXPIRED', ...at('2026-10-07T18:29:59Z') }))?.hint, 'EXPIRY_WRITEOFF_NOT_EXPIRED');
  assert.equal(await app(w, { type: 'EXPIRY_WRITEOFF', qty: -1, batchId: today, reason: 'EXPIRED', ...at('2026-10-07T18:30:00Z') }), null);
  assert.equal(await app(w, { type: 'DAMAGE_WRITEOFF', qty: -1, batchId: today, reason: 'DAMAGED', ...at('2026-10-08T05:00:00Z') }), null, 'corrections on expired stock are allowed');
  assert.equal(await app(w, { type: 'STOCKTAKE_ADJUSTMENT', qty: -1, batchId: today, reason: 'COUNT_CORRECTION', ...at('2026-10-08T05:00:00Z') }), null);
  // D-14: expired stock entered as an opening balance belongs in quarantine.
  const old = await batch(w, { no: 'EXP-OLD', expiry: '2026-09-30' });
  assert.equal((await app(w, { type: 'OPENING_BALANCE', qty: 3, batchId: old, ...at('2026-10-07T04:30:00Z') }))?.hint, 'OPENING_EXPIRED_NOT_QUARANTINED');
  assert.equal(await app(w, { type: 'OPENING_BALANCE', qty: 3, batchId: old, locationId: w.main.quarantine, ...at('2026-10-07T04:30:00Z') }), null);
});

test('L-3b and the time CHECKs: no future dating, at most 7 days back, and a backdated draw never makes history negative', async () => {
  const w = await stockWorld('dl3b');
  const b = await batch(w, { expiry: '2027-03-31' });
  const t = new Date('2026-10-07T04:30:00Z');
  const h = (n: number) => new Date(t.getTime() + n * 3600_000);
  await post(w, [{ type: 'RECEIPT', qtyDelta: 5, batchId: b }], t);
  assert.equal((await app(w, { type: 'DISPENSE', qty: -1, batchId: b, at: h(1), recordedAt: t }))?.constraint, 'stock_movements_not_future');
  assert.equal((await app(w, { type: 'DISPENSE', qty: -1, batchId: b, at: h(-24 * 8), recordedAt: t }))?.constraint, 'stock_movements_backdate_cap');
  // A draw recorded now but dated before the receipt: the running balance would dip below zero then.
  assert.equal((await app(w, { type: 'DISPENSE', qty: -1, batchId: b, at: h(-2), recordedAt: h(1) }))?.hint, 'INSUFFICIENT_STOCK_AS_OF');
  assert.equal(await app(w, { type: 'DISPENSE', qty: -1, batchId: b, at: h(0.5), recordedAt: h(1) }), null, 'after the receipt it is fine');
});

test('DL-19 (service half): every guard reached through postMovements is a mapped 4xx with one ledger_backstop_fired line', async () => {
  const w = await stockWorld('dl19');
  const b = await batch(w, { expiry: '2027-03-31' });
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try {
    await assert.rejects(post(w, [{ type: 'DISPENSE', qtyDelta: -1, batchId: b }]), (e: { status: number; code: string }) => e.status === 409 && e.code === 'INSUFFICIENT_STOCK');
    await assert.rejects(post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 1, batchId: null }]), (e: { status: number; code: string }) => e.status === 422 && e.code === 'BATCH_TRACKING_MISMATCH');
  } finally {
    restore();
  }
  const fired = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'ledger_backstop_fired');
  assert.equal(fired.length, 2);
  assert.deepEqual(Object.keys(fired[0]).sort(), ['batchId', 'event', 'guard', 'itemId', 'referenceId', 'ts'], 'ids and the guard only');
});

test('§9.1 step 4: lockBalances locks every balance row of each (item, location), in the global order, as the app role', async () => {
  const w = await stockWorld('lock');
  const [b1, b2] = [await batch(w, { expiry: '2027-03-31' }), await batch(w, { expiry: '2027-04-30' })];
  await post(w, [{ type: 'RECEIPT', qtyDelta: 5, batchId: b1 }, { type: 'RECEIPT', qtyDelta: 5, batchId: b2 }]);
  await post(w, [{ type: 'DISPENSE', qtyDelta: -5, batchId: b1 }]);
  await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 7, itemId: w.glv.id, batchId: null }]);
  const keys = [{ itemId: w.pcm.id, locationId: w.main.store }, { itemId: w.glv.id, locationId: w.main.store }, { itemId: w.pcm.id, locationId: w.main.store }];
  const holder = await connect('app');
  const other = await connect('app');
  try {
    await holder.query('BEGIN');
    await holder.query("SELECT set_config('app.org_id', $1, true)", [w.org.orgId]);
    const rows = await lockBalances(wrap(holder), w.org.orgId, keys);
    // Every row, the zero one included, in (item, location, batch) order.
    const expected = [[w.pcm.id, b1, 0], [w.pcm.id, b2, 5], [w.glv.id, null, 7]].sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])) || (a[1] === null ? -1 : b[1] === null ? 1 : String(a[1]).localeCompare(String(b[1]))));
    assert.deepEqual(rows.map((r) => [r.itemId, r.batchId, r.onHand]), expected);
    // Another transaction cannot take them while they are held.
    await other.query('BEGIN');
    await other.query("SELECT set_config('app.org_id', $1, true)", [w.org.orgId]);
    await other.query("SET LOCAL lock_timeout = '200ms'");
    assert.equal(await pgCode(lockBalances(wrap(other), w.org.orgId, [keys[1]])), '55P03');
    await other.query('ROLLBACK');
    await holder.query('COMMIT');
  } finally {
    await holder.end();
    await other.end();
  }
  // The app may lock, never write the balance.
  assert.equal((await asAppIn(w.org.orgId, 'UPDATE stock_balances SET on_hand = 999 WHERE org_id = $1', [w.org.orgId]))?.code, '42501');
});

// ---------------------------------------------------------------- DA: allocate() is a pure function

const c = (batchId: string | null, expiryDate: string | null, available: number, batchSeq = 1): BatchStock => ({ batchId, expiryDate, available, batchSeq });

test('DA-01 … DA-07: FEFO, ties by receipt then id, expired skipped, untracked, shared pools', () => {
  assert.deepEqual(allocate([], 5, '2026-10-07'), { insufficient: true, availableNonExpired: 0, expiredOnHand: 0 }, 'DA-01');
  const three = [c('c', '2027-03-31', 30, 3), c('a', '2026-12-31', 15, 1), c('b', '2027-01-31', 10, 2)];
  assert.deepEqual(allocate(three, 55, '2026-10-07'), [{ batchId: 'a', qtyBase: 15 }, { batchId: 'b', qtyBase: 10 }, { batchId: 'c', qtyBase: 30 }], 'DA-02');
  assert.deepEqual(allocate([c('x', '2027-01-31', 5, 9), c('y', '2027-01-31', 5, 2)], 3, '2026-10-07'), [{ batchId: 'y', qtyBase: 3 }], 'DA-03');
  assert.deepEqual(allocate([c('m', '2027-01-31', 5, 2), c('k', '2027-01-31', 5, 2)], 3, '2026-10-07'), [{ batchId: 'k', qtyBase: 3 }], 'DA-04');
  assert.deepEqual(allocate([c('old', '2026-09-30', 15), c('ok', '2026-12-31', 4)], 5, '2026-10-07'),
    { insufficient: true, availableNonExpired: 4, expiredOnHand: 15 }, 'DA-05');
  assert.deepEqual(allocate([c('today', '2026-10-07', 2)], 2, '2026-10-07'), [{ batchId: 'today', qtyBase: 2 }], 'usable through its expiry date');
  assert.deepEqual(allocate([c(null, null, 200)], 7, '2026-10-07'), [{ batchId: null, qtyBase: 7 }], 'DA-06');
  const [l1, l2, l3] = allocateLines([c('a', '2026-12-31', 15, 1), c('b', '2027-01-31', 10, 2)], [10, 10, 10], '2026-10-07');
  assert.deepEqual([l1, l2], [[{ batchId: 'a', qtyBase: 10 }], [{ batchId: 'a', qtyBase: 5 }, { batchId: 'b', qtyBase: 5 }]], 'DA-07');
  assert.ok(isInsufficient(l3) && l3.availableNonExpired === 5);
  assert.throws(() => allocate(three, 0, '2026-10-07'), RangeError);
});

test('DA-08: a quarantine location never yields candidates (the service filter)', async () => {
  const w = await stockWorld('da8');
  const q = await batch(w, { expiry: '2027-03-31' });
  await post(w, [{ type: 'PATIENT_RETURN', qtyDelta: 5, batchId: q, locationId: w.main.quarantine }]);
  const s = await batch(w, { expiry: '2027-04-30' });
  await post(w, [{ type: 'RECEIPT', qtyDelta: 7, batchId: s }]);
  await withTenant(w.org.orgId, async (db) => {
    assert.deepEqual(await candidatesAt(db, w.org.orgId, w.pcm.id, w.main.quarantine), []);
    const store = await candidatesAt(db, w.org.orgId, w.pcm.id, w.main.store);
    assert.deepEqual(store.map((x) => [x.batchId, x.available]), [[s, 7]]);
  });
});

test('resolveBatch: the same number and expiry is one batch per premises; a different MRP per base unit is BATCH_MRP_MISMATCH', async () => {
  const w = await stockWorld('rb');
  await withTenant(w.org.orgId, async (db) => {
    const base = { itemId: w.pcm.id, batchNo: ' pcm  2312 ', expiryDate: '2027-03-31', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId! };
    const one = await resolveBatch(db, w.org.orgId, { ...base, premisesId: w.main.id });
    assert.equal(one.created, true);
    const again = await resolveBatch(db, w.org.orgId, { ...base, premisesId: w.main.id, batchNo: 'PCM 2312', mrpPaise: 300, mrpUnitId: w.pcm.baseUnitId });
    assert.deepEqual(again, { id: one.id, created: false }, 'the same MRP per tablet, entered per tablet');
    await assert.rejects(resolveBatch(db, w.org.orgId, { ...base, premisesId: w.main.id, mrpPaise: 4800 }), { code: 'BATCH_MRP_MISMATCH' });
    const other = await resolveBatch(db, w.org.orgId, { ...base, premisesId: w.second.id });
    assert.notEqual(other.id, one.id, 'batches are per premises (D-31)');
    const row = (await db.rows<{ no: string }>('SELECT batch_no AS no FROM batches WHERE org_id = $1 AND id = $2', [w.org.orgId, one.id]))[0];
    assert.equal(row.no, 'PCM 2312', 'normalised');
  });
});

// ---------------------------------------------------------------- DP: property tests over the ledger's operations

type Op =
  | { k: 'receive'; batch: number; qty: number }
  | { k: 'opening'; batch: number; qty: number }
  | { k: 'draw'; qty: number }
  | { k: 'writeoff'; batch: number; qty: number }
  | { k: 'count'; batch: number; delta: number }
  | { k: 'reverse'; pick: number }
  | { k: 'tick'; days: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ k: fc.constant('receive' as const), batch: fc.nat(3), qty: fc.integer({ min: 1, max: 40 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('opening' as const), batch: fc.nat(3), qty: fc.integer({ min: 1, max: 20 }) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('draw' as const), qty: fc.integer({ min: 1, max: 45 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('writeoff' as const), batch: fc.nat(3), qty: fc.integer({ min: 1, max: 10 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('count' as const), batch: fc.nat(3), delta: fc.integer({ min: -8, max: 8 }).filter((d) => d !== 0) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('reverse' as const), pick: fc.nat(1000) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('tick' as const), days: fc.integer({ min: 1, max: 40 }) }) },
);

interface Posted { id: string; type: string; qty: number; batchId: string; locationId: string; at: Date }

test('DP-01 … DP-07, DP-10: after every step the cache equals the ledger, nothing is ever negative, FEFO holds, rejections change nothing, the cache rebuilds', async () => {
  const w = await stockWorld('dp');
  let run = 0;
  await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 8, maxLength: 24 }), async (ops) => {
    run++;
    // Each run uses its own item and batches, so runs never interfere.
    const item = await createItem(w.owner, { category: 'MEDICINE', displayName: `DP item ${run}`, baseUnit: 'TABLET' }, { name: 'strip', factor: 10 });
    const expiries = ['2026-10-20', '2026-11-30', '2027-01-31', '2027-06-30'];
    const batches = await Promise.all(expiries.map((e, i) => batch(w, { item, no: `DP${run}-${i}`, expiry: e })));
    let clock = new Date('2026-10-07T04:30:00Z');
    const posted: Posted[] = [];
    const reversed = new Set<string>();
    const keyOf = (b: string, l: string) => `${w.main.id}/${item.id}/${b}/${l}`;
    const expired = (b: string, at: Date) => expiries[batches.indexOf(b)] < istDate(at);
    const actor = { orgId: w.org.orgId, staffUserId: w.aa.id, name: w.aa.name };
    const tryPost = async (ms: Parameters<typeof postMovements>[3]): Promise<string[] | null> => {
      const before = await snapshot(w.org.orgId);
      try {
        return await withTenant(w.org.orgId, (db) => postMovements(db, actor, { occurredAt: clock, recordedAt: clock }, ms));
      } catch (err) {
        assert.ok((err as { status?: number }).status && (err as { status: number }).status < 500, `a rejection is a 4xx: ${String(err)}`);
        assert.deepEqual(await snapshot(w.org.orgId), before, 'DP-02: a rejected operation leaves the snapshot identical');
        return null;
      }
    };
    const mv = (type: string, qty: number, b: string, l = w.main.store, extra: Record<string, unknown> = {}) => ({
      premisesId: w.main.id, itemId: item.id, batchId: b, locationId: l, type: type as never, qtyDelta: qty,
      referenceType: ({ RECEIPT: 'GOODS_RECEIPT_LINE', DISPENSE: 'DISPENSE_ALLOCATION', REVERSAL: 'STOCK_REVERSAL' } as Record<string, string>)[type] ?? 'STOCK_ADJUSTMENT_LINE',
      referenceId: randomUUID(), reasonCode: ({ DAMAGE_WRITEOFF: 'DAMAGED', STOCKTAKE_ADJUSTMENT: 'COUNT_CORRECTION', REVERSAL: 'DATA_ENTRY_ERROR' } as Record<string, string>)[type] ?? null, ...extra });

    for (const op of ops) {
      if (op.k === 'tick') { clock = new Date(clock.getTime() + op.days * 86400_000); continue; }
      if (op.k === 'receive' || op.k === 'opening') {
        const b = batches[op.batch];
        const loc = op.k === 'opening' && expired(b, clock) ? w.main.quarantine : w.main.store;
        const ids = await tryPost([mv(op.k === 'receive' ? 'RECEIPT' : 'OPENING_BALANCE', op.qty, b, loc)]);
        if (op.k === 'receive' && expired(b, clock)) assert.equal(ids, null, 'expired goods are not received');
        if (ids) posted.push({ id: ids[0], type: op.k === 'receive' ? 'RECEIPT' : 'OPENING_BALANCE', qty: op.qty, batchId: b, locationId: loc, at: clock });
      } else if (op.k === 'draw') {
        const cands = await withTenant(w.org.orgId, (db) => candidatesAt(db, w.org.orgId, item.id, w.main.store));
        const shuffled = [...cands].reverse();
        const r = allocate(cands, op.qty, istDate(clock));
        assert.deepEqual(allocate(shuffled, op.qty, istDate(clock)), r, 'DP-04: deterministic, whatever the input order');
        if (isInsufficient(r)) {
          assert.ok(r.availableNonExpired < op.qty);
          continue;
        }
        // DP-07: FEFO-optimal: nothing later than an eligible batch that was not used up.
        for (const a of r) {
          const ca = cands.find((x) => x.batchId === a.batchId)!;
          for (const other of cands) {
            if (other.batchId === a.batchId || other.available <= 0 || (other.expiryDate ?? '') < istDate(clock)) continue;
            const used = r.find((x) => x.batchId === other.batchId)?.qtyBase ?? 0;
            const earlier = (other.expiryDate ?? '') < (ca.expiryDate ?? '') || (other.expiryDate === ca.expiryDate && other.batchSeq < ca.batchSeq);
            assert.ok(!earlier || used === other.available, 'DP-07');
          }
        }
        const ids = await tryPost(r.map((a) => mv('DISPENSE', -a.qtyBase, a.batchId!)));
        assert.ok(ids, 'a draw within what allocate allowed always posts');
        r.forEach((a, i) => posted.push({ id: ids![i], type: 'DISPENSE', qty: -a.qtyBase, batchId: a.batchId!, locationId: w.main.store, at: clock }));
      } else if (op.k === 'writeoff') {
        const ids = await tryPost([mv('DAMAGE_WRITEOFF', -op.qty, batches[op.batch])]);
        if (ids) posted.push({ id: ids[0], type: 'DAMAGE_WRITEOFF', qty: -op.qty, batchId: batches[op.batch], locationId: w.main.store, at: clock });
      } else if (op.k === 'count') {
        const ids = await tryPost([mv('STOCKTAKE_ADJUSTMENT', op.delta, batches[op.batch])]);
        if (ids) posted.push({ id: ids[0], type: 'STOCKTAKE_ADJUSTMENT', qty: op.delta, batchId: batches[op.batch], locationId: w.main.store, at: clock });
      } else if (op.k === 'reverse') {
        const open = posted.filter((p) => p.type !== 'REVERSAL' && !reversed.has(p.id));
        if (open.length === 0) continue;
        const target = open[op.pick % open.length];
        const key = keyOf(target.batchId, target.locationId);
        const before = (await snapshot(w.org.orgId)).cache.get(key) ?? 0;
        const ids = await tryPost([mv('REVERSAL', -target.qty, target.batchId, target.locationId, { reversesMovementId: target.id })]);
        if (ids) {
          reversed.add(target.id);
          posted.push({ id: ids[0], type: 'REVERSAL', qty: -target.qty, batchId: target.batchId, locationId: target.locationId, at: clock });
          // DP-03: the key is back where it was before the original, plus every unrelated movement since.
          const after = (await snapshot(w.org.orgId)).cache.get(key) ?? 0;
          assert.equal(after, before - target.qty, 'DP-03');
        } else {
          assert.ok(before - target.qty < 0, 'a reversal is refused only when the stock is no longer there');
        }
      }
      // DP-01 and DP-02 after every step.
      const snap = await snapshot(w.org.orgId);
      assert.deepEqual(snap.cache, snap.ledger, 'DP-01: the cache equals Σ qty_delta per key');
      for (const v of snap.cache.values()) assert.ok(v >= 0, 'DP-02: never negative now');
    }
    await withTenant(w.org.orgId, async (db) => {
      // DP-02 as of any past time: the running balance per key, ordered by (occurred_at, seq).
      const dips = await db.rows(`SELECT 1 FROM (SELECT sum(qty_delta) OVER (PARTITION BY batch_id, location_id ORDER BY occurred_at, seq) AS r
                                                   FROM stock_movements WHERE org_id = $1 AND item_id = $2) x WHERE r < 0`, [w.org.orgId, item.id]);
      assert.equal(dips.length, 0, 'DP-02: never negative at any point in history');
      // DP-05: no use of expired stock.
      const bad = await db.rows(`SELECT 1 FROM stock_movements m JOIN batches b ON b.org_id = m.org_id AND b.id = m.batch_id
                                  WHERE m.org_id = $1 AND m.item_id = $2 AND m.movement_type = 'DISPENSE' AND b.expiry_date < ist_date(m.occurred_at)`, [w.org.orgId, item.id]);
      assert.equal(bad.length, 0, 'DP-05');
      // DP-10: nothing left quarantine except by the L-20 types.
      const out = await db.rows(`SELECT 1 FROM stock_movements m JOIN stock_locations l ON l.org_id = m.org_id AND l.id = m.location_id
                                  WHERE m.org_id = $1 AND l.kind = 'QUARANTINE' AND m.qty_delta < 0
                                    AND m.movement_type NOT IN ('EXPIRY_WRITEOFF','DAMAGE_WRITEOFF','SUPPLIER_RETURN','REVERSAL')`, [w.org.orgId]);
      assert.equal(out.length, 0, 'DP-10');
    });
  }), { numRuns: 12 });

  // DP-06: the migrator drops this organisation's cache and rebuild_balances restores it exactly.
  const before = await snapshot(w.org.orgId);
  assert.ok(before.cache.size > 0);
  await as('migrator', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [w.org.orgId]);
    await c.query('DELETE FROM stock_balances WHERE org_id = $1', [w.org.orgId]);
    await c.query('SELECT rebuild_balances()');
    await c.query('COMMIT');
  });
  const rebuilt = await snapshot(w.org.orgId);
  // A key that went back to zero keeps its row in the cache; the rebuild recreates it from the ledger.
  assert.deepEqual(rebuilt.cache, before.cache, 'DP-06');
  assert.equal((await as('app', (c) => c.query('SELECT rebuild_balances()').then(() => 'ok', (e) => e.code))), '42501', 'only the migrator runs the rebuild');
});

// ---------------------------------------------------------------- E-12 / E-14 / E-18 and DX-43

test('E-12 / E-14 (D-47): each item shows its balance; dispensable excludes expired and quarantined stock; filters for low stock and near expiry', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('e12');
    const old = await batch(w, { no: 'PCM-OLD', expiry: '2026-09-30' });
    const dec = await batch(w, { no: 'PCM-DEC', expiry: '2026-12-31' });
    const soon = await batch(w, { no: 'PCM-SOON', expiry: '2026-10-20' });
    const q = await batch(w, { no: 'PCM-Q', expiry: '2026-08-31' });
    await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 15, batchId: old }], new Date('2026-09-01T03:30:00Z'));
    await post(w, [{ type: 'RECEIPT', qtyDelta: 15, batchId: dec }, { type: 'RECEIPT', qtyDelta: 4, batchId: soon },
      { type: 'OPENING_BALANCE', qtyDelta: 12, batchId: q, locationId: w.main.quarantine }]);
    await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 250, itemId: w.glv.id, batchId: null }]);
    // Fresh stock in quarantine (a return set aside) is not dispensable either.
    const ret = await batch(w, { no: 'PCM-RET', expiry: '2027-12-31' });
    await post(w, [{ type: 'PATIENT_RETURN', qtyDelta: 3, batchId: ret, locationId: w.main.quarantine }]);
    // Exactly at the reorder level is not low.
    const exact = await createItem(w.owner, { category: 'CONSUMABLE', displayName: 'Exact e12', baseUnit: 'PIECE', trackBatches: false, reorderLevel: 10 });
    await post(w, [{ type: 'RECEIPT', qtyDelta: 10, itemId: exact.id, batchId: null }]);
    const list = (await w.owner.call(itemsGet, { path: `/api/dispensary/items?premisesId=${w.main.id}` })).body.items as { id: string; stock: Record<string, unknown> }[];
    const pcm = list.find((i) => i.id === w.pcm.id)!;
    assert.deepEqual(pcm.stock, { onHandBase: 49, dispensableBase: 19, quarantinedBase: 15, expiredBase: 27, nearestExpiry: '2026-10-20', lowStock: true, nearExpiry: true });
    assert.equal(list.find((i) => i.id === exact.id)!.stock.lowStock, false, 'at the level is not below it');
    assert.deepEqual(list.find((i) => i.id === w.glv.id)!.stock.onHandBase, 250);
    const only = async (qs: string) => ((await w.owner.call(itemsGet, { path: `/api/dispensary/items?${qs}` })).body.items as { id: string }[]).map((i) => i.id);
    assert.deepEqual(await only(`lowStock=true&premisesId=${w.main.id}`), [w.pcm.id], 'below its reorder level of 20 at main (19 dispensable); gloves have no level');
    assert.deepEqual(await only('nearExpiry=true'), [w.pcm.id]);
    assert.equal((await w.owner.call(itemsGet, { path: '/api/dispensary/items?lowStock=maybe' })).body.code, 'FIELD_INVALID');
    // Per premises: the second premises holds none of it, so it is low there too.
    const second = (await w.owner.call(itemsGet, { path: `/api/dispensary/items?premisesId=${w.second.id}` })).body.items as { id: string; stock: { onHandBase: number; lowStock: boolean } }[];
    assert.deepEqual([second.find((i) => i.id === w.pcm.id)!.stock.onHandBase, second.find((i) => i.id === w.pcm.id)!.stock.lowStock], [0, true]);
    // Reception at main only: the second premises is 404, like a missing one (MR-19).
    const r = await w.reception.call(itemsGet, { path: `/api/dispensary/items?premisesId=${w.second.id}` });
    assert.deepEqual([r.status, r.body.code], [404, 'PREMISES_NOT_FOUND']);
    // E-14: batches with their balances per location, expired flagged.
    const one = (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body;
    assert.equal(one.stock.onHandBase, 49);
    assert.deepEqual(one.stock.batches.map((b: { batchNo: string; onHandBase: number; expired: boolean; mrpUnitName: string }) => [b.batchNo, b.onHandBase, b.expired, b.mrpUnitName]),
      [['PCM-Q', 12, true, 'strip'], ['PCM-OLD', 15, true, 'strip'], ['PCM-SOON', 4, false, 'strip'], ['PCM-DEC', 15, false, 'strip'], ['PCM-RET', 3, false, 'strip']]);
    assert.deepEqual(one.stock.batches[0].locations.map((l: { kind: string }) => l.kind), ['QUARANTINE']);
    const glv = (await w.owner.call(itemGet, { params: { id: w.glv.id } })).body;
    assert.deepEqual(glv.stock.untracked.map((u: { onHandBase: number; kind: string }) => [u.onHandBase, u.kind]), [[250, 'STORE']]);
  } finally {
    setClockForTests(null);
  }
});

test('E-18 / DX-43: the ledger history at the caller\'s premises, newest first, paged; no patient field; another organisation\'s item is 404', async () => {
  const w = await stockWorld('e18');
  const B = await stockWorld('e18b');
  const b = await batch(w, { expiry: '2027-03-31' });
  const bs = await batch(w, { premisesId: w.second.id, expiry: '2027-03-31' });
  const t = (h: number) => new Date(Date.UTC(2026, 9, 7, 4, 30) + h * 3600_000);
  await post(w, [{ type: 'RECEIPT', qtyDelta: 30, batchId: b }], t(0));
  await post(w, [{ type: 'DISPENSE', qtyDelta: -2, batchId: b }], t(1));
  await post(w, [{ type: 'DAMAGE_WRITEOFF', qtyDelta: -1, batchId: b, reasonCode: 'BROKEN_OR_SPILLED' }], t(2));
  await post(w, [{ type: 'RECEIPT', qtyDelta: 5, premisesId: w.second.id, locationId: w.second.store, batchId: bs }], t(3));
  const all = (await w.owner.call(movementsGet, { params: { id: w.pcm.id }, path: `/api/dispensary/items/${w.pcm.id}/movements` })).body;
  assert.deepEqual(all.items.map((m: { type: string; qtyDelta: number }) => [m.type, m.qtyDelta]), [['RECEIPT', 5], ['DAMAGE_WRITEOFF', -1], ['DISPENSE', -2], ['RECEIPT', 30]]);
  const allowed = ['id', 'type', 'qtyDelta', 'premisesId', 'locationId', 'locationName', 'batchId', 'batchNo', 'expiryDate', 'referenceType', 'referenceId',
    'reasonCode', 'note', 'actorLabel', 'occurredAt', 'recordedAt', 'reversesMovementId'];
  for (const m of all.items) assert.deepEqual(Object.keys(m).sort(), [...allowed].sort(), 'no patient field and no seq');
  // Paging.
  const p1 = (await w.owner.call(movementsGet, { params: { id: w.pcm.id }, path: `/api/dispensary/items/${w.pcm.id}/movements?limit=3` })).body;
  const p2 = (await w.owner.call(movementsGet, { params: { id: w.pcm.id }, path: `/api/dispensary/items/${w.pcm.id}/movements?limit=3&cursor=${p1.nextCursor}` })).body;
  assert.deepEqual([...p1.items, ...p2.items].map((m: { id: string }) => m.id), all.items.map((m: { id: string }) => m.id));
  assert.equal(p2.nextCursor, null);
  // Reception at main only sees main's history; the second premises is 404 for them.
  const mine = (await w.reception.call(movementsGet, { params: { id: w.pcm.id }, path: `/api/dispensary/items/${w.pcm.id}/movements` })).body.items;
  assert.equal(mine.length, 3);
  const theirs = await w.reception.call(movementsGet, { params: { id: w.pcm.id }, path: `/api/dispensary/items/${w.pcm.id}/movements?premisesId=${w.second.id}` });
  assert.deepEqual([theirs.status, theirs.body.code], [404, 'PREMISES_NOT_FOUND']);
  // DX-43: org B's item is 404, identical to a missing one.
  for (const id of [B.pcm.id, '00000000-0000-4000-8000-000000000000']) {
    const r = await w.owner.call(movementsGet, { params: { id }, path: `/api/dispensary/items/${id}/movements` });
    assert.deepEqual([r.status, r.body.code], [404, 'ITEM_NOT_FOUND']);
  }
  void addDays;
});
