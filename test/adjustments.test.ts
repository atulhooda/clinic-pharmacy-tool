// PR 10a, stock adjustments by count (E-34 count kinds; migration 023; D-53): opening stock on a key
// with no history, count corrections with a reason, signed with the stock.adjust grant; DO-17's
// intent (opening stock never lands on a key that has moved); DE-13; DE-20's adjustment from
// quarantine; DX-62; DK-08 for adjustments; DT-21 (no occurredAt); immutability (L-1, L-12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { inOrg } from './harness/fixtures';
import { asAppIn, asOwnerIn, batch, grant, post, snapshot, stockWorld, type StockWorld } from './harness/stock';
import { setClockForTests } from '../lib/clock';
import { POST as adjPost, GET as adjList } from '../app/api/dispensary/adjustments/route';
import { GET as adjGet } from '../app/api/dispensary/adjustments/[id]/route';
import { GET as itemGet } from '../app/api/dispensary/items/[id]/route';

const T0 = new Date('2026-10-07T04:30:00Z'); // 2026-10-07 10:00 IST

async function adjust(w: StockWorld, body: Record<string, unknown>, opts: { signed?: boolean; key?: string } = {}) {
  const headers: Record<string, string> = { 'idempotency-key': opts.key ?? randomUUID() };
  if (opts.signed !== false) headers['reauth-grant'] = await grant(w.owner, w.aa, 'stock.adjust', (body.premisesId as string) ?? w.main.id);
  return w.owner.call(adjPost, { body: { premisesId: w.main.id, ...body }, headers });
}
const onHand = async (w: StockWorld) => (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body.stock.onHandBase as number;
const movements = (w: StockWorld) => inOrg(w.org.orgId, async (c) => (await c.query(
  `SELECT movement_type AS type, qty_delta AS qty, reason_code AS reason, location_id AS loc FROM stock_movements WHERE org_id = $1 ORDER BY seq`, [w.org.orgId])).rows);

test('a new batch counted on the shelf is opening stock; the batch is created with its MRP; the cache follows', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj1');
    const r = await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'pcm-77', expiry: '06/2028', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 45 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.kind, r.body.reasonCode, r.body.lines.length, r.body.lines[0].qtyDelta, r.body.lines[0].countedBase, r.body.lines[0].batchNo],
      ['OPENING_BALANCE', null, 1, 45, 45, 'PCM-77']);
    assert.deepEqual(await movements(w), [{ type: 'OPENING_BALANCE', qty: 45, reason: null, loc: w.main.store }]);
    assert.equal(await onHand(w), 45);
    const snap = await snapshot(w.org.orgId);
    assert.deepEqual([...snap.cache.values()], [...snap.ledger.values()], 'the cache equals the ledger');
    const list = await w.owner.call(adjList);
    assert.deepEqual(list.body.items.map((a: { id: string; lineCount: number }) => [a.id, a.lineCount]), [[r.body.id, 1]]);
    const audit = await inOrg(w.org.orgId, async (c) => (await c.query('SELECT action, detail FROM audit_log WHERE org_id = $1 AND entity_id = $2', [w.org.orgId, r.body.id])).rows);
    assert.deepEqual(audit, [{ action: 'stock.adjusted', detail: { kind: 'opening_balance', count: 1, reason: null } }]);
  } finally {
    setClockForTests(null);
  }
});

test('DE-13: a count on a batch with history is a correction of the difference, with a reason; equal counts change nothing', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj2');
    const b = await batch(w, { expiry: '2027-12-31' });
    await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 30, batchId: b }]);
    assert.equal((await adjust(w, { lines: [{ itemId: w.pcm.id, batchId: b, countedBase: 28 }] })).body.code, 'REASON_REQUIRED');
    const down = await adjust(w, { reasonCode: 'COUNT_CORRECTION', lines: [{ itemId: w.pcm.id, batchId: b, countedBase: 28 }] });
    assert.equal(down.status, 201, JSON.stringify(down.body));
    assert.deepEqual([down.body.kind, down.body.lines[0].qtyDelta], ['STOCKTAKE_ADJUSTMENT', -2]);
    const up = await adjust(w, { reasonCode: 'FOUND', lines: [{ itemId: w.pcm.id, batchId: b, countedBase: 31 }] });
    assert.deepEqual([up.status, up.body.lines[0].qtyDelta], [201, 3]);
    assert.equal(await onHand(w), 31);
    assert.equal((await adjust(w, { reasonCode: 'COUNT_CORRECTION', lines: [{ itemId: w.pcm.id, batchId: b, countedBase: 31 }] })).body.code, 'NOTHING_TO_CHANGE');
    assert.equal((await adjust(w, { reasonCode: 'OTHER', lines: [{ itemId: w.pcm.id, batchId: b, countedBase: 30 }] })).body.code, 'NOTE_REQUIRED');
    const other = await adjust(w, { reasonCode: 'OTHER', note: 'two strips were in the wrong drawer', lines: [{ itemId: w.pcm.id, batchId: b, countedBase: 0 }] });
    assert.deepEqual([other.status, other.body.lines[0].qtyDelta], [201, -31], 'a count of zero empties the batch');
    assert.equal((await adjust(w, { reasonCode: 'LOST', lines: [{ itemId: w.pcm.id, batchId: b, countedBase: 1 }] })).body.code, 'FIELD_INVALID', 'write-off reasons wait for PR 10');
  } finally {
    setClockForTests(null);
  }
});

test('signed: no grant is 401 reauth_required; a grant for another premises does not count; reception cannot adjust (DI-02)', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj3');
    const line = { itemId: w.glv.id, countedBase: 100 };
    assert.equal((await adjust(w, { lines: [line] }, { signed: false })).body.code, 'reauth_required');
    const wrong = await grant(w.owner, w.aa, 'stock.adjust', w.second.id);
    const r = await w.owner.call(adjPost, { body: { premisesId: w.main.id, lines: [line] }, headers: { 'reauth-grant': wrong, 'idempotency-key': randomUUID() } });
    assert.equal(r.body.code, 'reauth_required');
    const rec = await w.reception.call(adjPost, { body: { premisesId: w.main.id, lines: [line] }, headers: { 'idempotency-key': randomUUID() } });
    assert.equal(rec.status, 403);
    assert.deepEqual(await movements(w), [], 'nothing moved');
    // An untracked item: opening stock at the store, no batch.
    const ok = await adjust(w, { lines: [line] });
    assert.deepEqual([ok.status, ok.body.kind, ok.body.lines[0].batchId], [201, 'OPENING_BALANCE', null]);
    assert.equal((await adjust(w, { lines: [{ ...line, newBatch: { batchNo: 'G1', expiry: '06/2028', mrpPaise: 100, mrpUnitId: w.glv.baseUnitId } }] })).body.code, 'BATCH_NOT_TRACKED');
    assert.equal((await adjust(w, { lines: [{ itemId: w.pcm.id, countedBase: 5 }] })).body.code, 'BATCH_DETAILS_REQUIRED');
  } finally {
    setClockForTests(null);
  }
});

test('D-14 / L-20 / DE-20: expired stock counted goes to quarantine; a count can never take stock out of quarantine', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj4');
    const r = await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'OLD-1', expiry: '08/2026', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 12 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await movements(w), [{ type: 'OPENING_BALANCE', qty: 12, reason: null, loc: w.main.quarantine }]);
    const b = r.body.lines[0].batchId;
    const down = await adjust(w, { reasonCode: 'COUNT_CORRECTION', lines: [{ itemId: w.pcm.id, batchId: b, countedBase: 10 }] });
    assert.deepEqual([down.status, down.body.code], [409, 'QUARANTINED']);
    assert.equal((await movements(w)).length, 1);
  } finally {
    setClockForTests(null);
  }
});

test('DX-62: another organisation\'s batch, item or adjustment is 404 and nothing changes', async () => {
  setClockForTests(T0);
  try {
    const [a, b] = await Promise.all([stockWorld('adj5a'), stockWorld('adj5b')]);
    const theirs = await batch(b, { expiry: '2027-12-31' });
    await post(b, [{ type: 'OPENING_BALANCE', qtyDelta: 30, batchId: theirs }]);
    assert.equal((await adjust(a, { reasonCode: 'COUNT_CORRECTION', lines: [{ itemId: a.pcm.id, batchId: theirs, countedBase: 1 }] })).body.code, 'BATCH_NOT_FOUND');
    assert.equal((await adjust(a, { lines: [{ itemId: b.glv.id, countedBase: 1 }] })).body.code, 'ITEM_NOT_FOUND');
    const mine = await adjust(b, { lines: [{ itemId: b.glv.id, countedBase: 5 }] });
    assert.equal((await a.owner.call(adjGet, { params: { id: mine.body.id } })).status, 404);
    assert.equal((await a.owner.call(adjPost, { body: { premisesId: b.main.id, lines: [{ itemId: b.glv.id, countedBase: 1 }] }, headers: { 'idempotency-key': randomUUID() } })).body.code, 'PREMISES_NOT_FOUND');
    assert.equal((await movements(b)).length, 2, "B's ledger is untouched");
  } finally {
    setClockForTests(null);
  }
});

test('DK-08 / DT-21 / L-1: a replay posts once; no occurredAt; the document and its lines never change', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj6');
    const key = randomUUID();
    const body = { lines: [{ itemId: w.glv.id, countedBase: 200 }] };
    const first = await adjust(w, body, { key });
    const again = await adjust(w, body, { key });
    assert.deepEqual([first.status, again.status, again.body.id], [201, 201, first.body.id]);
    assert.equal((await movements(w)).length, 1);
    assert.equal((await adjust(w, { ...body, occurredAt: '2026-10-06T04:30:00Z' })).body.code, 'UNKNOWN_FIELD');
    assert.equal((await asAppIn(w.org.orgId, "UPDATE stock_adjustments SET note = 'x' WHERE org_id = $1", [w.org.orgId]))?.code, '42501', 'the app has no UPDATE');
    assert.equal((await asAppIn(w.org.orgId, 'DELETE FROM stock_adjustment_lines WHERE org_id = $1', [w.org.orgId]))?.code, '42501');
    assert.equal((await asOwnerIn(w.org.orgId, "UPDATE stock_adjustments SET note = 'x' WHERE org_id = $1", [w.org.orgId]))?.hint, 'LEDGER_APPEND_ONLY');
    assert.equal((await asOwnerIn(w.org.orgId, 'UPDATE stock_adjustment_lines SET qty_delta = 9 WHERE org_id = $1', [w.org.orgId]))?.hint, 'LEDGER_APPEND_ONLY');
    assert.equal((await asOwnerIn(w.org.orgId, 'DELETE FROM stock_adjustments WHERE org_id = $1', [w.org.orgId]))?.hint, 'LEDGER_APPEND_ONLY');
  } finally {
    setClockForTests(null);
  }
});
