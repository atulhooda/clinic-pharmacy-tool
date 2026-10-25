import { randomBytes } from 'crypto';
import type { Db } from '../db/db';
import { withTenant } from '../db/tenant';
import { now, todayIst } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import type { Session } from '../auth/guard';
import { consumeGrant } from '../auth/reauth';
import { allocate, isInsufficient, type Allocation, type BatchStock } from './allocate';
import { lockBalances, postMovements, withStockTx, type Actor } from './ledger';
import { inScope } from './scope';

/**
 * The stock side of the desk's sales (06a §6.7, §9.3 desk_sale; D-57). The desk is the only
 * billing system; a bill it issues moves stock here, line by line:
 * - only items given to patients that are RETAIL_PRODUCT (v1), active;
 * - FEFO (allocate.ts) over the premises' default STORE only: never quarantine, never an expired
 *   batch, never a placeholder batch whose details are pending (D-55);
 * - all of a line or none of it: a line that cannot be fully allocated posts nothing and is kept
 *   SHORT with its shortfall, for a person to fix (count or receive stock) and resolve here.
 */
export type DeskLineStatus = 'POSTED' | 'SHORT' | 'REJECTED' | 'CANCELLED';

export interface DeskItem {
  id: string;
  category: string;
  useFor: string | null;
  active: boolean;
}

/** Why an item cannot be sold through the desk (v1), or null if it can. */
export function deskIneligibility(item: DeskItem | undefined): string | null {
  if (!item) return 'unknown_item';
  if (item.category !== 'RETAIL_PRODUCT') return 'not_retail_product';
  // D-54: NULL is the category's default, which for a retail product is "given to patients".
  if (item.useFor === 'IN_CLINIC') return 'not_for_patients';
  if (!item.active) return 'item_inactive';
  return null;
}

export async function deskItemsById(db: Db, orgId: string, ids: readonly string[]): Promise<Map<string, DeskItem>> {
  if (ids.length === 0) return new Map();
  const rows = await db.rows<DeskItem>(
    `SELECT id, category, use_for AS "useFor", active FROM items WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, [...new Set(ids)]]);
  return new Map(rows.map((r) => [r.id, r]));
}

/** The premises' default STORE, if the premises is active and set up for stock. */
export async function defaultStore(db: Db, orgId: string, premisesId: string): Promise<string | null> {
  return (await db.rows<{ id: string }>(
    `SELECT l.id FROM premises p
       JOIN premises_settings ps ON ps.org_id = p.org_id AND ps.premises_id = p.id
       JOIN stock_locations l ON l.org_id = p.org_id AND l.premises_id = p.id AND l.is_default AND l.active AND l.kind = 'STORE'
      WHERE p.org_id = $1 AND p.id = $2 AND p.active`, [orgId, premisesId]))[0]?.id ?? null;
}

export async function quarantineOf(db: Db, orgId: string, premisesId: string): Promise<string | null> {
  return (await db.rows<{ id: string }>(
    `SELECT id FROM stock_locations WHERE org_id = $1 AND premises_id = $2 AND kind = 'QUARANTINE'`, [orgId, premisesId]))[0]?.id ?? null;
}

export type DeskAllocation = { ok: true; allocations: Allocation[] } | { ok: false; shortBase: number; reason: 'insufficient_stock' | 'details_pending' };

/**
 * FEFO for one line at the store. The caller holds the balance locks. Placeholder batches are
 * left out (D-55: never dispensed from); if their stock would have covered the gap, the reason
 * says the details are pending, so the person knows what to fix.
 */
export async function allocateAtStore(db: Db, orgId: string, itemId: string, storeId: string, qtyBase: number, asOf: string): Promise<DeskAllocation> {
  const rows = await db.rows<BatchStock & { pending: boolean }>(
    `SELECT b.batch_id AS "batchId", bt.expiry_date::text AS "expiryDate", coalesce(bt.seq, 0)::int AS "batchSeq", b.on_hand AS available,
            coalesce(bt.details_pending, false) AS pending
       FROM stock_balances b LEFT JOIN batches bt ON bt.org_id = b.org_id AND bt.id = b.batch_id
      WHERE b.org_id = $1 AND b.item_id = $2 AND b.location_id = $3`, [orgId, itemId, storeId]);
  const real = rows.filter((r) => !r.pending);
  const r = allocate(real, qtyBase, asOf);
  if (!isInsufficient(r)) return { ok: true, allocations: r };
  const shortBase = qtyBase - r.availableNonExpired;
  const placeholder = rows.filter((x) => x.pending).reduce((n, x) => n + x.available, 0);
  return { ok: false, shortBase, reason: placeholder >= shortBase ? 'details_pending' : 'insufficient_stock' };
}

/** Record a posted line's allocations and their DISPENSE movements (one per batch), in the caller's transaction. */
export async function postSaleAllocations(db: Db, actor: Actor, at: Date, line: { id: string; premisesId: string; itemId: string; storeId: string },
  allocations: readonly Allocation[]): Promise<void> {
  const ids: string[] = [];
  for (const [i, a] of allocations.entries()) {
    ids.push((await db.rows<{ id: string }>(
      `INSERT INTO desk_sale_allocations (org_id, premises_id, sale_line_id, alloc_no, item_id, batch_id, location_id, qty_base, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [actor.orgId, line.premisesId, line.id, i + 1, line.itemId, a.batchId, line.storeId, a.qtyBase, at]))[0].id);
  }
  await postMovements(db, actor, { occurredAt: at, recordedAt: at }, allocations.map((a, i) => ({
    premisesId: line.premisesId, itemId: line.itemId, batchId: a.batchId, locationId: line.storeId,
    type: 'DISPENSE' as const, qtyDelta: -a.qtyBase, referenceType: 'DESK_SALE_ALLOCATION', referenceId: ids[i],
  })));
}

// ---------------------------------------------------------------- the system actor

export const DESK_ACTOR_NAME = 'Ritu Desk';
const DESK_ACTOR_LOGIN = 'ritu-desk.system';

/** A password hash in the stored shape made of random bytes: no password produces it. */
const unusableHash = () => `scrypt$15$8$1$${randomBytes(16).toString('base64url')}$${randomBytes(32).toString('base64url')}`;

/**
 * The "Ritu Desk" staff row every desk movement names (migration 027), created on first use.
 * It cannot sign in: inactive, no PINs, a hash no password makes; the DB holds all of that.
 */
export async function deskActor(db: Db, orgId: string): Promise<Actor> {
  const find = async () => (await db.rows<{ id: string; name: string }>(
    `SELECT id, name FROM staff_users WHERE org_id = $1 AND system_kind = 'DESK_SYNC'`, [orgId]))[0];
  let row = await find();
  if (!row) {
    await db.rows(
      `INSERT INTO staff_users (org_id, name, login, role_key, password_hash, active, system_kind)
       VALUES ($1, $2, $3, 'reception', $4, false, 'DESK_SYNC') ON CONFLICT DO NOTHING`, [orgId, DESK_ACTOR_NAME, DESK_ACTOR_LOGIN, unusableHash()]);
    row = await find();
  }
  // A person already has the name or the login: say so rather than post as them.
  if (!row) throw new HttpError(503, 'desk_sync_misconfigured', 'The desk sync is not set up correctly.');
  return { orgId, staffUserId: row.id, name: row.name };
}

// ---------------------------------------------------------------- the "Desk sales" page

export interface DeskSaleView {
  id: string;
  premisesId: string;
  billId: string;
  billSerial: string;
  lineKey: string;
  issuedAt: string;
  receivedAt: string;
  itemId: string | null;
  itemName: string | null;
  qtyBase: number;
  baseUnit: string | null;
  status: DeskLineStatus;
  allocatedBase: number;
  shortBase: number;
  reason: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

const VIEW = `
  SELECT d.id, d.premises_id AS "premisesId", d.bill_id AS "billId", d.bill_serial AS "billSerial", d.line_key AS "lineKey",
         d.issued_at AS "issuedAt", d.received_at AS "receivedAt", d.item_id AS "itemId", i.display_name AS "itemName",
         d.qty_base AS "qtyBase", i.base_unit AS "baseUnit", d.status, d.allocated_base AS "allocatedBase", d.short_base AS "shortBase",
         d.reason, d.resolved_at AS "resolvedAt", u.name AS "resolvedBy"
    FROM desk_sale_lines d
    LEFT JOIN items i ON i.org_id = d.org_id AND i.id = d.item_id
    LEFT JOIN staff_users u ON u.org_id = d.org_id AND u.id = d.resolved_by
   WHERE d.org_id = $1`;
type Row = Omit<DeskSaleView, 'issuedAt' | 'receivedAt' | 'resolvedAt'> & { issuedAt: Date; receivedAt: Date; resolvedAt: Date | null };
const view = (r: Row): DeskSaleView => ({ ...r, issuedAt: r.issuedAt.toISOString(), receivedAt: r.receivedAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null });
const notFound = () => new HttpError(404, 'DESK_SALE_NOT_FOUND', 'No such desk sale line.');

/** E-55: the desk's sale lines at the caller's premises: open ones (short or rejected) by default, `?status=all` for every line. */
export async function listDeskSales(s: Session, q: URLSearchParams): Promise<{ items: DeskSaleView[]; open: number }> {
  const status = q.get('status') ?? 'open';
  if (status !== 'open' && status !== 'all') throw new HttpError(422, 'FIELD_INVALID', 'status is open or all.', { field: 'status', rule: 'enum' });
  const premises = s.premises.map((p) => p.id);
  return withTenant(s.orgId, async (db) => {
    const rows = await db.rows<Row>(`${VIEW} AND d.premises_id = ANY($2::uuid[]) ${status === 'open' ? "AND d.status IN ('SHORT','REJECTED')" : ''}
                                     ORDER BY d.received_at DESC, d.id LIMIT 200`, [s.orgId, premises]);
    const open = (await db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM desk_sale_lines WHERE org_id = $1 AND premises_id = ANY($2::uuid[]) AND status IN ('SHORT','REJECTED')`,
      [s.orgId, premises]))[0].n;
    return { items: rows.map(view), open };
  });
}

export async function getDeskSale(s: Session, id: string): Promise<DeskSaleView> {
  const r = await withTenant(s.orgId, async (db) => (await db.rows<Row>(`${VIEW} AND d.id = $2`, [s.orgId, id]))[0]);
  if (!r || !inScope(s, r.premisesId)) throw notFound();
  return view(r);
}

/**
 * E-56: try a short or rejected line again, after stock was counted or received (or the item
 * corrected). A line a credit note has reached is refused (409 DESK_SALE_CREDITED). Signed with the `stock.adjust` grant for the line's premises (D-33). The movements
 * name the person who resolved it. Still short: the line stays SHORT with the new shortfall.
 */
export async function resolveDeskSale(s: Session, id: string, grantId: string | undefined): Promise<DeskSaleView> {
  await withStockTx(s, async (db) => {
    const line = (await db.rows<{ premisesId: string; itemId: string | null; qtyBase: number; status: DeskLineStatus }>(
      `SELECT premises_id AS "premisesId", item_id AS "itemId", qty_base AS "qtyBase", status FROM desk_sale_lines WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [s.orgId, id]))[0];
    if (!line || !inScope(s, line.premisesId)) throw notFound();
    if (line.status === 'POSTED') throw new HttpError(409, 'DESK_SALE_POSTED', 'This line has already taken its stock.');
    // A credit note reached it: the sale was refunded, so its stock must never go out (the DB guard backs this).
    const credited = line.status === 'CANCELLED'
      || (await db.rows('SELECT 1 FROM desk_return_lines WHERE org_id = $1 AND sale_line_id = $2 LIMIT 1', [s.orgId, id])).length > 0;
    if (credited) throw new HttpError(409, 'DESK_SALE_CREDITED', 'This sale was credited at the desk; there is nothing to take.');
    await consumeGrant(db, s, 'stock.adjust', line.premisesId, grantId);
    const at = now();
    const actor: Actor = { orgId: s.orgId, staffUserId: s.staffUserId, name: s.name };
    const audit = (kind: string) => writeAudit(db, { orgId: s.orgId, action: 'stock.desk_sale_resolve', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { kind } });
    const item = line.itemId ? (await deskItemsById(db, s.orgId, [line.itemId])).get(line.itemId) : undefined;
    const reject = deskIneligibility(item);
    if (reject) {
      await db.rows(`UPDATE desk_sale_lines SET status = 'REJECTED', short_base = 0, reason = $3 WHERE org_id = $1 AND id = $2`, [s.orgId, id, reject]);
      await audit('rejected');
      return;
    }
    const storeId = await defaultStore(db, s.orgId, line.premisesId);
    if (!storeId) throw new HttpError(409, 'PREMISES_NOT_CONFIGURED', 'This premises is not set up for stock yet.');
    await lockBalances(db, s.orgId, [{ itemId: line.itemId!, locationId: storeId }]);
    const r = await allocateAtStore(db, s.orgId, line.itemId!, storeId, line.qtyBase, todayIst());
    if (!r.ok) {
      await db.rows(`UPDATE desk_sale_lines SET status = 'SHORT', short_base = $3, reason = $4 WHERE org_id = $1 AND id = $2`, [s.orgId, id, r.shortBase, r.reason]);
      await audit('short');
      return;
    }
    await postSaleAllocations(db, actor, at, { id, premisesId: line.premisesId, itemId: line.itemId!, storeId }, r.allocations);
    await db.rows(`UPDATE desk_sale_lines SET status = 'POSTED', allocated_base = qty_base, short_base = 0, reason = NULL, location_id = $3,
                          resolved_at = $4, resolved_by = $5 WHERE org_id = $1 AND id = $2`, [s.orgId, id, storeId, at, s.staffUserId]);
    await audit('posted');
  });
  return getDeskSale(s, id);
}
