// D-54: who an item is for (migration 024). Given to patients, used in the clinic, or both; the
// category's default until someone chooses; the Stock list filters by it, BOTH in each list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createItem, post, stockWorld } from './harness/stock';
import { PATCH as unitPatch } from '../app/api/dispensary/items/[id]/units/[unitId]/route';
import { GET as itemsGet } from '../app/api/dispensary/items/route';
import { GET as itemGet, PATCH as itemPatch } from '../app/api/dispensary/items/[id]/route';

test('D-54: injectables and consumables default to the clinic, the rest to patients; a choice is kept; the list filters, BOTH in each', async () => {
  const w = await stockWorld('use1');
  const get = async (id: string) => (await w.owner.call(itemGet, { params: { id } })).body.useFor;
  assert.deepEqual([await get(w.pcm.id), await get(w.glv.id)], ['PATIENTS', 'IN_CLINIC'], 'a medicine and a consumable, by category');
  const drip = await createItem(w.owner, { category: 'INJECTABLE', displayName: 'Drip use1', baseUnit: 'VIAL' });
  const cream = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Cream use1', baseUnit: 'PIECE', useFor: 'BOTH' });
  assert.deepEqual([await get(drip.id), await get(cream.id)], ['IN_CLINIC', 'BOTH']);
  const p = await w.owner.call(itemPatch, { method: 'PATCH', params: { id: w.pcm.id }, body: { useFor: 'IN_CLINIC' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.useFor, 'IN_CLINIC');
  const names = async (use: string) => (await w.owner.call(itemsGet, { path: `/api/dispensary/items?use=${use}` })).body.items.map((i: { displayName: string }) => i.displayName).sort();
  assert.deepEqual(await names('PATIENTS'), ['Cream use1']);
  assert.deepEqual(await names('IN_CLINIC'), ['Cream use1', 'Drip use1', 'Gloves use1', 'Paracetamol use1']);
  assert.equal((await w.owner.call(itemsGet, { path: '/api/dispensary/items?use=BOTH' })).body.code, 'FIELD_INVALID', 'filter by one side; BOTH is in each');
  assert.equal((await w.owner.call(itemPatch, { method: 'PATCH', params: { id: drip.id }, body: { useFor: 'SOMETIMES' } })).status, 422);
  assert.equal((await w.reception.call(itemPatch, { method: 'PATCH', params: { id: drip.id }, body: { useFor: 'PATIENTS' } })).status, 403);
});

test('D-56: an item carries a short note, set on creation, changed or cleared later, shown in the list', async () => {
  const w = await stockWorld('note1');
  const peel = await createItem(w.owner, { category: 'CONSUMABLE', displayName: 'Peel note1', baseUnit: 'PIECE', trackBatches: false, useFor: 'IN_CLINIC', note: 'Enter the quantity (sheet: 10 ML)' });
  const get = async () => (await w.owner.call(itemGet, { params: { id: peel.id } })).body.note;
  assert.equal(await get(), 'Enter the quantity (sheet: 10 ML)');
  const listed = (await w.owner.call(itemsGet, { path: '/api/dispensary/items?use=IN_CLINIC' })).body.items.find((i: { id: string }) => i.id === peel.id);
  assert.equal(listed.note, 'Enter the quantity (sheet: 10 ML)');
  assert.equal((await w.owner.call(itemPatch, { method: 'PATCH', params: { id: peel.id }, body: { note: '  ' } })).status, 200);
  assert.equal(await get(), null, 'a blank note clears it');
  assert.equal((await w.owner.call(itemPatch, { method: 'PATCH', params: { id: peel.id }, body: { note: 'x'.repeat(301) } })).status, 422);
});

test('D-70: what an item is counted in changes while nothing has moved and it has no packs; never after', async () => {
  const w = await stockWorld('cnt1');
  const fresh = await createItem(w.owner, { category: 'MEDICINE', displayName: 'Fresh cnt1', baseUnit: 'TABLET' });
  const p = (id: string, baseUnit: string) => w.owner.call(itemPatch, { method: 'PATCH', params: { id }, body: { baseUnit } });
  const ok = await p(fresh.id, 'STRIP');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.baseUnit, ok.body.units.find((u: { isBase: boolean }) => u.isBase).name], ['STRIP', 'strip']);
  assert.equal((await p(fresh.id, 'ML')).body.code, 'FIELD_INVALID', 'only strip, bottle, tube or unit');
  assert.equal((await p(w.pcm.id, 'STRIP')).body.code, 'ITEM_HAS_PACKS', 'a strip of 15 tablets hangs off the base');
  await post(w, [{ type: 'OPENING_BALANCE', itemId: w.glv.id, batchId: null, qtyDelta: 5 }]);
  const glvBox = (await w.owner.call(itemGet, { params: { id: w.glv.id } })).body.units.find((u: { isBase: boolean }) => !u.isBase);
  await w.owner.call(unitPatch, { method: 'PATCH', params: { id: w.glv.id, unitId: glvBox.id }, body: { active: false } });
  assert.equal((await p(w.glv.id, 'UNIT')).body.code, 'ITEM_IDENTITY_LOCKED', 'stock has moved');
});
