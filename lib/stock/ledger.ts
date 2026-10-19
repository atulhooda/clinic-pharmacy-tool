import type { Db } from '../db/db';
import { withTenant } from '../db/tenant';
import { addDays, todayIst } from '../clock';
import { HttpError } from '../http/errors';
import { log } from '../log';
import { withSessionTx, type Session } from '../auth/guard';
import type { BatchStock } from './allocate';
import { requirePremises } from './scope';

/**
 * The ledger's service side (06a §6.6, §7, §9.1). Documents (receipts, dispenses, returns,
 * corrections) post their movements through postMovements, inside their own transaction:
 * - every balance row of each (item, location) they touch is locked first, in the global
 *   order (lockBalances);
 * - movements are inserted in the same canonical order;
 * - the cache follows by trigger, and the DB guards (§7.3) are the backstop. A backstop
 *   firing is a mapped 4xx with a `ledger_backstop_fired` log line, never a 500.
 */
export const MOVEMENT_TYPES = ['OPENING_BALANCE', 'RECEIPT', 'DISPENSE', 'PROCEDURE_USE', 'PATIENT_RETURN', 'SUPPLIER_RETURN',
  'EXPIRY_WRITEOFF', 'DAMAGE_WRITEOFF', 'STOCKTAKE_ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'REVERSAL'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface MovementInput {
  premisesId: string;
  itemId: string;
  batchId: string | null;
  locationId: string;
  type: MovementType;
  qtyDelta: number;
  referenceType: string;
  referenceId: string;
  reasonCode?: string | null;
  note?: string | null;
  reversesMovementId?: string | null;
}

export interface Actor {
  orgId: string;
  staffUserId: string;
  name: string;
}

interface Key { itemId: string; locationId: string; batchId?: string | null }
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The global order (§9.1 step 4): (item_id, location_id, batch_id NULLS FIRST). */
export function canonical(a: Key, b: Key): number {
  const byKey = cmp(a.itemId, b.itemId) || cmp(a.locationId, b.locationId);
  if (byKey) return byKey;
  const x = a.batchId ?? null;
  const y = b.batchId ?? null;
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  return cmp(x, y);
}

export interface BalanceRow {
  premisesId: string;
  itemId: string;
  batchId: string | null;
  locationId: string;
  onHand: number;
}

/**
 * §9.1 step 4: lock every balance row of each (item, location), with no on_hand filter, in
 * the global order. A key without a row yet has nothing to lock: its first movement creates
 * the row through the unique key, which serialises concurrent first receipts.
 */
export async function lockBalances(db: Db, orgId: string, keys: readonly { itemId: string; locationId: string }[]): Promise<BalanceRow[]> {
  const seen = new Map<string, { itemId: string; locationId: string }>();
  for (const k of keys) seen.set(`${k.itemId}/${k.locationId}`, k);
  const pairs = [...seen.values()].sort((a, b) => cmp(a.itemId, b.itemId) || cmp(a.locationId, b.locationId));
  if (pairs.length === 0) return [];
  return db.rows<BalanceRow>(
    `SELECT b.premises_id AS "premisesId", b.item_id AS "itemId", b.batch_id AS "batchId", b.location_id AS "locationId", b.on_hand AS "onHand"
       FROM stock_balances b
       JOIN unnest($2::uuid[], $3::uuid[]) AS k(item_id, location_id) ON b.item_id = k.item_id AND b.location_id = k.location_id
      WHERE b.org_id = $1
      ORDER BY b.item_id, b.location_id, b.batch_id NULLS FIRST
      FOR UPDATE OF b`,
    [orgId, pairs.map((p) => p.itemId), pairs.map((p) => p.locationId)]);
}

const HINTS: Record<string, [number, string, string]> = {
  BATCH_EXPIRED: [409, 'BATCH_EXPIRED', 'That batch has expired.'],
  EXPIRY_WRITEOFF_NOT_EXPIRED: [409, 'EXPIRY_WRITEOFF_NOT_EXPIRED', 'That batch has not expired; write it off as damaged instead.'],
  QUARANTINED: [409, 'QUARANTINED', 'Quarantined stock can only be written off or returned to the supplier.'],
  BATCH_TRACKING_MISMATCH: [422, 'BATCH_TRACKING_MISMATCH', 'A batch is needed for a batch-tracked item, and not allowed otherwise.'],
  REVERSAL_MISMATCH: [409, 'REVERSAL_MISMATCH', 'A reversal must mirror the movement it reverses.'],
  OPENING_EXPIRED_NOT_QUARANTINED: [409, 'OPENING_EXPIRED_NOT_QUARANTINED', 'Expired opening stock goes to quarantine.'],
  INSUFFICIENT_STOCK_AS_OF: [409, 'INSUFFICIENT_STOCK_AS_OF', 'There was not enough stock at that time.'],
};

/** Map a DB guard's error to its 4xx (06a §7.3); anything else is not a backstop and is rethrown. */
export function backstop(err: unknown, m: Pick<MovementInput, 'itemId' | 'batchId' | 'referenceId'>): unknown {
  const e = err as { code?: string; hint?: string; constraint?: string };
  let mapped: HttpError | null = null;
  if (e.hint && HINTS[e.hint]) mapped = new HttpError(...HINTS[e.hint]);
  else if (e.code === '23514' && e.constraint === 'stock_balances_on_hand') mapped = new HttpError(409, 'INSUFFICIENT_STOCK', 'Not enough stock.');
  else if (e.code === '23505' && e.constraint === 'stock_movements_natural_key') mapped = new HttpError(409, 'ALREADY_POSTED', 'That line has already been posted.');
  else if (e.code === '23505' && e.constraint === 'stock_movements_reverses_key') mapped = new HttpError(409, 'ALREADY_REVERSED', 'That movement has already been reversed.');
  if (!mapped) return err;
  log('ledger_backstop_fired', { guard: e.hint ?? e.constraint ?? e.code, itemId: m.itemId, batchId: m.batchId, referenceId: m.referenceId });
  return mapped;
}

/**
 * Insert movements in the canonical order, in the caller's transaction. Every movement of a
 * document carries the same occurred_at and recorded_at. Returns the ids in input order.
 */
export async function postMovements(db: Db, actor: Actor, at: { occurredAt: Date; recordedAt: Date }, movements: readonly MovementInput[]): Promise<string[]> {
  const order = movements.map((m, i) => ({ m, i })).sort((a, b) => canonical(a.m, b.m) || a.i - b.i);
  const ids: string[] = new Array(movements.length);
  for (const { m, i } of order) {
    try {
      const r = await db.rows<{ id: string }>(
        `INSERT INTO stock_movements (org_id, premises_id, item_id, batch_id, location_id, movement_type, qty_delta, reference_type, reference_id,
                                      reason_code, note, actor_staff_id, actor_label, occurred_at, recorded_at, reverses_movement_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
        [actor.orgId, m.premisesId, m.itemId, m.batchId, m.locationId, m.type, m.qtyDelta, m.referenceType, m.referenceId,
          m.reasonCode ?? null, m.note ?? null, actor.staffUserId, actor.name, at.occurredAt, at.recordedAt, m.reversesMovementId ?? null]);
      ids[i] = r[0].id;
    } catch (err) {
      throw backstop(err, m);
    }
  }
  return ids;
}

/**
 * §9.1: one transaction per request. A deadlock or serialisation failure is retried at most
 * twice (the idempotency key makes that safe), then answered 503 RETRY_LATER.
 */
export async function withStockTx<T>(s: Session, fn: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withSessionTx(s, fn);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '40P01' && code !== '40001') throw err;
      if (attempt >= 2) throw new HttpError(503, 'RETRY_LATER', 'The stock was busy. Try again.');
    }
  }
}

/** D-55: the batch number of an item's placeholder batch (details pending). */
export const PENDING_BATCH_NO = 'DETAILS PENDING';

/** Batch numbers are stored trimmed, with single spaces, in upper case. */
export const normaliseBatchNo = (s: string): string => s.trim().replace(/\s+/g, ' ').toUpperCase();

export interface BatchInput {
  premisesId: string;
  itemId: string;
  batchNo: string;
  expiryDate: string;
  expiryAsPrinted?: string | null;
  mfgDate?: string | null;
  mrpPaise: number;
  mrpUnitId: string;
  manufacturerName?: string | null;
  manufacturerAddress?: string | null;
}

/**
 * Resolve a batch by (premises, item, number, expiry), or create it (06a §6.6). A batch that
 * exists with a different MRP is 409 BATCH_MRP_MISMATCH (06 OQ-15): the MRP of a batch never
 * changes.
 */
export async function resolveBatch(db: Db, orgId: string, b: BatchInput): Promise<{ id: string; created: boolean }> {
  const batchNo = normaliseBatchNo(b.batchNo);
  // D-55: the placeholder's number is reserved; a real batch never takes it.
  if (batchNo === PENDING_BATCH_NO) throw new HttpError(422, 'BATCH_NO_RESERVED', 'That batch number is reserved; enter the number printed on the pack.');
  const params = [orgId, b.premisesId, b.itemId, batchNo, b.expiryDate];
  const find = () => db.rows<{ id: string; mrpPaise: number; mrpUnitId: string; factor: number }>(
    `SELECT bt.id, bt.mrp_paise AS "mrpPaise", bt.mrp_unit_id AS "mrpUnitId", u.base_units_per_unit AS factor
       FROM batches bt JOIN item_units u ON u.org_id = bt.org_id AND u.id = bt.mrp_unit_id
      WHERE bt.org_id = $1 AND bt.premises_id = $2 AND bt.item_id = $3 AND bt.batch_no = $4 AND bt.expiry_date = $5`, params);
  const check = async (row: { id: string; mrpPaise: number; mrpUnitId: string; factor: number }) => {
    // The same MRP per base unit, whatever pack it was entered for.
    const unit = (await db.rows<{ factor: number }>('SELECT base_units_per_unit AS factor FROM item_units WHERE org_id = $1 AND item_id = $2 AND id = $3',
      [orgId, b.itemId, b.mrpUnitId]))[0];
    if (!unit || row.mrpPaise * unit.factor !== b.mrpPaise * row.factor) {
      throw new HttpError(409, 'BATCH_MRP_MISMATCH', 'This batch is already recorded with a different MRP.', { batchNo });
    }
    return { id: row.id, created: false };
  };
  const existing = (await find())[0];
  if (existing) return check(existing);
  const ins = await db.rows<{ id: string }>(
    `INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, expiry_as_printed, mfg_date, mrp_paise, mrp_unit_id,
                          manufacturer_name_snapshot, manufacturer_address_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT ON CONSTRAINT batches_number_key DO NOTHING RETURNING id`,
    [...params, b.expiryAsPrinted ?? null, b.mfgDate ?? null, b.mrpPaise, b.mrpUnitId, b.manufacturerName ?? null, b.manufacturerAddress ?? null]);
  if (ins.length) return { id: ins[0].id, created: true };
  // A concurrent document created it first.
  return check((await find())[0]);
}

/**
 * Allocation candidates (06a §8): the batches of one item at one non-quarantine location,
 * with what is on hand. The caller holds the balance locks.
 */
export async function candidatesAt(db: Db, orgId: string, itemId: string, locationId: string): Promise<BatchStock[]> {
  const loc = (await db.rows<{ kind: string }>('SELECT kind FROM stock_locations WHERE org_id = $1 AND id = $2', [orgId, locationId]))[0];
  if (!loc) throw new HttpError(404, 'LOCATION_NOT_FOUND', 'No such location.');
  if (loc.kind === 'QUARANTINE') return [];
  return db.rows<BatchStock>(
    `SELECT b.batch_id AS "batchId", bt.expiry_date::text AS "expiryDate", coalesce(bt.seq, 0)::int AS "batchSeq", b.on_hand AS available
       FROM stock_balances b LEFT JOIN batches bt ON bt.org_id = b.org_id AND bt.id = b.batch_id
      WHERE b.org_id = $1 AND b.item_id = $2 AND b.location_id = $3`, [orgId, itemId, locationId]);
}

// ---------------------------------------------------------------- reads

export interface StockSummary {
  onHandBase: number;
  dispensableBase: number;
  quarantinedBase: number;
  expiredBase: number;
  nearestExpiry: string | null;
  lowStock: boolean;
  nearExpiry: boolean;
  /** D-55: some stock is on a placeholder batch whose details are still to be read off the pack. */
  detailsPending: boolean;
}

/**
 * Each item's stock over the given premises, in base units (D-47: the balance on the Stock
 * page). Dispensable = not quarantined and not expired today (IST). Low stock is measured per
 * premises that is set up for stock (06a §9.3), against the item's reorder level. Near expiry:
 * a dispensable batch within the first near-expiry window.
 */
export async function stockSummaries(db: Db, orgId: string, premisesIds: readonly string[], itemIds: readonly string[] | null): Promise<Map<string, StockSummary>> {
  const today = todayIst();
  const windows = (await db.rows<{ w: number[] }>('SELECT near_expiry_windows_days AS w FROM stock_settings WHERE org_id = $1', [orgId]))[0]?.w ?? [30];
  const nearBy = addDays(today, Math.min(...windows));
  const rows = await db.rows<Omit<StockSummary, 'nearExpiry'> & { itemId: string }>(
    `WITH scope AS (SELECT unnest($2::uuid[]) AS premises_id),
     cfg AS (SELECT ps.premises_id FROM premises_settings ps JOIN scope USING (premises_id) WHERE ps.org_id = $1),
     bal AS (
       SELECT b.item_id, b.premises_id,
              sum(b.on_hand)::int AS on_hand,
              coalesce(sum(b.on_hand) FILTER (WHERE l.kind <> 'QUARANTINE' AND (b.batch_id IS NULL OR bt.expiry_date >= $3::date)), 0)::int AS dispensable,
              coalesce(sum(b.on_hand) FILTER (WHERE l.kind = 'QUARANTINE'), 0)::int AS quarantined,
              coalesce(sum(b.on_hand) FILTER (WHERE bt.expiry_date < $3::date), 0)::int AS expired,
              min(bt.expiry_date) FILTER (WHERE b.on_hand > 0 AND l.kind <> 'QUARANTINE' AND bt.expiry_date >= $3::date AND bt.details_pending IS NOT TRUE) AS nearest,
              coalesce(bool_or(bt.details_pending IS TRUE AND b.on_hand > 0), false) AS pending
         FROM stock_balances b
         JOIN scope s ON s.premises_id = b.premises_id
         JOIN stock_locations l ON l.org_id = b.org_id AND l.id = b.location_id
         LEFT JOIN batches bt ON bt.org_id = b.org_id AND bt.id = b.batch_id
        WHERE b.org_id = $1
        GROUP BY b.item_id, b.premises_id)
     SELECT i.id AS "itemId",
            coalesce(sum(bal.on_hand), 0)::int AS "onHandBase",
            coalesce(sum(bal.dispensable), 0)::int AS "dispensableBase",
            coalesce(sum(bal.quarantined), 0)::int AS "quarantinedBase",
            coalesce(sum(bal.expired), 0)::int AS "expiredBase",
            min(bal.nearest)::text AS "nearestExpiry",
            coalesce(bool_or(bal.pending), false) AS "detailsPending",
            (i.reorder_level IS NOT NULL AND EXISTS (
               SELECT 1 FROM cfg
                WHERE coalesce((SELECT b2.dispensable FROM bal b2 WHERE b2.item_id = i.id AND b2.premises_id = cfg.premises_id), 0) < i.reorder_level
            )) AS "lowStock"
       FROM items i LEFT JOIN bal ON bal.item_id = i.id
      WHERE i.org_id = $1 AND ($4::uuid[] IS NULL OR i.id = ANY($4::uuid[]))
      GROUP BY i.org_id, i.id`,
    [orgId, premisesIds, today, itemIds]);
  return new Map(rows.map(({ itemId, ...r }) => [itemId, { ...r, nearExpiry: r.nearestExpiry !== null && r.nearestExpiry <= nearBy }]));
}

export interface BatchView {
  id: string;
  premisesId: string;
  batchNo: string;
  expiryDate: string;
  expiryAsPrinted: string | null;
  expired: boolean;
  mrpPaise: number;
  mrpUnitName: string;
  mrpUnitBaseUnits: number;
  /** D-55: a placeholder; its number, expiry and MRP mean nothing and are not shown. */
  detailsPending: boolean;
  onHandBase: number;
  locations: { locationId: string; name: string; kind: string; onHandBase: number }[];
}

/** E-14's stock part: the item's batches and balances at the caller's premises (no patient data). */
export async function itemStock(db: Db, s: Session, itemId: string): Promise<{ batches: BatchView[]; untracked: { premisesId: string; locationId: string; name: string; kind: string; onHandBase: number }[] }> {
  const today = todayIst();
  const premises = s.premises.map((p) => p.id);
  const rows = await db.rows<{ batchId: string | null; premisesId: string; locationId: string; name: string; kind: string; onHand: number }>(
    `SELECT b.batch_id AS "batchId", b.premises_id AS "premisesId", b.location_id AS "locationId", l.name, l.kind, b.on_hand AS "onHand"
       FROM stock_balances b JOIN stock_locations l ON l.org_id = b.org_id AND l.id = b.location_id
      WHERE b.org_id = $1 AND b.item_id = $2 AND b.premises_id = ANY($3::uuid[])
      ORDER BY l.is_default DESC, l.kind, lower(l.name)`, [s.orgId, itemId, premises]);
  const batches = await db.rows<Omit<BatchView, 'expired' | 'onHandBase' | 'locations'>>(
    `SELECT bt.id, bt.premises_id AS "premisesId", bt.batch_no AS "batchNo", bt.expiry_date::text AS "expiryDate", bt.expiry_as_printed AS "expiryAsPrinted",
            bt.mrp_paise AS "mrpPaise", u.name AS "mrpUnitName", u.base_units_per_unit AS "mrpUnitBaseUnits",
            coalesce(bt.details_pending, false) AS "detailsPending"
       FROM batches bt JOIN item_units u ON u.org_id = bt.org_id AND u.id = bt.mrp_unit_id
      WHERE bt.org_id = $1 AND bt.item_id = $2 AND bt.premises_id = ANY($3::uuid[])
      ORDER BY bt.expiry_date, bt.seq`, [s.orgId, itemId, premises]);
  return {
    batches: batches.map((b) => {
      const locs = rows.filter((r) => r.batchId === b.id).map((r) => ({ locationId: r.locationId, name: r.name, kind: r.kind, onHandBase: r.onHand }));
      return { ...b, expired: b.expiryDate < today, onHandBase: locs.reduce((n, l) => n + l.onHandBase, 0), locations: locs };
    }),
    untracked: rows.filter((r) => r.batchId === null).map((r) => ({ premisesId: r.premisesId, locationId: r.locationId, name: r.name, kind: r.kind, onHandBase: r.onHand })),
  };
}

export interface MovementView {
  id: string;
  type: MovementType;
  qtyDelta: number;
  premisesId: string;
  locationId: string;
  locationName: string;
  batchId: string | null;
  batchNo: string | null;
  expiryDate: string | null;
  referenceType: string;
  referenceId: string;
  reasonCode: string | null;
  note: string | null;
  actorLabel: string;
  occurredAt: string;
  recordedAt: string;
  reversesMovementId: string | null;
}

/**
 * E-18: an item's ledger history at the caller's premises (or one of them), newest first.
 * Ids and document links only: no patient field, ever (06a §16). `seq` is never returned
 * (§2.6 rule 6), so the cursor is (occurred_at, id).
 */
export async function itemMovements(s: Session, itemId: string, q: URLSearchParams): Promise<{ items: MovementView[]; nextCursor: string | null }> {
  const premisesId = q.get('premisesId');
  if (premisesId) requirePremises(s, premisesId.toLowerCase());
  const premises = premisesId ? [premisesId.toLowerCase()] : s.premises.map((p) => p.id);
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
  let after: { t: string; id: string } | null = null;
  const c = q.get('cursor');
  if (c) {
    try { after = JSON.parse(Buffer.from(c, 'base64url').toString()); } catch { throw new HttpError(422, 'FIELD_INVALID', 'Bad cursor.', { field: 'cursor', rule: 'format' }); }
  }
  return withTenant(s.orgId, async (db) => {
    const item = await db.rows('SELECT 1 FROM items WHERE org_id = $1 AND id = $2', [s.orgId, itemId]);
    if (item.length === 0) throw new HttpError(404, 'ITEM_NOT_FOUND', 'No such item.');
    const rows = await db.rows<MovementView & { t: string }>(
      `SELECT m.id, m.movement_type AS type, m.qty_delta AS "qtyDelta", m.premises_id AS "premisesId", m.location_id AS "locationId",
              l.name AS "locationName", m.batch_id AS "batchId", bt.batch_no AS "batchNo", bt.expiry_date::text AS "expiryDate",
              m.reference_type AS "referenceType", m.reference_id AS "referenceId", m.reason_code AS "reasonCode", m.note,
              m.actor_label AS "actorLabel", m.occurred_at AS "occurredAt", m.recorded_at AS "recordedAt",
              m.reverses_movement_id AS "reversesMovementId", to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
         FROM stock_movements m
         JOIN stock_locations l ON l.org_id = m.org_id AND l.id = m.location_id
         LEFT JOIN batches bt ON bt.org_id = m.org_id AND bt.id = m.batch_id
        WHERE m.org_id = $1 AND m.item_id = $2 AND m.premises_id = ANY($3::uuid[])
          AND ($4::timestamptz IS NULL OR (m.occurred_at, m.id) < ($4::timestamptz, $5::uuid))
        ORDER BY m.occurred_at DESC, m.id DESC LIMIT $6`,
      [s.orgId, itemId, premises, after?.t ?? null, after?.id ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ t, ...m }) => { void t; return m; }),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ t: last.t, id: last.id })).toString('base64url') : null,
    };
  });
}
