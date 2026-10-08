// A stock world for the ledger tests (06b §2, reduced to what PR 7 needs): an organisation with
// two configured premises (main in Gujarat, second in Maharashtra), their store and quarantine
// locations, an owner and a reception member at main only, a batch-tracked medicine with a strip
// of 15 and an untracked consumable. Set up through the API, as a clinic would.
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import pg from 'pg';
import { createOrg, createStaff, inOrg, type OrgFixture, type StaffFixture } from './fixtures';
import { as } from './env';
import { Browser } from './http';
import { withTenant } from '../../lib/db/tenant';
import { now } from '../../lib/clock';
import { postMovements, type MovementInput } from '../../lib/stock/ledger';
import { POST as reauthRoute } from '../../app/api/auth/reauth/route';
import { POST as setupPost } from '../../app/api/dispensary/setup/route';
import { POST as premisesSetup } from '../../app/api/dispensary/premises/[id]/setup/route';
import { GET as dPremisesGet } from '../../app/api/dispensary/premises/route';
import { POST as itemsPost } from '../../app/api/dispensary/items/route';
import { POST as unitPost } from '../../app/api/dispensary/items/[id]/units/route';

export const PREMISES_SETUP = { dispensingMode: 'RMP_OWN_PATIENTS', ndpsLicenceNo: null, ndpsLicenceValidTill: null, scheduleXLicenceNo: null,
  scheduleXLicenceValidTill: null, h1RegisterExtraFields: ['PATIENT_ADDRESS'], prescriptionMaxAgeDays: null };

export interface Item { id: string; baseUnitId: string; packUnitId: string | null }
export interface StockWorld {
  org: OrgFixture;
  aa: StaffFixture;
  af: StaffFixture;
  owner: Browser;
  reception: Browser;
  main: { id: string; store: string; quarantine: string };
  second: { id: string; store: string; quarantine: string };
  pcm: Item;
  glv: Item;
}

export async function grant(b: Browser, staff: StaffFixture, purpose: string, entityId: string): Promise<string> {
  const r = await b.call(reauthRoute, { body: { pin: staff.signingPin, purpose, entityId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.grantId;
}

export async function createItem(b: Browser, body: Record<string, unknown>, pack?: { name: string; factor: number }): Promise<Item> {
  const r = await b.call(itemsPost, { body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let packUnitId: string | null = null;
  if (pack) {
    const u = await b.call(unitPost, { body: { name: pack.name, baseUnitsPerUnit: pack.factor }, params: { id: r.body.id } });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    packUnitId = u.body.id;
  }
  return { id: r.body.id, baseUnitId: r.body.units.find((u: { isBase: boolean }) => u.isBase).id, packUnitId };
}

export async function stockWorld(label: string): Promise<StockWorld> {
  const org = await createOrg(label);
  const secondId = await inOrg(org.orgId, async (c) => (await c.query(
    "INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, 'Second', '2 Test Road, Maharashtra', '27') RETURNING id", [org.orgId])).rows[0].id as string);
  const [aa, af] = await Promise.all([createStaff(org, { role: 'owner', name: `Owner ${label}` }),
    createStaff(org, { role: 'reception', name: `Reception ${label}`, premises: [org.premisesId] })]);
  const owner = new Browser();
  await owner.signIn(org.slug, aa.login, aa.password);
  const reception = new Browser();
  await reception.signIn(org.slug, af.login, af.password);
  assert.equal((await owner.call(setupPost, { body: {} })).status, 201);
  for (const id of [org.premisesId, secondId]) {
    const r = await owner.call(premisesSetup, { body: PREMISES_SETUP, params: { id }, headers: { 'reauth-grant': await grant(owner, aa, 'premises.legal_settings', id) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const premises = (await owner.call(dPremisesGet)).body.items as { id: string; locations: { id: string; kind: string }[] }[];
  const locs = (id: string) => {
    const p = premises.find((x) => x.id === id)!;
    return { id, store: p.locations.find((l) => l.kind === 'STORE')!.id, quarantine: p.locations.find((l) => l.kind === 'QUARANTINE')!.id };
  };
  const pcm = await createItem(owner, { category: 'MEDICINE', displayName: `Paracetamol ${label}`, baseUnit: 'TABLET', reorderLevel: 20 }, { name: 'strip', factor: 15 });
  const glv = await createItem(owner, { category: 'CONSUMABLE', displayName: `Gloves ${label}`, baseUnit: 'PIECE', trackBatches: false }, { name: 'box', factor: 100 });
  return { org, aa, af, owner, reception, main: locs(org.premisesId), second: locs(secondId), pcm, glv };
}

/** A batch of the item at a premises (as the app role), MRP per strip of 15 by default. */
export async function batch(w: StockWorld, opts: { premisesId?: string; item?: Item; no?: string; expiry: string; mrpPaise?: number }): Promise<string> {
  const item = opts.item ?? w.pcm;
  return inOrg(w.org.orgId, async (c) => (await c.query(
    `INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [w.org.orgId, opts.premisesId ?? w.main.id, item.id, opts.no ?? `B-${randomUUID().slice(0, 6).toUpperCase()}`, opts.expiry, opts.mrpPaise ?? 4500,
      item.packUnitId ?? item.baseUnitId])).rows[0].id as string);
}

const REF: Record<string, string> = {
  OPENING_BALANCE: 'STOCK_ADJUSTMENT_LINE', RECEIPT: 'GOODS_RECEIPT_LINE', DISPENSE: 'DISPENSE_ALLOCATION', PATIENT_RETURN: 'PATIENT_RETURN_LINE',
  SUPPLIER_RETURN: 'SUPPLIER_RETURN_LINE', EXPIRY_WRITEOFF: 'STOCK_ADJUSTMENT_LINE', DAMAGE_WRITEOFF: 'STOCK_ADJUSTMENT_LINE',
  STOCKTAKE_ADJUSTMENT: 'STOCK_ADJUSTMENT_LINE', REVERSAL: 'STOCK_REVERSAL',
};
const REASON: Record<string, string> = {
  SUPPLIER_RETURN: 'EXPIRED', EXPIRY_WRITEOFF: 'EXPIRED', DAMAGE_WRITEOFF: 'DAMAGED', STOCKTAKE_ADJUSTMENT: 'COUNT_CORRECTION', REVERSAL: 'DATA_ENTRY_ERROR',
};

/** Post movements through the service (postMovements) in one tenant transaction, as the owner. */
export async function post(w: StockWorld, ms: (Partial<MovementInput> & Pick<MovementInput, 'type' | 'qtyDelta'>)[], at: Date = now()): Promise<string[]> {
  const full = ms.map((m) => ({
    premisesId: m.premisesId ?? w.main.id, itemId: m.itemId ?? w.pcm.id, batchId: m.batchId ?? null, locationId: m.locationId ?? w.main.store,
    type: m.type, qtyDelta: m.qtyDelta, referenceType: m.referenceType ?? REF[m.type], referenceId: m.referenceId ?? randomUUID(),
    reasonCode: m.reasonCode === undefined ? (REASON[m.type] ?? null) : m.reasonCode, note: m.note ?? null, reversesMovementId: m.reversesMovementId ?? null,
  }));
  return withTenant(w.org.orgId, (db) => postMovements(db, { orgId: w.org.orgId, staffUserId: w.aa.id, name: w.aa.name }, { occurredAt: at, recordedAt: at }, full));
}

/** The cache and the ledger, per key, for one organisation (as the jobs role reads them). */
export async function snapshot(orgId: string): Promise<{ cache: Map<string, number>; ledger: Map<string, number> }> {
  return withTenant(orgId, async (db) => {
    const k = (r: { premisesId: string; itemId: string; batchId: string | null; locationId: string }) => `${r.premisesId}/${r.itemId}/${r.batchId}/${r.locationId}`;
    const cache = await db.rows<{ premisesId: string; itemId: string; batchId: string | null; locationId: string; n: number }>(
      'SELECT premises_id AS "premisesId", item_id AS "itemId", batch_id AS "batchId", location_id AS "locationId", on_hand AS n FROM stock_balances WHERE org_id = $1', [orgId]);
    const ledger = await db.rows<{ premisesId: string; itemId: string; batchId: string | null; locationId: string; n: number }>(
      `SELECT premises_id AS "premisesId", item_id AS "itemId", batch_id AS "batchId", location_id AS "locationId", sum(qty_delta)::int AS n
         FROM stock_movements WHERE org_id = $1 GROUP BY 1, 2, 3, 4`, [orgId]);
    return { cache: new Map(cache.map((r) => [k(r), r.n])), ledger: new Map(ledger.map((r) => [k(r), r.n])) };
  });
}

/** Run SQL as the migrator (the table owner) inside the organisation's tenant transaction; returns the error or null. */
export async function asOwnerIn(orgId: string, sql: string, params: unknown[] = []): Promise<{ code?: string; hint?: string; constraint?: string } | null> {
  return as('migrator', async (c: pg.Client) => {
    await c.query('BEGIN');
    try {
      await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      await c.query(sql, params);
      await c.query('COMMIT');
      return null;
    } catch (err) {
      await c.query('ROLLBACK');
      return err as { code?: string; hint?: string; constraint?: string };
    }
  });
}

/** The same as the app role. */
export async function asAppIn(orgId: string, sql: string, params: unknown[] = []): Promise<{ code?: string; hint?: string; constraint?: string } | null> {
  return inOrg(orgId, async (c) => {
    await c.query(sql, params);
    return null;
  }).catch((err) => err as { code?: string; hint?: string; constraint?: string });
}
