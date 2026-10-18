// D-54: who an item is for (migration 024). Given to patients, used in the clinic, or both; the
// category's default until someone chooses; the Stock list filters by it, BOTH in each list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createItem, stockWorld } from './harness/stock';
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
