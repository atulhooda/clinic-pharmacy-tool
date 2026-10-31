// R12-1 … R12-3 (Spec 06, 2026-10-31): a medicine's manufacturer on deliveries.
// - the editor's checks describe the screen, not the last save (pure: receipt-rules.ts, grn-checks.ts);
// - posting keeps a line's manufacturer on an item that has none, never overwriting one (real Postgres);
// - the item API carries the manufacturer address, so a line starts with it; a new medicine can start with both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { as } from './harness/env';
import { inOrg } from './harness/fixtures';
import { Browser } from './harness/http';
import { createItem, stockWorld, type StockWorld } from './harness/stock';
import { setClockForTests } from '../lib/clock';
import { lineProblems, liveChecks, makerOnPick, type LineFacts, type RuleContext, type RuleLine, type ScreenLine } from '../lib/stock/receipt-rules';
import { screenChecks, type Form, type Grn } from '../components/stock/grn-checks';
import type { ItemOpt, Unit } from '../components/stock/catalogue';
import { POST as grnsPost } from '../app/api/dispensary/goods-receipts/route';
import { GET as grnGet } from '../app/api/dispensary/goods-receipts/[id]/route';
import { POST as grnPostRoute } from '../app/api/dispensary/goods-receipts/[id]/post/route';
import { POST as suppliersPost } from '../app/api/dispensary/suppliers/route';
import { GET as itemsGet, POST as itemsPost } from '../app/api/dispensary/items/route';
import { GET as itemGet } from '../app/api/dispensary/items/[id]/route';

const T0 = new Date('2026-10-07T04:30:00Z'); // 2026-10-07 10:00 IST
const MAKER = { manufacturerName: 'Synthetic Lifescience Pvt Ltd', manufacturerAddress: 'Plot 4, Industrial Estate, Gujarat' };

// ---------------------------------------------------------------- pure: the rules and the editor's live view

const CTX: RuleContext = { manufacturerRequired: true, today: '2026-10-07', nearExpiryBy: '2026-11-06' };
const medFacts = (mfr: { mfrName?: string | null; mfrAddress?: string | null } = {}): LineFacts => ({
  item: { category: 'MEDICINE', trackBatches: true, active: true, mfrName: mfr.mfrName ?? null, mfrAddress: mfr.mfrAddress ?? null },
  unit: { factor: 15, purchasable: true, active: true },
});
const rl = (extra: Partial<RuleLine> = {}): RuleLine => ({ qty: 2, freeQty: 0, batchNo: 'B1', expiry: '12/2027', mfgDate: null, mrpPaise: 4500, mrpUnitId: 'u',
  purchaseRatePaise: 3200, discountPaise: 0, manufacturerName: null, manufacturerAddress: null, ...extra });

test('R12-1 lineProblems: MR-04 counts line → item → master; both name and address; only medicines and injectables, only where required', () => {
  assert.deepEqual(lineProblems(rl(), medFacts(), CTX).errors, ['MANUFACTURER_DETAILS_MISSING']);
  assert.deepEqual(lineProblems(rl({ manufacturerName: 'M', manufacturerAddress: 'A' }), medFacts(), CTX).errors, []);
  assert.deepEqual(lineProblems(rl({ manufacturerName: 'M' }), medFacts(), CTX).errors, ['MANUFACTURER_DETAILS_MISSING'], 'a name alone is not enough');
  assert.deepEqual(lineProblems(rl({ manufacturerAddress: 'A' }), medFacts({ mfrName: 'Master Maker' }), CTX).errors, [], 'the master name with the line address');
  assert.deepEqual(lineProblems(rl(), medFacts({ mfrName: 'M', mfrAddress: 'A' }), CTX).errors, [], 'the item on file is enough');
  assert.deepEqual(lineProblems(rl(), medFacts(), { ...CTX, manufacturerRequired: false }).errors, [], 'not at a consumables-only premises');
  const inj = medFacts(); inj.item.category = 'INJECTABLE';
  assert.deepEqual(lineProblems(rl(), inj, CTX).errors, ['MANUFACTURER_DETAILS_MISSING']);
  const retail = medFacts(); retail.item.category = 'RETAIL_PRODUCT';
  assert.deepEqual(lineProblems(rl(), retail, CTX).errors, []);
});

test('R12-1 lineProblems: the other line rules, in posting order; database facts only when given', () => {
  const all = lineProblems(rl({ batchNo: null, expiry: '09/2026', mfgDate: '10/2026', discountPaise: 999_999, purchaseRatePaise: 0, qty: 200_000_000 }),
    { ...medFacts(), item: { ...medFacts().item, active: false }, unit: { factor: 15, purchasable: false, active: true }, mrpMismatch: true, ndpsBlocked: true, xBlocked: true }, CTX);
  assert.deepEqual(all.errors, ['ITEM_INACTIVE', 'UNIT_NOT_PURCHASABLE', 'QTY_TOO_LARGE', 'DISCOUNT_EXCEEDS_GROSS', 'BATCH_DETAILS_REQUIRED', 'BATCH_EXPIRED',
    'MFG_AFTER_EXPIRY', 'BATCH_MRP_MISMATCH', 'MANUFACTURER_DETAILS_MISSING', 'LICENCE_REQUIRED_NDPS', 'LICENCE_REQUIRED_SCHEDULE_X']);
  assert.deepEqual(lineProblems(rl({ expiry: '10/2026', manufacturerName: 'M', manufacturerAddress: 'A' }), medFacts(), CTX), { errors: [], warnings: ['NEAR_EXPIRY_ON_ARRIVAL'] });
  const untracked = medFacts(); untracked.item.trackBatches = false; untracked.item.category = 'CONSUMABLE';
  assert.deepEqual(lineProblems(rl(), untracked, CTX).errors, ['BATCH_NOT_TRACKED']);
  assert.deepEqual(lineProblems(rl({ manufacturerName: 'M', manufacturerAddress: 'A' }), medFacts(), CTX).errors, [], 'no database facts given: none reported');
});

const screen = (savedLineNo: number | null, line: RuleLine, facts: LineFacts | null, sameAsSaved = true): ScreenLine => ({ savedLineNo, sameAsSaved, line, facts });

test('R12-1 liveChecks: the screenshot: typing the manufacturer clears the line at once; the server\'s stale answer does not stay', () => {
  const server = { errors: [{ code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 1 }, { code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 2 }], warnings: [] };
  const typed = rl({ manufacturerName: 'SYNTHETIC LIFESCIENCE', manufacturerAddress: 'Plot 4, Gujarat' });
  const r = liveChecks({ server, ctx: CTX, header: { invoiceDate: '2026-10-06', changed: false }, lines: [screen(1, typed, medFacts()), screen(2, rl(), medFacts())] });
  assert.deepEqual(r.errors, [{ code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 2 }], 'line 1 is filled on screen; line 2 still is not');
  assert.equal(r.recheck, false, 'nothing the server alone checks has changed');
  const both = liveChecks({ server, ctx: CTX, header: { invoiceDate: '2026-10-06', changed: false }, lines: [screen(1, typed, medFacts()), screen(2, typed, medFacts())] });
  assert.deepEqual(both.errors, []);
  // Whitespace is blank (the adapter trims), so a field of spaces still needs filling.
  const spaces = liveChecks({ server: null, ctx: CTX, header: { invoiceDate: '2026-10-06', changed: false }, lines: [screen(1, rl({ manufacturerName: 'M' }), medFacts())] });
  assert.deepEqual(spaces.errors, [{ code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 1 }]);
});

test('R12-1 liveChecks: server-only problems stay while their line is unchanged, move with it, and wait for a save once it changes', () => {
  const ok = rl({ manufacturerName: 'M', manufacturerAddress: 'A' });
  const server = { errors: [{ code: 'DUPLICATE_INVOICE' }, { code: 'BATCH_MRP_MISMATCH', lineNo: 1 }, { code: 'LICENCE_REQUIRED_NDPS', lineNo: 2 }, { code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 2 }],
    warnings: [{ code: 'SUPPLIER_LICENCE_MISSING' }, { code: 'NEAR_EXPIRY_ON_ARRIVAL', lineNo: 1 }] };
  // Line 1 removed: the old line 2 is now line 1 and keeps its licence problem; its MR-04 is recomputed (now filled).
  const moved = liveChecks({ server, ctx: CTX, header: { invoiceDate: '2026-10-06', changed: false }, lines: [screen(2, ok, medFacts())] });
  assert.deepEqual(moved.errors, [{ code: 'DUPLICATE_INVOICE' }, { code: 'LICENCE_REQUIRED_NDPS', lineNo: 1 }]);
  assert.deepEqual(moved.warnings, [{ code: 'SUPPLIER_LICENCE_MISSING' }], 'the removed line\'s warning went with it');
  // The batch changed: its MRP mismatch is no longer known here.
  const changed = liveChecks({ server, ctx: CTX, header: { invoiceDate: '2026-10-06', changed: false }, lines: [screen(1, ok, medFacts(), false)] });
  assert.deepEqual([changed.errors, changed.recheck], [[{ code: 'DUPLICATE_INVOICE' }], true]);
  // A new line is checked locally at once and flagged for the server.
  const added = liveChecks({ server: { errors: [], warnings: [] }, ctx: CTX, header: { invoiceDate: '2026-10-06', changed: false }, lines: [screen(null, rl(), medFacts())] });
  assert.deepEqual([added.errors, added.recheck], [[{ code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 1 }], true]);
  // A line whose item is not known on screen keeps the server's answer while unchanged.
  const unknown = liveChecks({ server, ctx: CTX, header: { invoiceDate: '2026-10-06', changed: false }, lines: [screen(2, ok, null)] });
  assert.deepEqual(unknown.errors.map((p) => p.code), ['DUPLICATE_INVOICE', 'LICENCE_REQUIRED_NDPS', 'MANUFACTURER_DETAILS_MISSING']);
  // The header: a new supplier or invoice number makes the server's header answers stale; the date and an empty delivery are checked here.
  const head = liveChecks({ server, ctx: CTX, header: { invoiceDate: '2026-10-08', changed: true }, lines: [] });
  assert.deepEqual([head.errors, head.warnings, head.recheck], [[{ code: 'GRN_EMPTY' }, { code: 'INVOICE_DATE_IN_FUTURE' }], [], true]);
  // No context (the server could not run its checks): its answer as it is.
  const none = liveChecks({ server: { errors: [{ code: 'UNIT_NOT_FOUND' }], warnings: [] }, ctx: null, header: { invoiceDate: '2026-10-06', changed: false }, lines: [screen(1, ok, medFacts())] });
  assert.deepEqual(none.errors, [{ code: 'UNIT_NOT_FOUND' }]);
});

test('R12-3 makerOnPick: a line starts with the item\'s manufacturer; typed values are kept; the previous item\'s values are replaced', () => {
  const blank = { mfrName: '', mfrAddress: '' };
  assert.deepEqual(makerOnPick(blank, null, { mfrName: 'M', mfrAddress: 'A' }), { mfrName: 'M', mfrAddress: 'A' });
  assert.deepEqual(makerOnPick(blank, null, { mfrName: 'Master', mfrAddress: null }), { mfrName: 'Master', mfrAddress: '' });
  assert.deepEqual(makerOnPick({ mfrName: 'Typed', mfrAddress: '' }, null, { mfrName: 'M', mfrAddress: 'A' }), { mfrName: 'Typed', mfrAddress: 'A' });
  assert.deepEqual(makerOnPick({ mfrName: 'M', mfrAddress: 'A' }, { mfrName: 'M', mfrAddress: 'A' }, { mfrName: null, mfrAddress: null }), blank, 'a prefilled value goes with its item');
  assert.deepEqual(makerOnPick({ mfrName: 'M', mfrAddress: 'Edited' }, { mfrName: 'M', mfrAddress: 'A' }, { mfrName: 'N', mfrAddress: 'B' }), { mfrName: 'N', mfrAddress: 'Edited' });
  assert.deepEqual(makerOnPick(blank, null, null), blank);
});

test('R12-1 screenChecks: the editor\'s form, as on screen, through the same rules', () => {
  const unit: Unit = { id: 'u-strip', name: 'strip', baseUnitsPerUnit: 15, isBase: false, dispensable: true, purchasable: true, active: true };
  const item: ItemOpt = { id: 'i-1', displayName: 'Synthetic 650', category: 'MEDICINE', baseUnit: 'TABLET', active: true, trackBatches: true, manufacturerName: null, manufacturerAddress: null };
  const saved = { itemId: 'i-1', purchaseUnitId: 'u-strip', qty: 2, freeQty: 0, batchNo: 'B1', expiry: '12/2027', mfgDate: null, mrpPaise: 4500, mrpUnitId: 'u-strip', purchaseRatePaise: 3200,
    discountPaise: 0, gstRateBp: 500, manufacturerName: null, manufacturerAddress: null, lineNo: 1, itemName: 'Synthetic 650', baseUnit: 'TABLET', purchaseUnitName: 'strip', receivedBase: 30, valuePaise: 6400, gstPaise: 320 };
  const grn: Grn = { id: 'g', status: 'DRAFT', supplierId: 's', supplierName: 'S', supplierLicenceStatus: 'VALID', invoiceNo: 'INV-1', invoiceDate: '2026-10-06', invoiceTotalPaise: null, notes: null,
    postedAt: null, lines: [saved, { ...saved, lineNo: 2 }], valuePaise: 0, gstPaise: 0, totalPaise: 0,
    checks: { errors: [{ code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 1 }, { code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 2 }], warnings: [] }, checkContext: CTX };
  const form = (n: number, mfrName: string, mfrAddress: string, extra: Partial<Form> = {}): Form => ({ key: `k${n}`, saved: n, mfgDate: '', itemId: 'i-1', purchaseUnitId: 'u-strip', qty: '2', freeQty: '',
    batchNo: 'B1', expiry: '12/2027', mrp: '45.00', mrpUnitId: 'u-strip', rate: '32.00', discount: '', gst: '5', mfrName, mfrAddress, ...extra });
  const head = { supplierId: 's', invoiceNo: 'INV-1', invoiceDate: '2026-10-06' };
  const items = new Map([[item.id, item]]);
  const units = { 'i-1': [unit] };
  const r = screenChecks(grn, head, [form(1, 'SYNTHETIC LIFESCIENCE PVT LTD', 'Plot 4, Gujarat'), form(2, '', '')], items, units);
  assert.deepEqual([r.errors, r.recheck], [[{ code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 2 }], false]);
  assert.deepEqual(screenChecks(grn, head, [form(1, 'M', 'A'), form(2, ' M ', ' A ')], items, units).errors, []);
  assert.deepEqual(screenChecks(grn, head, [form(1, 'M', 'A'), form(2, 'M', '   ')], items, units).errors, [{ code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 2 }], 'spaces are blank');
  // Items still loading: the server's answer, unchanged lines only.
  assert.equal(screenChecks(grn, head, [form(1, 'M', 'A')], new Map(), {}).errors.length, 1);
  // An edited batch is a change the server must see again.
  assert.equal(screenChecks(grn, head, [form(1, 'M', 'A', { batchNo: 'B2' }), form(2, 'M', 'A')], items, units).recheck, true);
});

// ---------------------------------------------------------------- real Postgres: posting keeps the manufacturer; the item API carries it

async function supplier(b: Browser, name: string): Promise<string> {
  const r = await b.call(suppliersPost, { body: { name, drugLicenceNumbers: ['20B/AHM/0001'], licenceValidTill: '2028-12-31' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
const line = (it: { id: string; baseUnitId: string }, batchNo: string, extra: Record<string, unknown> = {}) => ({ itemId: it.id, purchaseUnitId: it.baseUnitId, qty: 10, batchNo,
  expiry: '06/2027', mrpPaise: 100, mrpUnitId: it.baseUnitId, purchaseRatePaise: 50, ...extra });
const draft = (w: StockWorld, sup: string, lines: unknown[]) =>
  w.reception.call(grnsPost, { body: { premisesId: w.main.id, supplierId: sup, invoiceNo: `INV-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-10-06', lines } });
const post = (w: StockWorld, id: string) => w.reception.call(grnPostRoute, { params: { id }, body: {} });
const custom = (w: StockWorld, id: string) => inOrg(w.org.orgId, async (c) => (await c.query(
  'SELECT custom_manufacturer_name AS name, custom_manufacturer_address AS address FROM items WHERE org_id = $1 AND id = $2', [w.org.orgId, id])).rows[0]);
const itemAudit = (w: StockWorld, id: string) => inOrg(w.org.orgId, async (c) => (await c.query(
  "SELECT action, detail FROM audit_log WHERE org_id = $1 AND entity_id = $2 AND action = 'item.changed' ORDER BY at", [w.org.orgId, id])).rows);

test('R12-2: posting keeps a line\'s manufacturer on a medicine with none on file; the next delivery needs none; nothing on file is overwritten', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('mk1');
    const sup = await supplier(w.owner, 'Licensed mk1');
    const bare = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Bare medicine mk1', baseUnit: 'TABLET' });
    const kept = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Kept medicine mk1', baseUnit: 'TABLET', customManufacturerName: 'Own Maker', customManufacturerAddress: '1 Own Road' });
    const retail = await createItem(w.owner, { category: 'RETAIL_PRODUCT', displayName: 'Retail mk1', baseUnit: 'PIECE' });

    // A refused post keeps nothing (line 2 has no batch details).
    const refused = await draft(w, sup, [line(bare, 'R1', MAKER), line(kept, '', { batchNo: null })]);
    assert.equal((await post(w, refused.body.id)).body.code, 'BATCH_DETAILS_REQUIRED');
    assert.deepEqual(await custom(w, bare.id), { name: null, address: null });

    const d = await draft(w, sup, [line(bare, 'B1', MAKER), line(bare, 'B2', { manufacturerName: 'Second Line Maker', manufacturerAddress: 'Elsewhere' }),
      line(kept, 'K1', { manufacturerName: 'Different Maker', manufacturerAddress: 'Different Road' }), line(retail, 'R1', MAKER)]);
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const p = await post(w, d.body.id);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(await custom(w, bare.id), { name: MAKER.manufacturerName, address: MAKER.manufacturerAddress }, 'from the first line that has it');
    assert.deepEqual(await custom(w, kept.id), { name: 'Own Maker', address: '1 Own Road' }, 'never overwritten');
    assert.deepEqual(await custom(w, retail.id), { name: null, address: null }, 'only medicines and injectables');
    assert.deepEqual(p.body.grn.lines[2].manufacturerName, 'Different Maker', 'the bill line itself keeps what was on the bill');
    assert.deepEqual((await itemAudit(w, bare.id)).map((r) => r.detail), [{ fields: ['custom_manufacturer_name', 'custom_manufacturer_address'], reason: 'grn_posted' }]);
    assert.deepEqual(await itemAudit(w, kept.id), [], 'no change, no audit row');

    // The next delivery of it needs nothing typed: the draft shows no problem and posts, the record has the maker.
    const next = await draft(w, sup, [line(bare, 'B3')]);
    assert.deepEqual(next.body.checks.errors, []);
    const p2 = await post(w, next.body.id);
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    const snap = await inOrg(w.org.orgId, async (c) => (await c.query(
      'SELECT manufacturer_name_snapshot AS n, manufacturer_address_snapshot AS a FROM goods_receipt_lines WHERE org_id = $1 AND goods_receipt_id = $2', [w.org.orgId, next.body.id])).rows[0]);
    assert.deepEqual(snap, { n: MAKER.manufacturerName, a: MAKER.manufacturerAddress });
  } finally {
    setClockForTests(null);
  }
});

test('R12-2: a value saved on the item while the post runs is not overwritten (the fill re-checks under the row lock)', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('mk4');
    const sup = await supplier(w.owner, 'Licensed mk4');
    const bare = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Raced medicine mk4', baseUnit: 'TABLET' });
    const d = await draft(w, sup, [line(bare, 'C1', MAKER)]);
    // Another edit holds the item row (uncommitted) while the post reads "nothing on file" and reaches the fill.
    let posting: Promise<{ status: number; body: { code?: string } }> | null = null;
    await inOrg(w.org.orgId, async (c) => {
      await c.query("UPDATE items SET custom_manufacturer_name = 'Chosen Maker', custom_manufacturer_address = 'Chosen Road' WHERE org_id = $1 AND id = $2", [w.org.orgId, bare.id]);
      posting = post(w, d.body.id);
      await new Promise((r) => setTimeout(r, 1500));
    });
    const p = await posting!;
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(await custom(w, bare.id), { name: 'Chosen Maker', address: 'Chosen Road' });
    assert.deepEqual(await itemAudit(w, bare.id), [], 'nothing filled, nothing audited');
  } finally {
    setClockForTests(null);
  }
});

test('R12-2: a master-linked medicine keeps the master\'s name and gains only the missing address', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('mk2');
    const sup = await supplier(w.owner, 'Licensed mk2');
    const masterId = await as('curator', async (c) => (await c.query(
      `INSERT INTO medicine_master (brand_name, manufacturer_name, dosage_form, suggested_base_unit, salts, source, source_ref)
       VALUES ('Synthetic mk2 10 mg tablet', 'Master Maker', 'TABLET', 'TABLET', '[{"name":"synthetic"}]', 'test', $1) RETURNING id`, [`mk2-${randomUUID()}`])).rows[0].id);
    const fromMaster = await createItem(w.owner, { masterId, category: 'MEDICINE', displayName: 'From master mk2', baseUnit: 'TABLET' });
    const d = await draft(w, sup, [line(fromMaster, 'M1')]);
    assert.deepEqual(d.body.checks.errors, [{ code: 'MANUFACTURER_DETAILS_MISSING', lineNo: 1 }], 'the master has no address');
    const ok = await draft(w, sup, [line(fromMaster, 'M1', { manufacturerName: 'Master Maker', manufacturerAddress: '2 Master Road' })]);
    assert.equal((await post(w, ok.body.id)).status, 200);
    assert.deepEqual(await custom(w, fromMaster.id), { name: null, address: '2 Master Road' }, 'the master\'s name stays the source of the name');
    const item = (await w.owner.call(itemGet, { params: { id: fromMaster.id } })).body;
    assert.deepEqual([item.manufacturerName, item.manufacturerAddress], ['Master Maker', '2 Master Road']);
    assert.deepEqual((await draft(w, sup, [line(fromMaster, 'M2')])).body.checks.errors, []);
  } finally {
    setClockForTests(null);
  }
});

test('R12-3: the item API carries the manufacturer and address a line starts with; a new medicine can start with both; a draft carries its check context', async () => {
  setClockForTests(T0);
  try {
    const w = await stockWorld('mk3');
    const sup = await supplier(w.owner, 'Licensed mk3');
    // "+ New medicine or product" on a delivery line sends the manufacturer when one is typed.
    const r = await w.owner.call(itemsPost, { body: { displayName: 'New from delivery mk3', category: 'MEDICINE', baseUnit: 'TABLET', useFor: 'PATIENTS',
      customManufacturerName: MAKER.manufacturerName, customManufacturerAddress: MAKER.manufacturerAddress } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.manufacturerName, r.body.manufacturerAddress], [MAKER.manufacturerName, MAKER.manufacturerAddress]);
    const listed = (await w.reception.call(itemsGet, { path: '/api/dispensary/items?limit=200' })).body.items.find((i: { id: string }) => i.id === r.body.id);
    assert.deepEqual([listed.manufacturerName, listed.manufacturerAddress, listed.trackBatches], [MAKER.manufacturerName, MAKER.manufacturerAddress, true]);
    const bare = (await w.reception.call(itemsGet, { path: '/api/dispensary/items?limit=200' })).body.items.find((i: { id: string }) => i.id === w.pcm.id);
    assert.deepEqual([bare.manufacturerName, bare.manufacturerAddress], [null, null]);
    // The new medicine posts with nothing typed on its line.
    const unit = r.body.units.find((u: { isBase: boolean }) => u.isBase).id;
    const d = await draft(w, sup, [line({ id: r.body.id, baseUnitId: unit }, 'N1')]);
    assert.deepEqual([d.body.checks.errors, d.body.checkContext], [[], { manufacturerRequired: true, today: '2026-10-07', nearExpiryBy: d.body.checkContext.nearExpiryBy }]);
    assert.match(d.body.checkContext.nearExpiryBy, /^\d{4}-\d{2}-\d{2}$/);
    const p = await post(w, d.body.id);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.grn.checkContext, null, 'a posted delivery has no checks');
    assert.equal((await w.reception.call(grnGet, { params: { id: d.body.id } })).body.checkContext, null);
  } finally {
    setClockForTests(null);
  }
});
