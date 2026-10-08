// PR 8, receiving stock (E-23 … E-26; migration 022): 06b DO-01 … 03 and DO-04's first half (the
// second, "allowed after the first is reversed", needs reversals: PR 10); DM-04 … 06; MR-08/09 for
// receipts; DU-16; DL-19's API half; DL-25; DK-08 (the GRN post); DC-07; DX-46 … 49.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { as } from './harness/env';
import { inOrg } from './harness/fixtures';
import { Browser } from './harness/http';
import { asAppIn, asOwnerIn, createItem, grant, stockWorld, type StockWorld } from './harness/stock';
import { setClockForTests } from '../lib/clock';
import { setLogSink } from '../lib/log';
import { faults, parseExpiry } from '../lib/stock/receipts';
import { GET as grnsGet, POST as grnsPost } from '../app/api/dispensary/goods-receipts/route';
import { GET as grnGet, PATCH as grnPatch } from '../app/api/dispensary/goods-receipts/[id]/route';
import { POST as grnPostRoute } from '../app/api/dispensary/goods-receipts/[id]/post/route';
import { POST as grnDiscard } from '../app/api/dispensary/goods-receipts/[id]/discard/route';
import { POST as suppliersPost } from '../app/api/dispensary/suppliers/route';
import { GET as itemGet } from '../app/api/dispensary/items/[id]/route';
import { PUT as premisesSettingsPut } from '../app/api/dispensary/premises/[id]/settings/route';
import { GET as dPremisesGet } from '../app/api/dispensary/premises/route';

const T0 = new Date('2026-10-07T04:30:00Z'); // 2026-10-07 10:00 IST
const MFR = { manufacturerName: 'Synthetic Labs', manufacturerAddress: '9 Industrial Estate, Gujarat' };

async function supplier(b: Browser, name: string, opts: { licences?: string[]; validTill?: string | null } = {}): Promise<string> {
  const r = await b.call(suppliersPost, { body: { name, drugLicenceNumbers: opts.licences ?? ['20B/AHM/0001', '21B/AHM/0001'], licenceValidTill: opts.validTill === undefined ? '2028-12-31' : opts.validTill } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
const pcmLine = (w: StockWorld, extra: Record<string, unknown> = {}) => ({ itemId: w.pcm.id, purchaseUnitId: w.pcm.packUnitId, qty: 2, freeQty: 0,
  batchNo: 'pcm-2312', expiry: '12/2026', mrpPaise: 4500, mrpUnitId: w.pcm.packUnitId, purchaseRatePaise: 3200, discountPaise: 0, gstRateBp: 500, ...MFR, ...extra });
async function draft(w: StockWorld, b: Browser, supplierId: string, lines: unknown[], extra: Record<string, unknown> = {}) {
  return b.call(grnsPost, { body: { premisesId: w.main.id, supplierId, invoiceNo: `INV-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-10-06', lines, ...extra } });
}
const postIt = (b: Browser, id: string, headers: Record<string, string> = {}) => b.call(grnPostRoute, { params: { id }, body: {}, headers });
const movements = (w: StockWorld) => inOrg(w.org.orgId, async (c) => (await c.query("SELECT count(*)::int AS n FROM stock_movements WHERE org_id = $1 AND movement_type = 'RECEIPT'", [w.org.orgId])).rows[0].n as number);

test('§11.3: expiry as printed: MM/YYYY is the last day of the month; full dates as they are', () => {
  assert.deepEqual(parseExpiry('03/2027'), { date: '2027-03-31', printed: '03/2027' });
  assert.deepEqual(parseExpiry('02/2028'), { date: '2028-02-29', printed: '02/2028' });
  assert.deepEqual(parseExpiry('11/27'), { date: '2027-11-30', printed: '11/27' });
  assert.deepEqual(parseExpiry('2027-06-15'), { date: '2027-06-15', printed: null });
  for (const bad of ['13/2027', '2027-02-30', 'soon', '0/27']) assert.equal(parseExpiry(bad), null, bad);
});

test('DO-01 / DU-16: a draft posts: a RECEIPT per line in base units (free goods included), batches created, the supplier snapshotted, frozen', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('do1');
    const sup = await supplier(w.owner, 'Medline Distributors do1');
    const d = await draft(w, w.reception, sup, [pcmLine(w, { qty: 2, freeQty: 1 }), { itemId: w.glv.id, purchaseUnitId: w.glv.packUnitId, qty: 2, purchaseRatePaise: 50000 }]);
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.deepEqual([d.body.status, d.body.lines.length, d.body.checks.errors], ['DRAFT', 2, []]);
    assert.equal(await movements(w), 0, 'a draft moves nothing');
    const p = await postIt(w.reception, d.body.id);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.grn.status, 'POSTED');
    assert.deepEqual(p.body.grn.lines.map((l: { receivedBase: number }) => l.receivedBase), [45, 200], '(2 + 1 free) strips of 15; 2 boxes of 100');
    const [batch] = await inOrg(w.org.orgId, async (c) => (await c.query('SELECT batch_no, expiry_date::text AS e, expiry_as_printed AS p, mrp_paise::int AS mrp, manufacturer_address_snapshot AS a FROM batches WHERE org_id = $1', [w.org.orgId])).rows);
    assert.deepEqual(batch, { batch_no: 'PCM-2312', e: '2026-12-31', p: '12/2026', mrp: 4500, a: MFR.manufacturerAddress });
    const snap = await inOrg(w.org.orgId, async (c) => (await c.query('SELECT supplier_name_snapshot AS n, supplier_licence_numbers_snapshot AS l, received_at = posted_at AS same FROM goods_receipts WHERE org_id = $1 AND id = $2', [w.org.orgId, d.body.id])).rows[0]);
    assert.deepEqual(snap, { n: 'Medline Distributors do1', l: ['20B/AHM/0001', '21B/AHM/0001'], same: true });
    const item = (await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body;
    assert.equal(item.stock.onHandBase, 45);
    // Frozen: the API refuses edits and a second post; the DB refuses direct changes.
    assert.deepEqual([(await w.reception.call(grnPatch, { method: 'PATCH', params: { id: d.body.id }, body: { notes: 'late' } })).body.code], ['GRN_NOT_DRAFT']);
    assert.equal((await postIt(w.reception, d.body.id)).body.code, 'GRN_NOT_DRAFT');
    assert.equal((await asAppIn(w.org.orgId, "UPDATE goods_receipts SET notes = 'x' WHERE org_id = $1 AND id = $2", [w.org.orgId, d.body.id]))?.hint, 'GRN_NOT_DRAFT');
    assert.equal((await asAppIn(w.org.orgId, 'UPDATE goods_receipt_lines SET qty = 99 WHERE org_id = $1', [w.org.orgId]))?.code, '42501', 'the app has no UPDATE on lines');
    assert.equal((await asOwnerIn(w.org.orgId, 'UPDATE goods_receipt_lines SET qty = 99 WHERE org_id = $1', [w.org.orgId]))?.hint, 'LEDGER_APPEND_ONLY', 'nor does the owner, past the trigger');
    assert.equal((await asOwnerIn(w.org.orgId, 'DELETE FROM goods_receipts WHERE org_id = $1 AND id = $2', [w.org.orgId, d.body.id]))?.hint, 'LEDGER_APPEND_ONLY');
    const audit = await inOrg(w.org.orgId, async (c) => (await c.query("SELECT action FROM audit_log WHERE org_id = $1 AND entity_id = $2 ORDER BY at", [w.org.orgId, d.body.id])).rows.map((r) => r.action));
    assert.deepEqual(audit.sort(), ['grn.created', 'grn.posted'], 'the clock is pinned, so both rows share a time');
  } finally {
    setClockForTests(null);
  }
});

test('DO-02 / DO-03 / DO-04: an existing batch is reused; a different MRP is 409; an invoice posts once per supplier', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('do2');
    const sup = await supplier(w.owner, 'Medline do2');
    const first = await draft(w, w.reception, sup, [pcmLine(w)], { invoiceNo: 'MD/123' });
    assert.equal((await postIt(w.reception, first.body.id)).status, 200);
    // The same batch, its MRP given per tablet (300 × 15 = 4500 per strip): reused.
    const again = await draft(w, w.reception, sup, [pcmLine(w, { qty: 1, mrpPaise: 300, mrpUnitId: w.pcm.baseUnitId, batchNo: '  pcm-2312 ' })]);
    const p2 = await postIt(w.reception, again.body.id);
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    const batches = await inOrg(w.org.orgId, async (c) => (await c.query('SELECT count(*)::int AS n FROM batches WHERE org_id = $1', [w.org.orgId])).rows[0].n);
    assert.equal(batches, 1);
    assert.equal((await w.owner.call(itemGet, { params: { id: w.pcm.id } })).body.stock.onHandBase, 45);
    const dearer = await draft(w, w.reception, sup, [pcmLine(w, { mrpPaise: 4800 })]);
    assert.deepEqual(dearer.body.checks.errors, [{ code: 'BATCH_MRP_MISMATCH', lineNo: 1 }], 'the draft shows it before posting');
    const r3 = await postIt(w.reception, dearer.body.id);
    assert.deepEqual([r3.status, r3.body.code], [409, 'BATCH_MRP_MISMATCH']);
    const dup = await draft(w, w.reception, sup, [pcmLine(w)], { invoiceNo: 'md/123' });
    assert.deepEqual(dup.body.checks.errors, [{ code: 'DUPLICATE_INVOICE' }], 'the draft says so before posting');
    const r4 = await postIt(w.reception, dup.body.id);
    assert.deepEqual([r4.status, r4.body.code], [409, 'DUPLICATE_INVOICE']);
    // Another supplier may use the same invoice number.
    const other = await supplier(w.owner, 'Other do2');
    assert.equal((await postIt(w.reception, (await draft(w, w.reception, other, [pcmLine(w)], { invoiceNo: 'MD/123' })).body.id)).status, 200);
    assert.equal(await movements(w), 3, 'the refused posts moved nothing');
  } finally {
    setClockForTests(null);
  }
});

test('DM-04 / DM-05 / DM-06: at an RMP premises the supplier needs a licence (an expired one warns) and a medicine its manufacturer and address', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('dm4');
    const lic = await supplier(w.owner, 'Licensed dm4');
    const nolic = await supplier(w.owner, 'Local Traders dm4', { licences: [], validTill: null });
    const lapsed = await supplier(w.owner, 'Lapsed dm4', { validTill: '2026-01-01' });
    const r1 = await postIt(w.reception, (await draft(w, w.reception, nolic, [pcmLine(w)])).body.id);
    assert.deepEqual([r1.status, r1.body.code], [422, 'SUPPLIER_LICENCE_MISSING']);
    const r2 = await postIt(w.reception, (await draft(w, w.reception, lapsed, [pcmLine(w)])).body.id);
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body.warnings, [{ code: 'SUPPLIER_LICENCE_EXPIRED' }]);
    // DM-06: a custom medicine with no manufacturer address anywhere.
    const noMfr = pcmLine(w, { manufacturerName: null, manufacturerAddress: null, batchNo: 'NOMFR' });
    const r3 = await postIt(w.reception, (await draft(w, w.reception, lic, [noMfr])).body.id);
    assert.deepEqual([r3.status, r3.body.code, r3.body.details.lineNo], [422, 'MANUFACTURER_DETAILS_MISSING', 1]);
    // A name without an address is not enough either (the bills print a maker's short name only).
    const nameOnly = pcmLine(w, { manufacturerAddress: null, batchNo: 'NAMEONLY' });
    const r3b = await postIt(w.reception, (await draft(w, w.reception, lic, [nameOnly])).body.id);
    assert.deepEqual([r3b.status, r3b.body.code], [422, 'MANUFACTURER_DETAILS_MISSING']);
    // The item's own details count; so do a master row's (line → item → master).
    const withMfr = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Custom with maker dm4', baseUnit: 'TABLET', customManufacturerName: 'A Maker', customManufacturerAddress: '1 Road' });
    const ok1 = await postIt(w.reception, (await draft(w, w.reception, lic, [{ itemId: withMfr.id, purchaseUnitId: withMfr.baseUnitId, qty: 10, batchNo: 'A1', expiry: '06/2027', mrpPaise: 100, mrpUnitId: withMfr.baseUnitId, purchaseRatePaise: 50 }])).body.id);
    assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
    const masterId = await as('curator', async (c) => (await c.query(
      `INSERT INTO medicine_master (brand_name, manufacturer_name, manufacturer_address, dosage_form, suggested_base_unit, salts, source, source_ref)
       VALUES ('Synthetic 5 mg tablet', 'Master Maker', '2 Master Road, Gujarat', 'TABLET', 'TABLET', '[{"name":"synthetic"}]', 'test', $1) RETURNING id`, [`dm6-${randomUUID()}`])).rows[0].id);
    const fromMaster = await createItem(w.owner, { masterId, category: 'MEDICINE', displayName: 'From master dm6', baseUnit: 'TABLET' });
    const ok2 = await postIt(w.reception, (await draft(w, w.reception, lic, [{ itemId: fromMaster.id, purchaseUnitId: fromMaster.baseUnitId, qty: 10, batchNo: 'M1', expiry: '06/2027', mrpPaise: 100, mrpUnitId: fromMaster.baseUnitId, purchaseRatePaise: 50 }])).body.id);
    assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
    // MR-07-like: a retail product needs no manufacturer address.
    const retail = await createItem(w.owner, { category: 'RETAIL_PRODUCT', displayName: 'Shampoo dm4', baseUnit: 'ML' }, { name: 'bottle', factor: 200 });
    const ok3 = await postIt(w.reception, (await draft(w, w.reception, lic, [{ itemId: retail.id, purchaseUnitId: retail.packUnitId, qty: 5, batchNo: 'S1', expiry: '07/2028', mrpPaise: 75000, mrpUnitId: retail.packUnitId, purchaseRatePaise: 57143 }])).body.id);
    assert.equal(ok3.status, 200, JSON.stringify(ok3.body));
  } finally {
    setClockForTests(null);
  }
});

test('MR-08 / MR-09: an NDPS or Schedule X item is received only with this premises\' licence in date', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('mr8');
    const sup = await supplier(w.owner, 'Licensed mr8');
    const ndps = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Controlled mr8', baseUnit: 'TABLET', extraScheduleFlags: ['NDPS'], ...{ customManufacturerName: 'M', customManufacturerAddress: 'A' } });
    const line = { itemId: ndps.id, purchaseUnitId: ndps.baseUnitId, qty: 10, batchNo: 'N1', expiry: '06/2027', mrpPaise: 100, mrpUnitId: ndps.baseUnitId, purchaseRatePaise: 50 };
    const d = await draft(w, w.reception, sup, [line]);
    assert.deepEqual(d.body.checks.errors, [{ code: 'LICENCE_REQUIRED_NDPS', lineNo: 1 }]);
    assert.deepEqual((await postIt(w.reception, d.body.id)).body.code, 'LICENCE_REQUIRED_NDPS');
    const p = (await w.owner.call(dPremisesGet)).body.items.find((x: { id: string }) => x.id === w.main.id);
    const put = await w.owner.call(premisesSettingsPut, { method: 'PUT', params: { id: w.main.id }, headers: { 'if-match': `"${p.settings.version}"`, 'reauth-grant': await grant(w.owner, w.aa, 'premises.legal_settings', w.main.id) },
      body: { ...(({ version, ...rest }) => { void version; return rest; })(p.settings), ndpsLicenceNo: 'NDPS/GJ/1', ndpsLicenceValidTill: '2027-12-31' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await postIt(w.reception, d.body.id)).status, 200);
  } finally {
    setClockForTests(null);
  }
});

test('posting checks: batch details on tracked lines, none on untracked; expired goods refused; near expiry warns; no future invoice; drafts show it all first', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('chk');
    const sup = await supplier(w.owner, 'Licensed chk');
    const d = await draft(w, w.reception, sup, [
      pcmLine(w, { batchNo: null }),
      { itemId: w.glv.id, purchaseUnitId: w.glv.packUnitId, qty: 1, batchNo: 'G1', expiry: '01/2027', purchaseRatePaise: 1 },
      pcmLine(w, { batchNo: 'OLD-1', expiry: '09/2026' }),
      pcmLine(w, { batchNo: 'SOON-1', expiry: '2026-10-20' }),
      pcmLine(w, { batchNo: 'DISC', discountPaise: 99_999 }),
    ], { invoiceDate: '2026-10-09' });
    assert.deepEqual(d.body.checks.errors.map((e: { code: string; lineNo?: number }) => `${e.code}${e.lineNo ? `@${e.lineNo}` : ''}`),
      ['INVOICE_DATE_IN_FUTURE', 'BATCH_DETAILS_REQUIRED@1', 'BATCH_NOT_TRACKED@2', 'BATCH_EXPIRED@3', 'DISCOUNT_EXCEEDS_GROSS@5']);
    assert.deepEqual(d.body.checks.warnings, [{ code: 'NEAR_EXPIRY_ON_ARRIVAL', lineNo: 4 }]);
    const r = await postIt(w.reception, d.body.id);
    assert.deepEqual([r.status, r.body.code], [422, 'INVOICE_DATE_IN_FUTURE']);
    assert.equal(r.body.details.problems.length, 5);
    // Fix it through PATCH: keep only the near-expiry line.
    const fixed = await w.reception.call(grnPatch, { method: 'PATCH', params: { id: d.body.id }, body: { invoiceDate: '2026-10-06', lines: [pcmLine(w, { batchNo: 'SOON-1', expiry: '2026-10-20' })] } });
    assert.deepEqual([fixed.status, fixed.body.checks.errors], [200, []]);
    const ok = await postIt(w.reception, d.body.id);
    assert.deepEqual([ok.status, ok.body.warnings], [200, [{ code: 'NEAR_EXPIRY_ON_ARRIVAL', lineNo: 1 }]]);
    // Shape errors never reach the draft.
    for (const [lines, field] of [[[pcmLine(w, { qty: 0 })], 'lines[0].qty'], [[pcmLine(w, { mrpPaise: 4500.5 })], 'lines[0].mrpPaise'],
      [[pcmLine(w, { expiry: '13/2027' })], 'lines[0].expiry'], [[pcmLine(w, { purchaseRatePaise: '3200' })], 'lines[0].purchaseRatePaise']] as const) {
      const bad = await draft(w, w.reception, sup, lines as unknown as unknown[]);
      assert.deepEqual([bad.status, bad.body.details?.field], [422, field]);
    }
    const unknown = await draft(w, w.reception, sup, [{ ...pcmLine(w), orgId: w.org.orgId }]);
    assert.deepEqual([unknown.status, unknown.body.code], [422, 'UNKNOWN_FIELD']);
  } finally {
    setClockForTests(null);
  }
});

test('E-26 and scope: a draft can be discarded (kept, never posted); reception works only at its own premises', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('disc');
    const sup = await supplier(w.owner, 'Licensed disc');
    const d = await draft(w, w.reception, sup, [pcmLine(w)]);
    const r = await w.reception.call(grnDiscard, { params: { id: d.body.id }, body: {} });
    assert.deepEqual([r.status, r.body.status, r.body.lines], [200, 'DISCARDED', []]);
    assert.equal((await postIt(w.reception, d.body.id)).body.code, 'GRN_NOT_DRAFT');
    const there = await w.reception.call(grnsPost, { body: { premisesId: w.second.id, supplierId: sup, invoiceNo: 'X1', invoiceDate: '2026-10-06' } });
    assert.deepEqual([there.status, there.body.code], [404, 'PREMISES_NOT_FOUND']);
    const ownersDraft = (await w.owner.call(grnsPost, { body: { premisesId: w.second.id, supplierId: sup, invoiceNo: 'X2', invoiceDate: '2026-10-06' } })).body;
    assert.equal((await w.reception.call(grnGet, { params: { id: ownersDraft.id } })).status, 404, "another premises' draft is invisible to reception");
    assert.equal((await w.reception.call(grnPatch, { method: 'PATCH', params: { id: ownersDraft.id }, body: { notes: 'mine' } })).status, 404, 'and cannot be edited');
    assert.equal((await postIt(w.reception, ownersDraft.id)).status, 404, 'or posted');
    assert.equal((await w.reception.call(grnDiscard, { params: { id: ownersDraft.id }, body: {} })).status, 404, 'or discarded');
    const list = (await w.reception.call(grnsGet)).body.items.map((g: { id: string }) => g.id);
    assert.ok(list.includes(d.body.id) && !list.includes(ownersDraft.id));
    // A quarantine location never receives.
    const q = await w.owner.call(grnsPost, { body: { premisesId: w.main.id, supplierId: sup, invoiceNo: 'X3', invoiceDate: '2026-10-06', locationId: w.main.quarantine } });
    assert.deepEqual([q.status, q.body.code], [422, 'LOCATION_NOT_ALLOWED']);
  } finally {
    setClockForTests(null);
  }
});

test('DK-08 / DC-07: a replayed post makes no second RECEIPT; two posts of one draft at once post it once', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('dk8');
    const sup = await supplier(w.owner, 'Licensed dk8');
    const d = await draft(w, w.reception, sup, [pcmLine(w)]);
    const key = randomUUID();
    const a = await postIt(w.reception, d.body.id, { 'idempotency-key': key });
    const b = await postIt(w.reception, d.body.id, { 'idempotency-key': key });
    assert.deepEqual([a.status, b.status, b.headers.get('idempotent-replayed')], [200, 200, 'true']);
    assert.equal(await movements(w), 1);
    const d2 = await draft(w, w.reception, sup, [pcmLine(w, { batchNo: 'TWO' })]);
    const both = await Promise.all([postIt(w.reception, d2.body.id), postIt(w.owner, d2.body.id)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.ok(both.some((r) => r.body.code === 'GRN_NOT_DRAFT'));
    assert.equal(await movements(w), 2);
  } finally {
    setClockForTests(null);
  }
});

test('DL-19 (API half) / DL-25: a backstop reached through the API is a mapped 4xx with one log line; received before the invoice is refused by the DB', async () => {
  setClockForTests(T0);
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try {
    const w = await stockWorld('dl19api');
    const sup = await supplier(w.owner, 'Licensed dl19');
    const d = await draft(w, w.reception, sup, [pcmLine(w, { expiry: '09/2026', batchNo: 'GONE' })]);
    faults.skipExpiryPrecheck = true;
    const r = await postIt(w.reception, d.body.id);
    assert.deepEqual([r.status, r.body.code], [409, 'BATCH_EXPIRED'], 'the trigger, mapped');
    assert.equal(lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'ledger_backstop_fired').length, 1);
    assert.equal((await w.reception.call(grnGet, { params: { id: d.body.id } })).body.status, 'DRAFT', 'rolled back');
  } finally {
    faults.skipExpiryPrecheck = false;
    restore();
    setClockForTests(null);
  }
  const w2 = await stockWorld('dl25');
  const sup2 = await supplier(w2.owner, 'Licensed dl25');
  // Received at 2026-10-05 04:30 IST for an invoice dated 2026-10-06 (the lag allowance is wide, so only L-22 can fail).
  const e = await asAppIn(w2.org.orgId, `INSERT INTO goods_receipts (org_id, premises_id, location_id, supplier_id, invoice_no, invoice_date, created_by, created_at, updated_at,
      status, received_at, received_by, posted_at, posted_by, supplier_name_snapshot, supplier_licence_numbers_snapshot, reason_after_minutes_snapshot)
    VALUES ($1, $2, $3, $4, 'L1', '2026-10-06', $5, now(), now(), 'POSTED', '2026-10-04T23:00:00Z', $5, '2026-10-06T23:00:00Z', $5, 'S', '{}', 100000)`,
    [w2.org.orgId, w2.main.id, w2.main.store, sup2, w2.aa.id]);
  assert.equal(e?.constraint, 'goods_receipts_received_after_invoice', JSON.stringify(e));
  const ok = await asAppIn(w2.org.orgId, `INSERT INTO goods_receipts (org_id, premises_id, location_id, supplier_id, invoice_no, invoice_date, created_by, created_at, updated_at,
      status, received_at, received_by, posted_at, posted_by, supplier_name_snapshot, supplier_licence_numbers_snapshot, reason_after_minutes_snapshot)
    VALUES ($1, $2, $3, $4, 'L2', '2026-10-06', $5, now(), now(), 'POSTED', '2026-10-05T18:30:00Z', $5, '2026-10-06T23:00:00Z', $5, 'S', '{}', 100000)`,
    [w2.org.orgId, w2.main.id, w2.main.store, sup2, w2.aa.id]);
  assert.equal(ok, null, 'from 00:00 IST on the invoice date it is fine');
});

test('DX-46 … DX-49: another organisation\'s supplier, item, premises and drafts are 404, and nothing changes', async () => {
  setClockForTests(T0);
  try {
    const A = await stockWorld('dx46a');
    const B = await stockWorld('dx46b');
    const supA = await supplier(A.owner, 'A sup');
    const supB = await supplier(B.owner, 'B sup');
    const bDraft = (await draft(B, B.owner, supB, [pcmLine(B)])).body;
    const before = (await A.owner.call(grnsGet)).body.items.length;
    const r1 = await draft(A, A.owner, supB, []);
    const r2 = await draft(A, A.owner, supA, [{ ...pcmLine(A), itemId: B.pcm.id }]);
    const r3 = await A.owner.call(grnsPost, { body: { premisesId: B.main.id, supplierId: supA, invoiceNo: 'Z', invoiceDate: '2026-10-06' } });
    assert.deepEqual([r1.body.code, r2.body.code, r3.body.code], ['SUPPLIER_NOT_FOUND', 'ITEM_NOT_FOUND', 'PREMISES_NOT_FOUND']);
    assert.ok([r1, r2, r3].every((r) => r.status === 404));
    assert.equal((await A.owner.call(grnsGet)).body.items.length, before, 'DX-46: no draft');
    assert.ok(!(await A.owner.call(grnsGet)).body.items.some((g: { id: string }) => g.id === bDraft.id), 'DX-47: excluded');
    for (const [r, why] of [
      [await A.owner.call(grnGet, { params: { id: bDraft.id } }), 'DX-47 get'],
      [await A.owner.call(grnPatch, { method: 'PATCH', params: { id: bDraft.id }, body: { notes: 'mine' } }), 'DX-47 patch'],
      [await postIt(A.owner, bDraft.id), 'DX-48'],
      [await A.owner.call(grnDiscard, { params: { id: bDraft.id }, body: {} }), 'DX-49'],
      [await A.owner.call(grnGet, { params: { id: '00000000-0000-4000-8000-000000000000' } }), 'NONEXIST'],
    ] as const) assert.deepEqual([r.status, r.body.code], [404, 'GRN_NOT_FOUND'], why);
    const still = (await B.owner.call(grnGet, { params: { id: bDraft.id } })).body;
    assert.deepEqual([still.status, still.notes], ['DRAFT', null]);
    assert.equal(await movements(B), 0);
  } finally {
    setClockForTests(null);
  }
});

