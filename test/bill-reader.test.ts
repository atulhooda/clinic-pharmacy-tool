// PR 8b, reading supplier bills (D-51, E-51): 06b DBR-01 … 08 and DX-87. The model is replaced by a
// fixed fake (setBillReaderForTests): no test touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaff, inOrg } from './harness/fixtures';
import { Browser } from './harness/http';
import { createItem, stockWorld, type StockWorld } from './harness/stock';
import { setLogSink } from '../lib/log';
import { buildRequest, cleanBill, rupeesToPaise, setBillReaderForTests, type Media } from '../lib/stock/bill-reader';
import { POST as readBillRoute } from '../app/api/dispensary/goods-receipts/read-bill/route';
import { POST as suppliersPost } from '../app/api/dispensary/suppliers/route';

const JPEG = (n = 64) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const PDF = (n = 64) => { const b = new Uint8Array(n); b.set([...'%PDF-1.7'].map((c) => c.charCodeAt(0))); return b; };
const form = (bytes: Uint8Array | null, extra: Record<string, string> = {}) => {
  const f = new FormData();
  if (bytes) f.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), 'bill.jpg');
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
};
const read = (b: Browser, body: FormData, opts: { noIdempotencyKey?: boolean } = {}) =>
  b.call(readBillRoute, { method: 'POST', path: '/api/dispensary/goods-receipts/read-bill', body, ...opts });

const BILL = {
  supplier: { name: 'MDL WHOLESALE AGENCY', gstin: '24AAAAA0000A1Z5', drugLicenceNumbers: ['20B/1'] },
  invoice: { number: 'MD/991', date: '2026-10-06' },
  lines: [
    { name: 'ACME SHINE TAB', pack: '10 TAB', hsn: '30049099', batch: 'SYN-0001', expiry: '11/27', qty: 10, free: 1, mrp: '120.00', rate: '90.50', discount: null, gstPercent: 5 },
    { name: 'ZZQ UNKNOWN THING', pack: null, batch: null, expiry: null, qty: 2, free: 0, mrp: '117.43', rate: '50', gstPercent: 18 },
    { name: 'ACME LOTION', pack: null, qty: 1 },
  ],
};

async function world(label: string): Promise<StockWorld & { shine: string; strip: string; medline: string; northwind: string }> {
  const w = await stockWorld(label);
  const shine = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Acme Shine Tab', baseUnit: 'TABLET' }, { name: 'strip', factor: 10 });
  const medline = (await w.owner.call(suppliersPost, { body: { name: 'Medline Distributors', gstin: '24AAAAA0000A1Z5', drugLicenceNumbers: ['20B/1'] } })).body.id;
  const northwind = (await w.owner.call(suppliersPost, { body: { name: 'Northwind Healthcare', drugLicenceNumbers: ['20B/2'] } })).body.id;
  return { ...w, shine: shine.id, strip: shine.packUnitId!, medline, northwind };
}

function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only-not-a-key';
  return fn().finally(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    setBillReaderForTests(null);
  });
}

test('DBR-01 / DBR-02: without a key the reader is not set up (503); a person without stock.receive is 403', async () => {
  const w = await world('dbr1');
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await read(w.owner, form(JPEG()));
    assert.deepEqual([r.status, r.body.code], [503, 'BILL_READER_NOT_CONFIGURED']);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
  const doc = await createStaff(w.org, { role: 'doctor' });
  const b = new Browser();
  await b.signIn(w.org.slug, doc.login, doc.password);
  const r2 = await withKey(() => read(b, form(JPEG())));
  assert.deepEqual([r2.status, r2.body.code], [403, 'forbidden']);
});

test('DBR-03: the file: at most 8 MB (a photo 5 MB), a JPEG, PNG, WebP or PDF by its bytes, and nothing else in the form', async () => {
  const w = await world('dbr3');
  await withKey(async () => {
    setBillReaderForTests(async () => BILL);
    assert.deepEqual((await read(w.owner, form(PDF(9 * 1024 * 1024)))).body.code, 'FILE_TOO_LARGE');
    assert.deepEqual((await read(w.owner, form(JPEG(6 * 1024 * 1024)))).body.code, 'FILE_TOO_LARGE');
    assert.equal((await read(w.owner, form(PDF(6 * 1024 * 1024)))).status, 200, 'a 6 MB PDF is fine');
    const txt = await read(w.owner, form(new TextEncoder().encode('hello, this is not a bill')));
    assert.deepEqual([txt.status, txt.body.code], [422, 'UNSUPPORTED_FORMAT']);
    assert.deepEqual((await read(w.owner, form(null))).body.details, { field: 'file', rule: 'required' });
    assert.deepEqual((await read(w.owner, form(JPEG(), { premisesId: 'x' }))).body.code, 'UNKNOWN_FIELD');
  });
});

test('DBR-04 / DBR-05: the supplier by GSTIN, else by name; each line\'s item by name with candidates, its pack by size; money and expiry exactly', async () => {
  const w = await world('dbr4');
  await withKey(async () => {
    setBillReaderForTests(async () => BILL);
    const r = await read(w.owner, form(JPEG()));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.supplier.matchId, w.medline, 'by GSTIN, though the printed name is unlike the one on file');
    const [shine, unknown, loose] = r.body.lines;
    assert.deepEqual([shine.itemId, shine.purchaseUnitId, shine.candidates[0].score], [w.shine, w.strip, 100]);
    assert.ok(shine.candidates.length <= 3);
    assert.deepEqual([shine.mrpPaise, shine.ratePaise, shine.gstRateBp, shine.expiry, shine.qty, shine.free], [12000, 9050, 500, '11/27', 10, 1]);
    assert.deepEqual([unknown.itemId, unknown.candidates, unknown.mrpPaise], [null, [], 11743]);
    // Loosely like an item: offered, never preselected.
    assert.equal(loose.itemId, null);
    assert.ok(loose.candidates.length > 0 && loose.candidates[0].score < 45, JSON.stringify(loose.candidates));
    setBillReaderForTests(async () => ({ ...BILL, supplier: { name: 'NORTHWIND HEALTHCARE', gstin: null } }));
    assert.equal((await read(w.owner, form(JPEG()))).body.supplier.matchId, w.northwind, 'by name');
    setBillReaderForTests(async () => ({ ...BILL, supplier: { name: 'Wholly Unknown Traders', gstin: null } }));
    assert.equal((await read(w.owner, form(JPEG()))).body.supplier.matchId, null);
  });
});

test('DBR-06: a misfit field is dropped and flagged, the rest kept; nothing usable is 502', async () => {
  const bill = cleanBill({ supplier: { gstin: 'not-a-gstin' }, invoice: { date: '2026-02-30' },
    lines: [{ name: 'X', qty: 'ten', mrp: 'abc', rate: '12.5', expiry: 'soon', gstPercent: 12 }, { name: '', qty: 1 }, { qty: 2 }] });
  assert.deepEqual(bill.flags, ['supplier.gstin', 'invoice.date']);
  assert.deepEqual([bill.lines.length, bill.skipped], [1, 2]);
  const [l] = bill.lines;
  assert.deepEqual([l.qty, l.mrpPaise, l.ratePaise, l.expiry, l.gstRateBp], [null, null, 1250, null, 1200]);
  assert.deepEqual(l.flags.sort(), ['expiry', 'mrp', 'qty']);
  for (const raw of [null, {}, { lines: [] }, { lines: [{ qty: 1 }] }, 'just text']) {
    assert.throws(() => cleanBill(raw), (e: { status: number; code: string }) => e.status === 502 && e.code === 'BILL_READ_FAILED', JSON.stringify(raw));
  }
  assert.deepEqual([rupeesToPaise('1,23,456.7'), rupeesToPaise(45), rupeesToPaise('-5'), rupeesToPaise('1.234')], [12345670, 4500, null, null]);
  const w = await world('dbr6');
  await withKey(async () => {
    setBillReaderForTests(async () => ({ lines: [] }));
    const r = await read(w.owner, form(JPEG()));
    assert.deepEqual([r.status, r.body.code], [502, 'BILL_READ_FAILED']);
  });
});

test('DBR-07: reading writes nothing, needs no Idempotency-Key, returns no image data, and logs counts only', async () => {
  const w = await world('dbr7');
  const counts = () => inOrg(w.org.orgId, async (c) => (await c.query(`SELECT (SELECT count(*) FROM goods_receipts WHERE org_id = $1)::int AS g,
    (SELECT count(*) FROM audit_log WHERE org_id = $1)::int AS a, (SELECT count(*) FROM stock_movements WHERE org_id = $1)::int AS m`, [w.org.orgId])).rows[0]);
  const before = await counts();
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  let seen = '';
  try {
    await withKey(async () => {
      setBillReaderForTests(async (_m, b64) => { seen = b64; return BILL; });
      const marker = JPEG(300);
      marker.set([...'UNIQUEMARKER'].map((c) => c.charCodeAt(0)), 100);
      const r = await read(w.owner, form(marker), { noIdempotencyKey: true });
      assert.equal(r.status, 200);
      assert.ok(seen.length > 0 && !JSON.stringify(r.body).includes(seen.slice(120, 160)), 'no image data in the response');
    });
  } finally {
    restore();
  }
  assert.deepEqual(await counts(), before);
  const logged = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'bill_read');
  assert.equal(logged.length, 1);
  assert.deepEqual(Object.keys(logged[0]).sort(), ['event', 'lines', 'matched', 'media', 'ms', 'skipped', 'ts']);
  assert.ok(!lines.join('').includes('SHINE'), 'never the bill\'s text');
});

test('DBR-08: the request to the model: the configured model, the file as base64 with its type, one forced tool', () => {
  for (const media of ['image/png', 'application/pdf'] as Media[]) {
    const r = buildRequest('claude-opus-5-5', media, 'QUJD');
    assert.equal(r.model, 'claude-opus-5-5');
    assert.deepEqual(r.tool_choice, { type: 'tool', name: 'record_bill' });
    assert.deepEqual(r.tools.map((x) => x.name), ['record_bill']);
    const [file, prompt] = r.messages[0].content as { type: string; source?: { type: string; media_type: string; data: string }; text?: string }[];
    assert.equal(file.type, media === 'application/pdf' ? 'document' : 'image');
    assert.deepEqual(file.source, { type: 'base64', media_type: media, data: 'QUJD' });
    assert.match(prompt.text!, /exactly as printed/);
    assert.match(prompt.text!, /Ignore .* patient information/);
  }
});

test("DX-87: matches come only from the caller's organisation", async () => {
  const A = await world('dx87a');
  const B = await stockWorld('dx87b');
  await createItem(B.owner, { category: 'MEDICINE', displayName: 'Only In B Tab', baseUnit: 'TABLET' });
  const bSup = (await B.owner.call(suppliersPost, { body: { name: 'B Only Pharma', gstin: '24BBBBB0000B1Z5', drugLicenceNumbers: ['20B/9'] } })).body.id;
  await withKey(async () => {
    setBillReaderForTests(async () => ({ supplier: { name: 'B Only Pharma', gstin: '24BBBBB0000B1Z5' }, invoice: {}, lines: [{ name: 'ONLY IN B TAB', qty: 1 }] }));
    const r = await read(A.owner, form(JPEG()));
    assert.equal(r.status, 200);
    assert.equal(r.body.supplier.matchId, null);
    assert.ok(!JSON.stringify(r.body).includes(bSup));
    assert.deepEqual(r.body.lines[0].candidates.filter((c: { name: string }) => c.name === 'Only In B Tab'), []);
  });
});
