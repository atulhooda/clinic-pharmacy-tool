import type { Db } from '../../db/db';
import { withTenant } from '../../db/tenant';
import { istDate, now } from '../../clock';
import { AuthError, HttpError } from '../../http/errors';
import { UUID_PATTERN } from '../../http/body';
import { log } from '../../log';
import { lockBalances, postMovements, type Actor } from '../../stock/ledger';
import {
  allocateAtStore, defaultStore, deskActor, deskIneligibility, deskItemsById, postSaleAllocations, quarantineOf, type DeskLineStatus,
} from '../../stock/desk-sales';
import type { DeskContext } from './route';

/**
 * The pharmacy half of the desk ⇄ pharmacy stock sync (06a §9.3, §12.5; D-57):
 * - E-52 items: the retail products the desk may link a price-list line to, with stock and the highest MRP;
 * - E-53 sales: an issued bill's lines take stock (FEFO), each line all or nothing, idempotent per (bill, line);
 * - E-54 returns: a credit note's lines put back what the bill line took, never more, idempotent per (credit note, line).
 * Every movement names the "Ritu Desk" system actor. The organisation and premises are the env's.
 */

// ---------------------------------------------------------------- shared

/** One transaction per request; a deadlock or serialisation failure is retried at most twice (§9.1). */
export async function withDeskTx<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTenant(orgId, fn);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '40P01' && code !== '40001') throw err;
      if (attempt >= 2) throw new HttpError(503, 'RETRY_LATER', 'The stock was busy. Try again.');
    }
  }
}

/**
 * The nonce is single-use: consumed in the request's own transaction, so a failed request leaves
 * it unused. Kept for good (the app role deletes nothing, 06b DMG-07): stricter than the 10-minute
 * replay window the contract asks for, and a request outside ±120 s never reaches this.
 */
async function consumeNonce(db: Db, ctx: DeskContext): Promise<void> {
  const at = now();
  const r = await db.rows(`INSERT INTO desk_sync_nonces (org_id, nonce, seen_at) VALUES ($1, $2, $3)
                           ON CONFLICT ON CONSTRAINT desk_sync_nonces_key DO NOTHING RETURNING id`, [ctx.orgId, ctx.nonce, at]);
  if (r.length === 0) throw new AuthError(401, 'nonce_reused', 'This request was already received.');
}

async function storeFor(db: Db, ctx: DeskContext): Promise<string> {
  const storeId = await defaultStore(db, ctx.orgId, ctx.premisesId);
  if (!storeId) {
    log('desk_sync_misconfigured', { check: 'premises' });
    throw new HttpError(503, 'desk_sync_misconfigured', 'The desk sync is not set up correctly.');
  }
  return storeId;
}

const bad = (field: string, rule: string) => new HttpError(422, 'FIELD_INVALID', `${field} is not valid.`, { field, rule });
const LINE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_LINES = 200;
const MAX_QTY = 1_000_000;

function object(v: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad(at || 'body', 'object');
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) throw new HttpError(422, 'UNKNOWN_FIELD', 'The request has a field this route does not accept.', { field: at ? `${at}.${k}` : k });
  }
  for (const k of keys) if ((v as Record<string, unknown>)[k] === undefined) throw new HttpError(422, 'FIELD_REQUIRED', 'A required field is missing.', { field: at ? `${at}.${k}` : k });
  return v as Record<string, unknown>;
}
const uuid = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !UUID_PATTERN.test(v)) throw bad(field, 'uuid');
  return v.toLowerCase();
};
const lineKey = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !LINE_KEY.test(v)) throw bad(field, 'format');
  return v;
};
const qty = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > MAX_QTY) throw bad(field, 'int');
  return v;
};
function lines<T extends { lineKey: string }>(v: unknown, parse: (o: unknown, at: string) => T): T[] {
  if (!Array.isArray(v) || v.length === 0) throw bad('lines', 'required');
  if (v.length > MAX_LINES) throw bad('lines', 'max');
  const out = v.map((o, i) => parse(o, `lines[${i}]`));
  if (new Set(out.map((l) => l.lineKey)).size !== out.length) throw new HttpError(422, 'DUPLICATE_LINE_KEY', 'Each line has its own lineKey.');
  return out;
}

// ---------------------------------------------------------------- E-52 items

export interface DeskItemView {
  id: string;
  displayName: string;
  category: string;
  baseUnit: string;
  onHandBase: number;
  dispensableBase: number;
  maxMrpPaisePerBase: number | null;
  active: boolean;
}

/**
 * The retail products given to patients (v1), active, with their stock at the env premises:
 * - onHandBase: everything on hand there (any location, any batch);
 * - dispensableBase: what a sale can take: the default store, unexpired, not a placeholder batch;
 * - maxMrpPaisePerBase: the highest MRP per base unit (rounded up) among batches with stock that
 *   is not quarantined, not expired and not a placeholder; null if there are none. The desk warns,
 *   never blocks, when a price is above it.
 */
export async function deskItems(ctx: DeskContext): Promise<{ items: DeskItemView[] }> {
  return withDeskTx(ctx.orgId, async (db) => {
    await consumeNonce(db, ctx);
    const storeId = await storeFor(db, ctx);
    const items = await db.rows<DeskItemView>(
      `WITH bal AS (
         SELECT b.item_id,
                sum(b.on_hand)::int AS on_hand,
                coalesce(sum(b.on_hand) FILTER (WHERE b.location_id = $3 AND bt.details_pending IS NOT TRUE AND bt.expiry_date >= $4::date), 0)::int AS dispensable,
                max(ceil(bt.mrp_paise::numeric / u.base_units_per_unit)) FILTER (
                  WHERE b.on_hand > 0 AND l.kind <> 'QUARANTINE' AND bt.details_pending IS NOT TRUE AND bt.expiry_date >= $4::date)::bigint AS max_mrp
           FROM stock_balances b
           JOIN stock_locations l ON l.org_id = b.org_id AND l.id = b.location_id
           LEFT JOIN batches bt ON bt.org_id = b.org_id AND bt.id = b.batch_id
           LEFT JOIN item_units u ON u.org_id = bt.org_id AND u.id = bt.mrp_unit_id
          WHERE b.org_id = $1 AND b.premises_id = $2
          GROUP BY b.item_id)
       SELECT i.id, i.display_name AS "displayName", i.category, i.base_unit AS "baseUnit",
              coalesce(bal.on_hand, 0) AS "onHandBase", coalesce(bal.dispensable, 0) AS "dispensableBase",
              bal.max_mrp AS "maxMrpPaisePerBase", i.active
         FROM items i LEFT JOIN bal ON bal.item_id = i.id
        WHERE i.org_id = $1 AND i.active AND i.category = 'RETAIL_PRODUCT' AND coalesce(i.use_for, 'PATIENTS') IN ('PATIENTS','BOTH')
        ORDER BY lower(i.display_name)`,
      [ctx.orgId, ctx.premisesId, storeId, istDate(now())]);
    return { items: items.map((i) => ({ ...i, maxMrpPaisePerBase: i.maxMrpPaisePerBase === null ? null : Number(i.maxMrpPaisePerBase) })) };
  });
}

// ---------------------------------------------------------------- E-53 sales

export interface SaleLineInput { lineKey: string; itemId: string; qtyBase: number }
export interface SalesInput { billId: string; serial: string; issuedAt: Date; lines: SaleLineInput[] }
export interface SaleLineResult { lineKey: string; status: 'posted' | 'short' | 'rejected' | 'cancelled'; allocatedBase: number; shortBase: number; reason: string | null }

export function parseSales(body: unknown): SalesInput {
  const o = object(body, '', ['billId', 'serial', 'issuedAt', 'lines']);
  if (typeof o.serial !== 'string' || o.serial.trim().length < 1 || o.serial.trim().length > 40) throw bad('serial', 'length');
  const issuedAt = typeof o.issuedAt === 'string' ? new Date(o.issuedAt) : null;
  if (!issuedAt || Number.isNaN(issuedAt.getTime())) throw bad('issuedAt', 'format');
  return {
    billId: uuid(o.billId, 'billId'), serial: o.serial.trim(), issuedAt,
    lines: lines(o.lines, (l, at) => {
      const x = object(l, at, ['lineKey', 'itemId', 'qtyBase']);
      return { lineKey: lineKey(x.lineKey, `${at}.lineKey`), itemId: uuid(x.itemId, `${at}.itemId`), qtyBase: qty(x.qtyBase, `${at}.qtyBase`) };
    }),
  };
}

interface StoredSale { lineKey: string; status: DeskLineStatus; allocatedBase: number; shortBase: number; reason: string | null }
const saleResult = (r: StoredSale): SaleLineResult => ({
  lineKey: r.lineKey, status: r.status.toLowerCase() as SaleLineResult['status'], allocatedBase: r.allocatedBase, shortBase: r.shortBase, reason: r.reason,
});

async function storedSales(db: Db, ctx: DeskContext, billId: string, keys: string[]): Promise<Map<string, StoredSale>> {
  const rows = await db.rows<StoredSale>(
    `SELECT line_key AS "lineKey", status, allocated_base AS "allocatedBase", short_base AS "shortBase", reason
       FROM desk_sale_lines WHERE org_id = $1 AND bill_id = $2 AND line_key = ANY($3::text[])`, [ctx.orgId, billId, keys]);
  return new Map(rows.map((r) => [r.lineKey, r]));
}

/**
 * Each new line, in body order: rejected (not a sellable item), or FEFO at the store under the
 * balance locks; fully allocated → POSTED with its DISPENSE movements, else SHORT with nothing
 * posted. The line row is inserted before any movement, ON CONFLICT DO NOTHING on (bill, line):
 * a line already stored (by an earlier call, or a concurrent one that committed first) moves
 * nothing and answers with what was stored.
 */
export async function postDeskSales(ctx: DeskContext, input: SalesInput): Promise<{ lines: SaleLineResult[] }> {
  return withDeskTx(ctx.orgId, async (db) => {
    await consumeNonce(db, ctx);
    const storeId = await storeFor(db, ctx);
    const keys = input.lines.map((l) => l.lineKey);
    let stored = await storedSales(db, ctx, input.billId, keys);
    const fresh = input.lines.filter((l) => !stored.has(l.lineKey));
    if (fresh.length) {
      const actor = await deskActor(db, ctx.orgId);
      const items = await deskItemsById(db, ctx.orgId, fresh.map((l) => l.itemId));
      await lockBalances(db, ctx.orgId, fresh.filter((l) => !deskIneligibility(items.get(l.itemId))).map((l) => ({ itemId: l.itemId, locationId: storeId })));
      const at = now();
      const asOf = istDate(at);
      for (const l of fresh) {
        const item = items.get(l.itemId);
        const reject = deskIneligibility(item);
        const r = reject ? null : await allocateAtStore(db, ctx.orgId, l.itemId, storeId, l.qtyBase, asOf);
        const status: DeskLineStatus = reject ? 'REJECTED' : r!.ok ? 'POSTED' : 'SHORT';
        const ins = await db.rows<{ id: string }>(
          `INSERT INTO desk_sale_lines (org_id, premises_id, bill_id, line_key, bill_serial, issued_at, requested_item_id, item_id, qty_base,
                                        status, allocated_base, short_base, reason, location_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT ON CONSTRAINT desk_sale_lines_key DO NOTHING RETURNING id`,
          [ctx.orgId, ctx.premisesId, input.billId, l.lineKey, input.serial, input.issuedAt, l.itemId, item ? item.id : null, l.qtyBase,
            status, status === 'POSTED' ? l.qtyBase : 0, r && !r.ok ? r.shortBase : 0, reject ?? (r && !r.ok ? r.reason : null),
            status === 'POSTED' ? storeId : null, at]);
        // Stored first by a concurrent call: nothing moves here; its result is read below.
        if (ins.length === 0) continue;
        if (r && r.ok) await postSaleAllocations(db, actor, at, { id: ins[0].id, premisesId: ctx.premisesId, itemId: l.itemId, storeId }, r.allocations);
      }
      stored = await storedSales(db, ctx, input.billId, keys);
    }
    return { lines: input.lines.map((l) => saleResult(stored.get(l.lineKey)!)) };
  });
}

// ---------------------------------------------------------------- E-54 returns

export interface ReturnLineInput { lineKey: string; qtyBase: number }
export interface ReturnsInput { creditNoteId: string; billId: string; lines: ReturnLineInput[] }
export interface ReturnLineResult { lineKey: string; status: 'returned' | 'nothing_to_return'; returnedBase: number; reason: string | null }

export function parseReturns(body: unknown): ReturnsInput {
  const o = object(body, '', ['creditNoteId', 'billId', 'lines']);
  return {
    creditNoteId: uuid(o.creditNoteId, 'creditNoteId'), billId: uuid(o.billId, 'billId'),
    lines: lines(o.lines, (l, at) => {
      const x = object(l, at, ['lineKey', 'qtyBase']);
      return { lineKey: lineKey(x.lineKey, `${at}.lineKey`), qtyBase: qty(x.qtyBase, `${at}.qtyBase`) };
    }),
  };
}

interface StoredReturn { lineKey: string; status: 'RETURNED' | 'NOTHING_TO_RETURN'; returnedBase: number; reason: string | null }
const returnResult = (r: StoredReturn): ReturnLineResult => ({
  lineKey: r.lineKey, status: r.status.toLowerCase() as ReturnLineResult['status'], returnedBase: r.returnedBase, reason: r.reason,
});

async function storedReturns(db: Db, ctx: DeskContext, creditNoteId: string, keys: string[]): Promise<Map<string, StoredReturn>> {
  const rows = await db.rows<StoredReturn>(
    `SELECT line_key AS "lineKey", status, returned_base AS "returnedBase", reason
       FROM desk_return_lines WHERE org_id = $1 AND credit_note_id = $2 AND line_key = ANY($3::text[])`, [ctx.orgId, creditNoteId, keys]);
  return new Map(rows.map((r) => [r.lineKey, r]));
}

interface SaleAlloc { id: string; saleLineId: string; allocNo: number; itemId: string; batchId: string | null; locationId: string;
  qtyBase: number; back: number; expiryDate: string | null }

/**
 * Each new credit-note line puts back up to what its bill line took and has not yet had back:
 * the bill line's allocations newest-first (the reverse of FEFO), each to its own batch, as
 * PATIENT_RETURN movements (a partial return cannot be a REVERSAL, which mirrors its original
 * exactly, L-8). Stock whose batch has expired by now goes to quarantine (D-14). A bill line that
 * never posted (short or rejected) has nothing to return, and the credit closes it (CANCELLED), so a
 * later Retry can never send stock out for a refunded sale. A line whose sale has not arrived yet
 * fails the whole request with a retryable 409 `sale_not_received`, storing nothing. The sale lines are locked first, so two
 * credit notes for one line take turns; the DB trigger caps the sum regardless.
 */
export async function postDeskReturns(ctx: DeskContext, input: ReturnsInput): Promise<{ lines: ReturnLineResult[] }> {
  return withDeskTx(ctx.orgId, async (db) => {
    await consumeNonce(db, ctx);
    await storeFor(db, ctx);
    const keys = input.lines.map((l) => l.lineKey);
    let stored = await storedReturns(db, ctx, input.creditNoteId, keys);
    const fresh = input.lines.filter((l) => !stored.has(l.lineKey));
    if (fresh.length) {
      const actor: Actor = await deskActor(db, ctx.orgId);
      const sales = new Map((await db.rows<{ id: string; lineKey: string; status: DeskLineStatus }>(
        `SELECT id, line_key AS "lineKey", status FROM desk_sale_lines
          WHERE org_id = $1 AND premises_id = $2 AND bill_id = $3 AND line_key = ANY($4::text[]) ORDER BY id FOR UPDATE`,
        [ctx.orgId, ctx.premisesId, input.billId, fresh.map((l) => l.lineKey)])).map((r) => [r.lineKey, r]));
      // The sale has not reached the pharmacy yet (the desk sends its outbox in no guaranteed order):
      // store nothing for this credit note and answer a retryable 409, so the desk's retry after
      // the sale posts puts the stock back. Never a final rejection: the bill is not known to be
      // unknown forever.
      const missing = fresh.filter((l) => !sales.has(l.lineKey)).map((l) => l.lineKey);
      if (missing.length) throw new HttpError(409, 'sale_not_received', 'The sale for this credit note has not reached the pharmacy yet. Retry later.', { lineKeys: missing });
      const saleIds = [...sales.values()].map((s) => s.id);
      const allocs = saleIds.length ? await db.rows<SaleAlloc>(
        `SELECT a.id, a.sale_line_id AS "saleLineId", a.alloc_no AS "allocNo", a.item_id AS "itemId", a.batch_id AS "batchId",
                a.location_id AS "locationId", a.qty_base AS "qtyBase", bt.expiry_date::text AS "expiryDate",
                coalesce((SELECT sum(r.qty_base) FROM desk_return_allocations r WHERE r.org_id = a.org_id AND r.sale_allocation_id = a.id), 0)::int AS back
           FROM desk_sale_allocations a LEFT JOIN batches bt ON bt.org_id = a.org_id AND bt.id = a.batch_id
          WHERE a.org_id = $1 AND a.sale_line_id = ANY($2::uuid[])
          ORDER BY a.sale_line_id, a.alloc_no DESC`, [ctx.orgId, saleIds]) : [];
      const quarantine = await quarantineOf(db, ctx.orgId, ctx.premisesId);
      const at = now();
      const asOf = istDate(at);
      const target = (a: SaleAlloc) => (a.expiryDate !== null && a.expiryDate < asOf && quarantine ? quarantine : a.locationId);
      await lockBalances(db, ctx.orgId, allocs.flatMap((a) => [{ itemId: a.itemId, locationId: a.locationId }, { itemId: a.itemId, locationId: target(a) }]));
      for (const l of fresh) {
        const sale = sales.get(l.lineKey);
        const mine = sale ? allocs.filter((a) => a.saleLineId === sale.id) : [];
        const remaining = mine.reduce((n, a) => n + a.qtyBase - a.back, 0);
        let status: StoredReturn['status'];
        let reason: string | null = null;
        if (!sale) throw new HttpError(409, 'sale_not_received', 'The sale for this credit note has not reached the pharmacy yet. Retry later.');
        else if (sale.status !== 'POSTED') [status, reason] = ['NOTHING_TO_RETURN', 'not_posted'];
        else if (remaining === 0) [status, reason] = ['NOTHING_TO_RETURN', 'already_returned'];
        else [status, reason] = ['RETURNED', l.qtyBase > remaining ? 'more_than_taken' : null];
        const take = status === 'RETURNED' ? Math.min(l.qtyBase, remaining) : 0;
        const ins = await db.rows<{ id: string }>(
          `INSERT INTO desk_return_lines (org_id, premises_id, credit_note_id, bill_id, line_key, sale_line_id, qty_base, returned_base, status, reason, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT ON CONSTRAINT desk_return_lines_key DO NOTHING RETURNING id`,
          [ctx.orgId, ctx.premisesId, input.creditNoteId, input.billId, l.lineKey, sale?.id ?? null, l.qtyBase, take, status, reason, at]);
        if (ins.length === 0) continue;
        // A credit for a line that never took stock closes it: it leaves the Desk sales list and can never be resolved.
        if (sale!.status === 'SHORT' || sale!.status === 'REJECTED') {
          await db.rows(`UPDATE desk_sale_lines SET status = 'CANCELLED', short_base = 0, reason = 'credited' WHERE org_id = $1 AND id = $2`, [ctx.orgId, sale!.id]);
        }
        if (take === 0) continue;
        let left = take;
        for (const a of mine) {   // newest first
          if (left === 0) break;
          const n = Math.min(left, a.qtyBase - a.back);
          if (n <= 0) continue;
          const id = (await db.rows<{ id: string }>(
            `INSERT INTO desk_return_allocations (org_id, premises_id, return_line_id, sale_allocation_id, item_id, batch_id, location_id, qty_base, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [ctx.orgId, ctx.premisesId, ins[0].id, a.id, a.itemId, a.batchId, target(a), n, at]))[0].id;
          await postMovements(db, actor, { occurredAt: at, recordedAt: at }, [{
            premisesId: ctx.premisesId, itemId: a.itemId, batchId: a.batchId, locationId: target(a),
            type: 'PATIENT_RETURN', qtyDelta: n, referenceType: 'DESK_RETURN_ALLOCATION', referenceId: id,
          }]);
          a.back += n;
          left -= n;
        }
      }
      stored = await storedReturns(db, ctx, input.creditNoteId, keys);
    }
    return { lines: input.lines.map((l) => returnResult(stored.get(l.lineKey)!)) };
  });
}
