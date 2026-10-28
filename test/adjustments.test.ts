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
import { POST as detailsPost } from '../app/api/dispensary/adjustments/batch-details/route';
import { POST as writeOffPost } from '../app/api/dispensary/adjustments/write-off/route';
import { GET as itemGet, DELETE as itemDelete } from '../app/api/dispensary/items/[id]/route';
import { POST as reauthRoute } from '../app/api/auth/reauth/route';
import { GET as hintGet } from '../app/api/dispensary/items/[id]/batch-hint/route';
import { POST as grnsPost } from '../app/api/dispensary/goods-receipts/route';
import { POST as suppliersPost } from '../app/api/dispensary/suppliers/route';

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

test('D-53 batch hint: a count reuses the batch, expiry and MRP of the newest bill of the item here; what the bill lacks is null', async () => {
  const w = await stockWorld('adj7');
  const hint = async (premisesId = w.main.id) => w.owner.call(hintGet, { params: { id: w.pcm.id }, path: `/api/dispensary/items/${w.pcm.id}/batch-hint?premisesId=${premisesId}` });
  assert.deepEqual((await hint()).body, { hint: null }, 'no bill yet');
  const sup = await w.owner.call(suppliersPost, { body: { name: 'Hint Distributors adj7', drugLicenceNumbers: ['20B/AHM/0001'] } });
  const d = await w.owner.call(grnsPost, { body: { premisesId: w.main.id, supplierId: sup.body.id, invoiceNo: 'C-1', invoiceDate: '2026-10-06',
    lines: [{ itemId: w.pcm.id, purchaseUnitId: w.pcm.packUnitId, qty: 2, batchNo: 'b-223', expiry: '12/28', purchaseRatePaise: 1440 }] } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.deepEqual((await hint()).body.hint, { batchNo: 'B-223', expiry: '12/28', mrpPaise: null, mrpUnitId: null, supplierName: 'Hint Distributors adj7', invoiceNo: 'C-1' });
  assert.deepEqual((await hint(w.second.id)).body, { hint: null }, 'another premises has its own bills');
  assert.equal((await w.reception.call(hintGet, { params: { id: w.pcm.id }, path: `/api/dispensary/items/${w.pcm.id}/batch-hint?premisesId=${w.second.id}` })).body.code, 'PREMISES_NOT_FOUND');
});

test('D-55: a count with no batch details goes on one placeholder batch per item, shown as pending, never expiring; its number is reserved', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj8');
    const first = await adjust(w, { lines: [{ itemId: w.pcm.id, pendingDetails: true, countedBase: 30 }] });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.kind, first.body.lines[0].qtyDelta, first.body.lines[0].batchNo], ['OPENING_BALANCE', 30, 'DETAILS PENDING']);
    // A second count without details lands on the same placeholder: a correction of the difference.
    const again = await adjust(w, { reasonCode: 'COUNT_CORRECTION', lines: [{ itemId: w.pcm.id, pendingDetails: true, countedBase: 25 }] });
    assert.deepEqual([again.status, again.body.kind, again.body.lines[0].qtyDelta, again.body.lines[0].batchId], [201, 'STOCKTAKE_ADJUSTMENT', -5, first.body.lines[0].batchId]);
    const item = (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body;
    assert.deepEqual([item.stock.onHandBase, item.stock.detailsPending, item.stock.nearExpiry, item.stock.nearestExpiry, item.stock.batches.map((b: { detailsPending: boolean }) => b.detailsPending)],
      [25, true, false, null, [true]]);
    // Nobody can take the reserved number for a real batch, by count or by delivery.
    assert.equal((await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'details  pending', expiry: '06/2028', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 1 }] })).body.code, 'BATCH_NO_RESERVED');
    assert.equal((await adjust(w, { lines: [{ itemId: w.glv.id, pendingDetails: true, countedBase: 1 }] })).body.code, 'BATCH_NOT_TRACKED');
    assert.equal((await adjust(w, { lines: [{ itemId: w.pcm.id, pendingDetails: true, batchId: first.body.lines[0].batchId, countedBase: 1 }] })).body.code, 'FIELD_INVALID');
    assert.equal((await asOwnerIn(w.org.orgId, "UPDATE batches SET details_pending = false WHERE org_id = $1", [w.org.orgId]))?.code, '23514', 'the placeholder stays a placeholder');
  } finally {
    setClockForTests(null);
  }
});

test('D-55 batch details: pending stock moves onto its real batch, part or all; expired goes to quarantine; never more than is pending', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj9');
    await adjust(w, { lines: [{ itemId: w.pcm.id, pendingDetails: true, countedBase: 30 }] });
    const details = async (body: Record<string, unknown>) => w.owner.call(detailsPost, { body: { premisesId: w.main.id, itemId: w.pcm.id, mrpUnitId: w.pcm.packUnitId, mrpPaise: 4500, ...body },
      headers: { 'reauth-grant': await grant(w.owner, w.aa, 'stock.adjust', w.main.id), 'idempotency-key': randomUUID() } });
    const part = await details({ batchNo: 'p-1', expiry: '06/2028', qtyBase: 20 });
    assert.equal(part.status, 201, JSON.stringify(part.body));
    assert.deepEqual([part.body.reasonCode, part.body.lines.map((l: { qtyDelta: number; batchNo: string }) => [l.qtyDelta, l.batchNo])],
      ['BATCH_DETAILS_RECORDED', [[-20, 'DETAILS PENDING'], [20, 'P-1']]]);
    assert.equal((await details({ batchNo: 'p-2', expiry: '06/2028', qtyBase: 11 })).body.code, 'INSUFFICIENT_STOCK', 'only 10 are pending');
    assert.equal((await details({ batchNo: 'Details Pending', expiry: '06/2028' })).body.code, 'BATCH_NO_RESERVED');
    const rest = await details({ batchNo: 'old-9', expiry: '08/2026' });
    assert.deepEqual(rest.body.lines.map((l: { qtyDelta: number; locationName: string }) => l.qtyDelta), [-10, 10]);
    const item = (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body;
    assert.deepEqual([item.stock.onHandBase, item.stock.detailsPending, item.stock.quarantinedBase], [30, false, 10], 'the expired batch went to quarantine');
    assert.equal((await details({ batchNo: 'p-3', expiry: '06/2028' })).body.code, 'NO_PENDING_STOCK');
    assert.equal((await w.reception.call(detailsPost, { body: { premisesId: w.main.id, itemId: w.pcm.id, mrpUnitId: w.pcm.packUnitId, mrpPaise: 4500, batchNo: 'x', expiry: '06/2028' },
      headers: { 'idempotency-key': randomUUID() } })).status, 403);
  } finally {
    setClockForTests(null);
  }
});

test('D-58 write-off: expired stock leaves quarantine for good; an expiry write-off of a good batch is refused; damage takes any; signed', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj10');
    const old = await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'OLD-2', expiry: '08/2026', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 12 }] });
    const good = await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'NEW-2', expiry: '08/2028', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 30 }] });
    const wo = async (body: Record<string, unknown>, signed = true) => w.owner.call(writeOffPost, { body: { premisesId: w.main.id, ...body },
      headers: { 'idempotency-key': randomUUID(), ...(signed ? { 'reauth-grant': await grant(w.owner, w.aa, 'stock.writeoff', w.main.id) } : {}) } });
    const oldBatch = old.body.lines[0].batchId, goodBatch = good.body.lines[0].batchId;
    assert.equal((await wo({ kind: 'EXPIRY_WRITEOFF', reasonCode: 'EXPIRED', lines: [{ itemId: w.pcm.id, batchId: oldBatch }] }, false)).body.code, 'reauth_required');
    assert.equal((await wo({ kind: 'EXPIRY_WRITEOFF', reasonCode: 'DAMAGED', lines: [{ itemId: w.pcm.id, batchId: oldBatch }] })).body.code, 'REASON_REQUIRED');
    const r = await wo({ kind: 'EXPIRY_WRITEOFF', reasonCode: 'EXPIRED', lines: [{ itemId: w.pcm.id, batchId: oldBatch }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.kind, r.body.lines.map((l: { qtyDelta: number }) => l.qtyDelta)], ['EXPIRY_WRITEOFF', [-12]]);
    assert.equal((await wo({ kind: 'EXPIRY_WRITEOFF', reasonCode: 'EXPIRED', lines: [{ itemId: w.pcm.id, batchId: goodBatch, qtyBase: 1 }] })).body.code, 'EXPIRY_WRITEOFF_NOT_EXPIRED');
    const dmg = await wo({ kind: 'DAMAGE_WRITEOFF', reasonCode: 'BROKEN_OR_SPILLED', lines: [{ itemId: w.pcm.id, batchId: goodBatch, qtyBase: 5 }] });
    assert.deepEqual([dmg.status, dmg.body.lines[0].qtyDelta], [201, -5]);
    assert.equal((await wo({ kind: 'DAMAGE_WRITEOFF', reasonCode: 'LOST', lines: [{ itemId: w.pcm.id, batchId: goodBatch, qtyBase: 26 }] })).body.code, 'INSUFFICIENT_STOCK');
    const item = (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body;
    assert.deepEqual([item.stock.onHandBase, item.stock.expiredBase, item.stock.quarantinedBase], [25, 0, 0]);
    assert.equal((await w.reception.call(writeOffPost, { body: { premisesId: w.main.id, kind: 'DAMAGE_WRITEOFF', reasonCode: 'LOST', lines: [{ itemId: w.pcm.id, batchId: goodBatch }] },
      headers: { 'idempotency-key': randomUUID() } })).status, 403);
  } finally {
    setClockForTests(null);
  }
});

test('D-60 edit details: a real batch with a wrong expiry moves onto the corrected batch; unchanged details are refused', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj11');
    const r = await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'E-1', expiry: '06/2027', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 30 }] });
    const from = r.body.lines[0].batchId;
    const edit = async (body: Record<string, unknown>) => w.owner.call(detailsPost, { body: { premisesId: w.main.id, itemId: w.pcm.id, mrpUnitId: w.pcm.packUnitId, mrpPaise: 4500, fromBatchId: from, ...body },
      headers: { 'reauth-grant': await grant(w.owner, w.aa, 'stock.adjust', w.main.id), 'idempotency-key': randomUUID() } });
    assert.equal((await edit({ batchNo: 'E-1', expiry: '06/2027' })).body.code, 'NOTHING_TO_CHANGE');
    const ok = await edit({ batchNo: 'E-1', expiry: '06/2029' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.reasonCode, ok.body.lines.map((l: { qtyDelta: number }) => l.qtyDelta)], ['BATCH_DETAILS_CORRECTED', [-30, 30]]);
    const item = (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body;
    assert.deepEqual(item.stock.batches.filter((b: { onHandBase: number }) => b.onHandBase > 0).map((b: { expiryDate: string; onHandBase: number }) => [b.expiryDate, b.onHandBase]), [['2029-06-30', 30]]);
  } finally {
    setClockForTests(null);
  }
});

test('D-61: an expiry typed wrong (stock in quarantine) is corrected onto the shelf; other counts still cannot leave quarantine', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj12');
    const r = await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'Q-1', expiry: '03/2026', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 15 }] });
    const from = r.body.lines[0].batchId;
    assert.equal((await adjust(w, { reasonCode: 'COUNT_CORRECTION', lines: [{ itemId: w.pcm.id, batchId: from, countedBase: 10 }] })).body.code, 'QUARANTINED');
    const ok = await w.owner.call(detailsPost, { body: { premisesId: w.main.id, itemId: w.pcm.id, mrpUnitId: w.pcm.packUnitId, mrpPaise: 4500, fromBatchId: from, batchNo: 'Q-1', expiry: '03/2028' },
      headers: { 'reauth-grant': await grant(w.owner, w.aa, 'stock.adjust', w.main.id), 'idempotency-key': randomUUID() } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const item = (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body;
    assert.deepEqual([item.stock.onHandBase, item.stock.quarantinedBase, item.stock.expiredBase, item.stock.dispensableBase], [15, 0, 0, 15]);
    assert.equal((await asOwnerIn(w.org.orgId, `INSERT INTO stock_movements (org_id, premises_id, item_id, batch_id, location_id, movement_type, qty_delta, reference_type, reference_id, reason_code, actor_staff_id, actor_label, occurred_at, recorded_at)
      SELECT $1, $2, $3, $4, $5, 'STOCKTAKE_ADJUSTMENT', -1, 'STOCK_ADJUSTMENT_LINE', gen_random_uuid(), 'COUNT_CORRECTION', $6, 'x', now(), now()`,
      [w.org.orgId, w.main.id, w.pcm.id, from, w.main.quarantine, w.aa.id]))?.hint, 'QUARANTINED', 'the database still refuses any other count out of quarantine');
  } finally {
    setClockForTests(null);
  }
});

test('delete a medicine: needs a signature for that item; stock to 0 (shelf counted out, quarantine written off); off the list', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('adj13');
    await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'D-1', expiry: '06/2028', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 30 }] });
    await adjust(w, { lines: [{ itemId: w.pcm.id, newBatch: { batchNo: 'D-OLD', expiry: '03/2026', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId }, countedBase: 5 }] });
    const del = async (headers: Record<string, string> = {}) => w.owner.call(itemDelete, { method: 'DELETE', params: { id: w.pcm.id }, headers: { 'idempotency-key': randomUUID(), ...headers } });
    assert.equal((await del()).body.code, 'reauth_required', 'no signature, no delete');
    const wrongEntity = await grant(w.owner, w.aa, 'stock.adjust', w.main.id);
    assert.equal((await del({ 'reauth-grant': wrongEntity })).body.code, 'reauth_required', 'a grant for the premises is not one for this item');
    const r = await w.owner.call(reauthRoute, { body: { password: w.aa.password, purpose: 'stock.adjust', entityId: w.pcm.id } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ok = await del({ 'reauth-grant': r.body.grantId });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const item = (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body;
    assert.deepEqual([item.active, item.stock.onHandBase], [false, 0]);
    assert.equal((await w.reception.call(itemDelete, { method: 'DELETE', params: { id: w.glv.id }, headers: { 'idempotency-key': randomUUID() } })).status, 403);
  } finally {
    setClockForTests(null);
  }
});

test('D-64: with a clinic delete password set, only it deletes (not the login password); wrong ones lock out after 5', async () => {
  setClockForTests(T0);
  const { hashPassword } = await import('../lib/auth/password');
  process.env.ITEM_DELETE_PASSWORD_HASH = await hashPassword('synthetic-delete-pass-1');
  try {
    const w = await stockWorld('adj14');
    const del = (id: string, body: Record<string, unknown>) => w.owner.call(itemDelete, { method: 'DELETE', params: { id }, body, headers: { 'idempotency-key': randomUUID() } });
    assert.equal((await del(w.glv.id, { deletePassword: w.aa.password })).body.code, 'WRONG_DELETE_PASSWORD', 'the login password is not the delete password');
    const ok = await del(w.glv.id, { deletePassword: 'synthetic-delete-pass-1' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await w.owner.call(itemGet, { params: { id: w.glv.id } })).body.active, false);
    for (let i = 0; i < 4; i++) await del(w.pcm.id, { deletePassword: 'nope' });
    assert.equal((await del(w.pcm.id, { deletePassword: 'nope' })).body.code, 'WRONG_DELETE_PASSWORD');
    assert.equal((await del(w.pcm.id, { deletePassword: 'synthetic-delete-pass-1' })).body.code, 'TOO_MANY_TRIES', 'locked for 15 minutes after 5 wrong');
  } finally {
    delete process.env.ITEM_DELETE_PASSWORD_HASH;
    setClockForTests(null);
  }
});
