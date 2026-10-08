// PR 8 (moved here by D-50): the stock statement, E-45 (D-47): 06b DR-17 … 20 and DX-81. The
// statement reads the ledger only, so the month is seeded through the ledger service, plus one
// delivery posted through the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inOrg } from './harness/fixtures';
import { batch, post, stockWorld, type StockWorld } from './harness/stock';
import { setClockForTests } from '../lib/clock';
import { GET as statementGet } from '../app/api/dispensary/reports/stock-statement/route';
import { statementCsv } from '../lib/stock/statement-export';
import { POST as suppliersPost } from '../app/api/dispensary/suppliers/route';
import { POST as grnsPost } from '../app/api/dispensary/goods-receipts/route';
import { POST as grnPostRoute } from '../app/api/dispensary/goods-receipts/[id]/post/route';

/** An instant in IST: '2026-10-15 23:59' → the UTC Date. */
const ist = (s: string) => new Date(`${s.replace(' ', 'T')}:00+05:30`);
const NOW = ist('2026-10-02 10:00');

interface Row { itemId: string; opening: number; received: number; issued: number; returned: number; other: number; balance: number; quarantined: number }
const cols = (r: Row | undefined) => r && [r.opening, r.received, r.issued, r.returned, r.other, r.balance, r.quarantined];

/**
 * October at the main premises, paracetamol (strip of 15), by hand:
 * opening 42 (30 on the shelf + 12 expired in quarantine), received 45 + 15, issued 10 + 5 − 5 (a reversed
 * dispense) + 2 + 1, returned 3, other −4 (expiry write-off) + 2 (found) → balance 90, of which 8 quarantined.
 * The second premises received 22 on 6 October.
 */
async function month(label: string): Promise<StockWorld> {
  setClockForTests(NOW);
  const w = await stockWorld(label);
  const sup = (await w.owner.call(suppliersPost, { body: { name: `Medline ${label}`, drugLicenceNumbers: ['20B/1'], licenceValidTill: '2028-12-31' } })).body.id;
  const b1 = await batch(w, { no: 'B1', expiry: '2027-03-31' });
  const b2 = await batch(w, { no: 'B2', expiry: '2027-06-30' });
  const q = await batch(w, { no: 'Q', expiry: '2026-08-31' });
  const bs = await batch(w, { premisesId: w.second.id, no: 'S1', expiry: '2027-03-31' });
  await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 12, batchId: q, locationId: w.main.quarantine }], ist('2026-09-01 09:00'));
  await post(w, [{ type: 'OPENING_BALANCE', qtyDelta: 30, batchId: b1 }], ist('2026-09-20 09:00'));
  // 2 October: a real delivery of 3 strips, through the API.
  const d = await w.reception.call(grnsPost, { body: { premisesId: w.main.id, supplierId: sup, invoiceNo: 'OCT-1', invoiceDate: '2026-10-01', lines: [
    { itemId: w.pcm.id, purchaseUnitId: w.pcm.packUnitId, qty: 3, batchNo: 'B1', expiry: '2027-03-31', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId, purchaseRatePaise: 3000,
      manufacturerName: 'M', manufacturerAddress: 'A' }] } });
  assert.equal((await w.reception.call(grnPostRoute, { params: { id: d.body.id }, body: {} })).status, 200);
  await post(w, [{ type: 'DISPENSE', qtyDelta: -10, batchId: b1 }], ist('2026-10-03 11:00'));
  const [late] = await post(w, [{ type: 'DISPENSE', qtyDelta: -5, batchId: b1 }], ist('2026-10-04 11:00'));
  await post(w, [{ type: 'REVERSAL', qtyDelta: 5, batchId: b1, reversesMovementId: late }], ist('2026-10-05 09:00'));
  await post(w, [{ type: 'RECEIPT', qtyDelta: 22, premisesId: w.second.id, locationId: w.second.store, batchId: bs }], ist('2026-10-06 12:00'));
  await post(w, [{ type: 'PATIENT_RETURN', qtyDelta: 3, batchId: b1 }], ist('2026-10-10 16:00'));
  await post(w, [{ type: 'EXPIRY_WRITEOFF', qtyDelta: -4, batchId: q, locationId: w.main.quarantine }], ist('2026-10-12 10:00'));
  await post(w, [{ type: 'DISPENSE', qtyDelta: -2, batchId: b1 }], ist('2026-10-15 23:59'));
  await post(w, [{ type: 'DISPENSE', qtyDelta: -1, batchId: b1 }], ist('2026-10-16 00:01'));
  await post(w, [{ type: 'STOCKTAKE_ADJUSTMENT', qtyDelta: 2, batchId: b2, reasonCode: 'FOUND' }], ist('2026-10-20 10:00'));
  await post(w, [{ type: 'RECEIPT', qtyDelta: 15, batchId: b2 }], ist('2026-10-25 10:00'));
  await post(w, [{ type: 'DISPENSE', qtyDelta: -1, batchId: b2 }], ist('2026-11-02 10:00'));
  return w;
}
const get = (w: StockWorld, b: StockWorld['owner'], qs: string) => b.call(statementGet, { path: `/api/dispensary/reports/stock-statement?${qs}` });
const row = (body: Record<string, unknown>, itemId: string) => (body.rows as Row[]).find((r) => r.itemId === itemId);

test('DR-17: Opening + Received − Issued + Returned + Other = Balance per item, each column as computed by hand; a reversal nets out on its own date', async () => {
  try {
    const w = await month('dr17');
    const r = await get(w, w.owner, `premisesId=${w.main.id}&from=2026-10-01&to=2026-10-31`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(cols(row(r.body, w.pcm.id)), [42, 60, 13, 3, -2, 90, 8]);
    const p = row(r.body, w.pcm.id)!;
    assert.equal(p.opening + p.received - p.issued + p.returned + p.other, p.balance);
    // Balance = Σ qty_delta to the end of 31 October IST.
    const sum = await inOrg(w.org.orgId, async (c) => (await c.query(
      'SELECT sum(qty_delta)::int AS n FROM stock_movements WHERE org_id = $1 AND item_id = $2 AND premises_id = $3 AND occurred_at < $4',
      [w.org.orgId, w.pcm.id, w.main.id, ist('2026-11-01 00:00')])).rows[0].n);
    assert.equal(sum, 90);
    // The reversal on 5 October lowers that day's Issued: 4–4 shows 5 issued, 5–5 shows −5.
    assert.equal(row((await get(w, w.owner, `premisesId=${w.main.id}&from=2026-10-04&to=2026-10-04`)).body, w.pcm.id)!.issued, 5);
    assert.equal(row((await get(w, w.owner, `premisesId=${w.main.id}&from=2026-10-05&to=2026-10-05`)).body, w.pcm.id)!.issued, -5);
    // Gloves never moved and hold nothing: left out unless asked for.
    assert.equal(row(r.body, w.glv.id), undefined);
    assert.deepEqual(cols(row((await get(w, w.owner, `premisesId=${w.main.id}&from=2026-10-01&to=2026-10-31&all=true`)).body, w.glv.id)), [0, 0, 0, 0, 0, 0, 0]);
  } finally {
    setClockForTests(null);
  }
});

test("DR-18: consecutive periods chain: the second's Opening is the first's Balance; the IST day boundary decides", async () => {
  try {
    const w = await month('dr18');
    const a = row((await get(w, w.owner, `premisesId=${w.main.id}&from=2026-10-01&to=2026-10-15`)).body, w.pcm.id)!;
    const b = row((await get(w, w.owner, `premisesId=${w.main.id}&from=2026-10-16&to=2026-10-31`)).body, w.pcm.id)!;
    assert.deepEqual(cols(a), [42, 45, 12, 3, -4, 74, 8], 'the 15 Oct 23:59 IST dispense is in the first half');
    assert.deepEqual(cols(b), [74, 15, 1, 0, 2, 90, 8], 'the 16 Oct 00:01 IST one in the second');
    assert.equal(b.opening, a.balance);
  } finally {
    setClockForTests(null);
  }
});

test('DR-19: without premisesId the owner sees every premises summed; reception sees its own; another premises is 404', async () => {
  try {
    const w = await month('dr19');
    assert.deepEqual(cols(row((await get(w, w.owner, 'from=2026-10-01&to=2026-10-31')).body, w.pcm.id)), [42, 82, 13, 3, -2, 112, 8]);
    const mine = await get(w, w.reception, 'from=2026-10-01&to=2026-10-31');
    assert.deepEqual(cols(row(mine.body, w.pcm.id)), [42, 60, 13, 3, -2, 90, 8]);
    assert.deepEqual(mine.body.premisesNames.length, 1);
    const theirs = await get(w, w.reception, `premisesId=${w.second.id}&from=2026-10-01&to=2026-10-31`);
    assert.deepEqual([theirs.status, theirs.body.code], [404, 'PREMISES_NOT_FOUND']);
    // Periods: at most 366 days, in order, real dates.
    assert.equal((await get(w, w.owner, 'from=2026-01-01&to=2027-01-01')).status, 200);
    assert.deepEqual((await get(w, w.owner, 'from=2026-01-01&to=2027-01-02')).body.code, 'PERIOD_TOO_LONG');
    assert.deepEqual((await get(w, w.owner, 'from=2026-10-31&to=2026-10-01')).body.details, { field: 'to', rule: 'order' });
    assert.deepEqual((await get(w, w.owner, 'from=2026-02-30&to=2026-03-01')).body.details, { field: 'from', rule: 'date' });
    assert.deepEqual((await get(w, w.owner, 'from=2026-10-01&to=2026-10-31&format=pdf')).body.details, { field: 'format', rule: 'enum' });
  } finally {
    setClockForTests(null);
  }
});

test('DR-20: CSV and print carry the same numbers, base units and packs, the premises and the period; each export is audited once', async () => {
  try {
    const w = await month('dr20');
    const qs = `premisesId=${w.main.id}&from=2026-10-01&to=2026-10-31`;
    const audits = () => inOrg(w.org.orgId, async (c) => (await c.query(
      "SELECT detail FROM audit_log WHERE org_id = $1 AND action = 'report.exported' ORDER BY at", [w.org.orgId])).rows.map((r) => r.detail));
    await get(w, w.owner, qs);
    assert.equal((await audits()).length, 0, 'viewing is not exporting');
    const csv = await get(w, w.owner, `${qs}&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /^text\/csv/);
    // Response.text() drops a leading BOM, so the BOM is checked on the builder itself below.
    const text = csv.body.raw as string;
    const lines = text.trim().split('\r\n');
    assert.match(lines[0], /01-10-2026 to 31-10-2026/);
    const pcm = lines.find((l) => l.startsWith('"Paracetamol dr20"'))!;
    assert.equal(pcm, '"Paracetamol dr20","MEDICINE","tablet",42,60,13,3,-2,90,8,"6 strips"');
    const html = (await get(w, w.owner, `${qs}&format=print`)).body.raw as string;
    for (const s of ['Stock statement', 'Main', 'Period 01-10-2026 to 31-10-2026', '6 strips', '>90<', '8 quarantined']) assert.ok(html.includes(s), s);
    assert.ok(html.includes('<thead>'), 'the header block repeats on each printed page');
    const a = await audits();
    assert.deepEqual(a.map((d: { format: string; register: string; count: number }) => `${d.register}/${d.format}/${d.count}`).sort(), ['stock_statement/csv/1', 'stock_statement/print/1']);
    // A cell a spreadsheet would run as a formula is defused; the file starts with a BOM.
    assert.ok(!/(^|,)"[=+@]/.test(text));
    const built = statementCsv({ premisesId: null, premisesNames: ['P'], from: '2026-10-01', to: '2026-10-31', generatedAt: '2026-10-02T04:30:00.000Z',
      rows: [{ itemId: 'x', name: '=HYPERLINK("x")', category: 'MEDICINE', baseUnit: 'TABLET', units: [], opening: 0, received: 1, issued: 0, returned: 0, other: 0, balance: 1, quarantined: 0 }] });
    assert.equal(built.charCodeAt(0), 0xfeff, 'UTF-8 with a BOM');
    assert.ok(built.includes(`"'=HYPERLINK(""x"")"`), 'a formula is defused and quotes doubled');
  } finally {
    setClockForTests(null);
  }
});

test("DX-81: another organisation's premises is 404 like a missing one; the organisation-wide statement holds none of its items", async () => {
  try {
    const A = await month('dx81a');
    const B = await month('dx81b');
    for (const id of [B.main.id, '00000000-0000-4000-8000-000000000000']) {
      const r = await get(A, A.owner, `premisesId=${id}&from=2026-10-01&to=2026-10-31`);
      assert.deepEqual([r.status, r.body.code], [404, 'PREMISES_NOT_FOUND']);
    }
    const all = (await get(A, A.owner, 'from=2026-10-01&to=2026-10-31&all=true')).body.rows.map((r: Row) => r.itemId);
    assert.ok(all.includes(A.pcm.id) && !all.includes(B.pcm.id) && !all.includes(B.glv.id));
  } finally {
    setClockForTests(null);
  }
});
