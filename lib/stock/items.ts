import type { Db } from '../db/db';
import { withTenant } from '../db/tenant';
import { now } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { checkViolation, requirePremises } from './scope';
import { itemStock, stockSummaries, type BatchView, type StockSummary } from './ledger';

/**
 * The organisation's catalogue (06a §6.5; E-12 … E-17). One catalogue per business.
 *
 * - Effective schedule flags = master ∪ extra: an organisation can add a flag, never remove
 *   the master's (06b DG-06).
 * - requires_prescription (D-32) is set at creation from the master and kept true while the
 *   master or Schedule X imposes it (422 REQUIRES_PRESCRIPTION_IMPOSED here; a trigger is
 *   the guarantee). Changing it is audited (DG-09).
 * - A unit's factor is immutable (a trigger); E-17 changes its flags only.
 * - Stock (PR 7, D-47): E-12 carries each item's balance over the caller's premises (or one,
 *   `premisesId`) and filters on low stock and near expiry; E-14 adds the batches and
 *   balances per location; E-18 (ledger.ts) is the history. In Milestone 1, E-15 never
 *   changes an item's identity (R7-5); the items_freeze trigger guards it once stock has moved.
 */
export type Category = 'MEDICINE' | 'RETAIL_PRODUCT' | 'INJECTABLE' | 'CONSUMABLE';
export type BaseUnit = 'TABLET' | 'CAPSULE' | 'ML' | 'G' | 'VIAL' | 'UNIT' | 'PIECE';
export const CATEGORIES: readonly Category[] = ['MEDICINE', 'RETAIL_PRODUCT', 'INJECTABLE', 'CONSUMABLE'];
export const BASE_UNITS: readonly BaseUnit[] = ['TABLET', 'CAPSULE', 'ML', 'G', 'VIAL', 'UNIT', 'PIECE'];
export const SCHEDULE_FLAGS = ['H', 'H1', 'X', 'G', 'NDPS', 'H2'] as const;
export const STORAGE = ['ROOM_TEMPERATURE', 'BELOW_25C', 'BELOW_30C', 'COLD_2_8C', 'FROZEN'] as const;
/** D-54: given to patients, used in the clinic during treatment, or both. */
export const USE_FOR = ['PATIENTS', 'IN_CLINIC', 'BOTH'] as const;
export type UseFor = (typeof USE_FOR)[number];
/** An item with no choice yet: injectables and consumables are used in the clinic; the rest go to patients. */
const USE_FOR_SQL = `coalesce(i.use_for, CASE WHEN i.category IN ('INJECTABLE','CONSUMABLE') THEN 'IN_CLINIC' ELSE 'PATIENTS' END)`;

export interface Unit { id: string; name: string; baseUnitsPerUnit: number; isBase: boolean; dispensable: boolean; purchasable: boolean; active: boolean }
export interface ItemView {
  id: string;
  masterId: string | null;
  category: Category;
  displayName: string;
  baseUnit: BaseUnit;
  trackBatches: boolean;
  useFor: UseFor;
  /** D-56: what the clinic still has to do about the item. */
  note: string | null;
  extraScheduleFlags: string[];
  scheduleFlags: string[];
  requiresPrescription: boolean;
  requiresPrescriptionImposed: boolean;
  manufacturerName: string | null;
  hsnCode: string | null;
  storageCondition: string | null;
  reorderLevel: number | null;
  reorderQty: number | null;
  rackLocation: string | null;
  active: boolean;
}
const ITEM_SELECT = `
  SELECT i.id, i.master_id AS "masterId", i.category, i.display_name AS "displayName", i.base_unit AS "baseUnit",
         i.track_batches AS "trackBatches", ${USE_FOR_SQL} AS "useFor", i.note, i.extra_schedule_flags AS "extraScheduleFlags",
         ARRAY(SELECT DISTINCT f FROM unnest(coalesce(m.schedule_flags, '{}') || i.extra_schedule_flags) f ORDER BY f) AS "scheduleFlags",
         i.requires_prescription AS "requiresPrescription",
         (coalesce(m.requires_prescription, false) OR 'X' = ANY (coalesce(m.schedule_flags, '{}') || i.extra_schedule_flags)) AS "requiresPrescriptionImposed",
         coalesce(i.custom_manufacturer_name, m.manufacturer_name) AS "manufacturerName",
         coalesce(i.hsn_code_override, m.hsn_code) AS "hsnCode", i.storage_condition AS "storageCondition",
         i.reorder_level AS "reorderLevel", i.reorder_qty AS "reorderQty", i.rack_location AS "rackLocation", i.active
    FROM items i LEFT JOIN medicine_master m ON m.id = i.master_id
   WHERE i.org_id = $1`;
const notFound = () => new HttpError(404, 'ITEM_NOT_FOUND', 'No such item.');

async function unitsOf(db: Db, orgId: string, itemId: string): Promise<Unit[]> {
  return db.rows<Unit>(`SELECT id, name, base_units_per_unit AS "baseUnitsPerUnit", is_base AS "isBase", dispensable, purchasable, active
                          FROM item_units WHERE org_id = $1 AND item_id = $2 ORDER BY base_units_per_unit, lower(name)`, [orgId, itemId]);
}

const EMPTY_STOCK: StockSummary = { onHandBase: 0, dispensableBase: 0, quarantinedBase: 0, expiredBase: 0, nearestExpiry: null, lowStock: false, nearExpiry: false, detailsPending: false };

function flag(q: URLSearchParams, name: string): boolean {
  const v = q.get(name);
  if (v === null || v === 'false') return false;
  if (v === 'true') return true;
  throw new HttpError(422, 'FIELD_INVALID', `${name} is true or false.`, { field: name, rule: 'enum' });
}

/** The premises a stock read covers: one (in the caller's membership, else 404) or all of the caller's. */
function stockScope(s: Session, q: URLSearchParams): string[] {
  const one = q.get('premisesId');
  if (!one) return s.premises.map((p) => p.id);
  requirePremises(s, one.toLowerCase());
  return [one.toLowerCase()];
}

/** E-12: list and search, each item with its balance (D-47); `lowStock`, `nearExpiry`, `premisesId` filter by stock. */
export async function listItems(s: Session, q: URLSearchParams): Promise<{ items: (ItemView & { units: Unit[]; stock: StockSummary })[]; nextCursor: string | null }> {
  const text = (q.get('q') ?? '').trim().toLowerCase().replace(/[%_\\]/g, '').slice(0, 80);
  const category = q.get('category');
  if (category && !(CATEGORIES as readonly string[]).includes(category)) throw new HttpError(422, 'FIELD_INVALID', 'Unknown category.', { field: 'category', rule: 'enum' });
  // `use=PATIENTS` lists what is given to patients, `use=IN_CLINIC` what the clinic uses; BOTH is in each.
  const use = q.get('use');
  if (use && use !== 'PATIENTS' && use !== 'IN_CLINIC') throw new HttpError(422, 'FIELD_INVALID', 'Unknown use.', { field: 'use', rule: 'enum' });
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
  let after: { n: string; id: string } | null = null;
  const c = q.get('cursor');
  if (c) {
    try { after = JSON.parse(Buffer.from(c, 'base64url').toString()); } catch { throw new HttpError(422, 'FIELD_INVALID', 'Bad cursor.', { field: 'cursor', rule: 'format' }); }
  }
  const scope = stockScope(s, q);
  const lowStock = flag(q, 'lowStock');
  const nearExpiry = flag(q, 'nearExpiry');
  return withTenant(s.orgId, async (db) => {
    let only: string[] | null = null;
    if (lowStock || nearExpiry) {
      const all = await stockSummaries(db, s.orgId, scope, null);
      only = [...all].filter(([, v]) => (!lowStock || v.lowStock) && (!nearExpiry || v.nearExpiry)).map(([id]) => id);
    }
    const rows = await db.rows<ItemView>(
      `${ITEM_SELECT}
         AND ($2 = '' OR lower(i.display_name) LIKE '%' || $2 || '%' OR lower(i.display_name) % $2
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(m.salts) e WHERE lower(e->>'name') LIKE $2 || '%'))
         AND ($3::text IS NULL OR i.category = $3)
         AND ($4::text IS NULL OR (lower(i.display_name), i.id) > ($4, $5::uuid))
         AND ($7::uuid[] IS NULL OR i.id = ANY($7::uuid[]))
         AND ($8::text IS NULL OR ${USE_FOR_SQL} IN ($8, 'BOTH'))
       ORDER BY lower(i.display_name), i.id LIMIT $6`, [s.orgId, text, category, after?.n ?? null, after?.id ?? null, limit + 1, only, use]);
    const page = rows.slice(0, limit);
    const stock = await stockSummaries(db, s.orgId, scope, page.map((i) => i.id));
    // Each item's units, so a list can show its balance in packs ("2 bottles", "8 strips").
    const units = new Map<string, Unit[]>();
    for (const u of await db.rows<Unit & { itemId: string }>(
      `SELECT item_id AS "itemId", id, name, base_units_per_unit AS "baseUnitsPerUnit", is_base AS "isBase", dispensable, purchasable, active
         FROM item_units WHERE org_id = $1 AND item_id = ANY($2::uuid[]) ORDER BY base_units_per_unit, lower(name)`, [s.orgId, page.map((i) => i.id)])) {
      const { itemId, ...unit } = u;
      units.set(itemId, [...(units.get(itemId) ?? []), unit]);
    }
    const last = page[page.length - 1];
    return {
      items: page.map((i) => ({ ...i, units: units.get(i.id) ?? [], stock: stock.get(i.id) ?? EMPTY_STOCK })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ n: last.displayName.toLowerCase(), id: last.id })).toString('base64url') : null,
    };
  });
}

export interface ItemDetail extends ItemView {
  units: Unit[];
  /** At the caller's premises: the balance, the batches with their balances per location, untracked balances. */
  stock: StockSummary & { batches: BatchView[]; untracked: Awaited<ReturnType<typeof itemStock>>['untracked'] };
}

/** E-14: the item, its effective flags, its units, and its stock at the caller's premises. */
export async function getItem(s: Session, id: string): Promise<ItemDetail> {
  return withTenant(s.orgId, async (db) => {
    const item = (await db.rows<ItemView>(`${ITEM_SELECT} AND i.id = $2`, [s.orgId, id]))[0];
    if (!item) throw notFound();
    const summary = (await stockSummaries(db, s.orgId, s.premises.map((p) => p.id), [id])).get(id) ?? EMPTY_STOCK;
    return { ...item, units: await unitsOf(db, s.orgId, id), stock: { ...summary, ...(await itemStock(db, s, id)) } };
  });
}

export interface ItemCreate {
  masterId?: string | null;
  category: Category;
  displayName: string;
  baseUnit: BaseUnit;
  trackBatches?: boolean;
  useFor?: UseFor;
  note?: string | null;
  extraScheduleFlags?: string[];
  requiresPrescription?: boolean;
  customManufacturerName?: string | null;
  customManufacturerAddress?: string | null;
  hsnCodeOverride?: string | null;
  storageCondition?: string | null;
  reorderLevel?: number | null;
  reorderQty?: number | null;
  rackLocation?: string | null;
}

function uniqueConflict(err: unknown): never {
  const e = err as { code?: string; constraint?: string; hint?: string };
  if (e.code === '23505' && e.constraint === 'items_display_name_key') throw new HttpError(409, 'ITEM_NAME_TAKEN', 'Another item has that name.');
  if (e.code === '23505' && e.constraint === 'items_master_key') throw new HttpError(409, 'ITEM_ALREADY_LINKED', 'An item is already linked to that medicine.');
  if (e.code === '23505' && e.constraint === 'item_units_name_key') throw new HttpError(409, 'UNIT_NAME_TAKEN', 'This item already has a unit with that name.');
  if (e.hint === 'REQUIRES_PRESCRIPTION_IMPOSED') throw imposed();
  return checkViolation(err);
}
const imposed = () => new HttpError(422, 'REQUIRES_PRESCRIPTION_IMPOSED', 'The medicine master or Schedule X requires a prescription for this item.');

/** E-13: create an item (from the master or custom) with its base unit. */
export async function createItem(s: Session, input: ItemCreate): Promise<ItemDetail> {
  const id = await withSessionTx(s, async (db) => {
    let masterRx = false;
    let masterFlags: string[] = [];
    if (input.masterId) {
      const m = (await db.rows<{ rx: boolean; flags: string[]; discontinued: boolean }>(
        'SELECT requires_prescription AS rx, schedule_flags AS flags, discontinued FROM medicine_master WHERE id = $1', [input.masterId]))[0];
      if (!m || m.discontinued) throw new HttpError(404, 'MASTER_NOT_FOUND', 'No such medicine.');
      masterRx = m.rx;
      masterFlags = m.flags;
    }
    const extra = input.extraScheduleFlags ?? [];
    const imposedRx = masterRx || [...masterFlags, ...extra].includes('X');
    // D-32: set at creation from the master; never false where it is imposed.
    if (input.requiresPrescription === false && imposedRx) throw imposed();
    const rx = input.requiresPrescription ?? imposedRx;
    const at = now();
    const item = (await db.rows<{ id: string }>(
      `INSERT INTO items (org_id, master_id, category, display_name, base_unit, track_batches, extra_schedule_flags, requires_prescription,
                          custom_manufacturer_name, custom_manufacturer_address, hsn_code_override, storage_condition,
                          reorder_level, reorder_qty, rack_location, use_for, note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17, $18, $16, $16) RETURNING id`,
      [s.orgId, input.masterId ?? null, input.category, input.displayName.trim(), input.baseUnit,
        input.trackBatches ?? input.category !== 'CONSUMABLE', extra, rx, input.customManufacturerName ?? null,
        input.customManufacturerAddress ?? null, input.hsnCodeOverride ?? null, input.storageCondition ?? null,
        input.reorderLevel ?? null, input.reorderQty ?? null, input.rackLocation ?? null, at, input.useFor ?? null, input.note?.trim() || null]).catch(uniqueConflict))[0];
    await db.rows(`INSERT INTO item_units (org_id, item_id, name, base_units_per_unit, is_base, created_at) VALUES ($1, $2, $3, 1, true, $4)`,
      [s.orgId, item.id, input.baseUnit.toLowerCase(), at]);
    await writeAudit(db, { orgId: s.orgId, action: 'item.created', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: item.id,
      detail: { kind: input.masterId ? 'master' : 'custom' } });
    return item.id;
  });
  return getItem(s, id);
}

export type ItemPatch = Partial<Omit<ItemCreate, 'masterId' | 'baseUnit' | 'trackBatches'>> & { active?: boolean };
const PATCH_MAP: Record<keyof ItemPatch, string> = {
  category: 'category', displayName: 'display_name', extraScheduleFlags: 'extra_schedule_flags', requiresPrescription: 'requires_prescription',
  customManufacturerName: 'custom_manufacturer_name', customManufacturerAddress: 'custom_manufacturer_address',
  hsnCodeOverride: 'hsn_code_override', storageCondition: 'storage_condition', reorderLevel: 'reorder_level',
  reorderQty: 'reorder_qty', rackLocation: 'rack_location', active: 'active', useFor: 'use_for', note: 'note',
};

/** E-15: everything but the item's identity. */
export async function patchItem(s: Session, id: string, input: ItemPatch): Promise<ItemDetail> {
  await withSessionTx(s, async (db) => {
    const cur = (await db.rows<ItemView>(`${ITEM_SELECT} AND i.id = $2 FOR UPDATE OF i`, [s.orgId, id]))[0];
    if (!cur) throw notFound();
    const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ItemView;
    if (input.displayName !== undefined) next.displayName = input.displayName.trim();
    if (input.note !== undefined) next.note = input.note?.trim() || null;
    const keys = (Object.keys(PATCH_MAP) as (keyof ItemPatch)[]).filter((k) => input[k] !== undefined
      && JSON.stringify((next as unknown as Record<string, unknown>)[k]) !== JSON.stringify((cur as unknown as Record<string, unknown>)[k]));
    if (keys.length === 0) return;
    if (next.requiresPrescription === false) {
      const m = cur.masterId ? (await db.rows<{ rx: boolean; flags: string[] }>('SELECT requires_prescription AS rx, schedule_flags AS flags FROM medicine_master WHERE id = $1', [cur.masterId]))[0] : null;
      if (m?.rx || [...(m?.flags ?? []), ...next.extraScheduleFlags].includes('X')) throw imposed();
    }
    const sets = keys.map((k, i) => `${PATCH_MAP[k]} = $${i + 3}`).join(', ');
    await db.rows(`UPDATE items SET ${sets}, updated_at = $${keys.length + 3} WHERE org_id = $1 AND id = $2`,
      [s.orgId, id, ...keys.map((k) => (next as unknown as Record<string, unknown>)[k]), now()]).catch(uniqueConflict);
    if (keys.includes('requiresPrescription')) {
      await writeAudit(db, { orgId: s.orgId, action: 'item.requires_prescription_changed', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id,
        detail: { from: cur.requiresPrescription, to: next.requiresPrescription } });
    }
    const other = keys.filter((k) => k !== 'requiresPrescription');
    if (other.length) {
      await writeAudit(db, { orgId: s.orgId, action: 'item.changed', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { fields: other.map((k) => PATCH_MAP[k]) } });
    }
  });
  return getItem(s, id);
}

/** E-16: add a pack unit (its factor is fixed for ever). */
export async function addUnit(s: Session, itemId: string, input: { name: string; baseUnitsPerUnit: number; dispensable?: boolean; purchasable?: boolean }): Promise<Unit> {
  return withSessionTx(s, async (db) => {
    const item = await db.rows('SELECT 1 FROM items WHERE org_id = $1 AND id = $2', [s.orgId, itemId]);
    if (item.length === 0) throw notFound();
    return (await db.rows<Unit>(
      `INSERT INTO item_units (org_id, item_id, name, base_units_per_unit, dispensable, purchasable, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, base_units_per_unit AS "baseUnitsPerUnit", is_base AS "isBase", dispensable, purchasable, active`,
      [s.orgId, itemId, input.name.trim(), input.baseUnitsPerUnit, input.dispensable ?? true, input.purchasable ?? true, now()]).catch(uniqueConflict))[0];
  });
}

/** E-17: a unit's flags only; the factor is immutable, and the base unit stays active. */
export async function patchUnit(s: Session, itemId: string, unitId: string, input: { dispensable?: boolean; purchasable?: boolean; active?: boolean }): Promise<Unit> {
  return withSessionTx(s, async (db) => {
    const cur = (await db.rows<Unit>(
      `SELECT id, name, base_units_per_unit AS "baseUnitsPerUnit", is_base AS "isBase", dispensable, purchasable, active
         FROM item_units WHERE org_id = $1 AND item_id = $2 AND id = $3 FOR UPDATE`, [s.orgId, itemId, unitId]))[0];
    if (!cur) {
      const item = await db.rows('SELECT 1 FROM items WHERE org_id = $1 AND id = $2', [s.orgId, itemId]);
      throw item.length ? new HttpError(404, 'UNIT_NOT_FOUND', 'No such unit.') : notFound();
    }
    if (cur.isBase && input.active === false) throw new HttpError(422, 'BASE_UNIT_REQUIRED', 'The base unit stays active.');
    return (await db.rows<Unit>(
      `UPDATE item_units SET dispensable = $4, purchasable = $5, active = $6 WHERE org_id = $1 AND item_id = $2 AND id = $3
       RETURNING id, name, base_units_per_unit AS "baseUnitsPerUnit", is_base AS "isBase", dispensable, purchasable, active`,
      [s.orgId, itemId, unitId, input.dispensable ?? cur.dispensable, input.purchasable ?? cur.purchasable, input.active ?? cur.active]))[0];
  });
}
