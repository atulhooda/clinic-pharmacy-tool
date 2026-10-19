import type { Db } from '../db/db';
import { withTenant } from '../db/tenant';
import { now, todayIst } from '../clock';
import { HttpError } from '../http/errors';
import { UUID_PATTERN } from '../http/body';
import { writeAudit } from '../audit';
import type { Session } from '../auth/guard';
import { consumeGrant } from '../auth/reauth';
import { inScope, requirePremises } from './scope';
import { lockBalances, normaliseBatchNo, postMovements, resolveBatch, withStockTx, type MovementInput } from './ledger';
import { parseExpiry } from './receipts';

/**
 * Stock adjustments (06a §6.7, §9.3 adjust_stock; E-34; D-53, PR 10a). A person counts what is on
 * the shelf and enters the count; the service turns it into one movement per line, in base units:
 * - a key (item, batch, location) with no movement yet gets an OPENING_BALANCE of the count;
 * - a key with movements gets a STOCKTAKE_ADJUSTMENT of (count − on hand), with a reason.
 * The difference is taken under the balance locks, so two people counting at once cannot both
 * apply the same correction. Signed with the `stock.adjust` grant for the premises (D-33).
 * The write-off kinds (EXPIRY_WRITEOFF, DAMAGE_WRITEOFF) come with PR 10.
 */
export const COUNT_REASONS = ['COUNT_CORRECTION', 'FOUND', 'DATA_ENTRY_ERROR', 'OTHER'] as const;
export type CountReason = (typeof COUNT_REASONS)[number];

export interface NewBatch {
  batchNo: string;
  /** As printed: `MM/YYYY`, `MM/YY`, or `YYYY-MM-DD`. */
  expiry: string;
  mrpPaise: number;
  mrpUnitId: string;
}
export interface CountLine {
  itemId: string;
  batchId: string | null;
  newBatch: NewBatch | null;
  locationId: string | null;
  countedBase: number;
  /** D-55: no batch number, expiry or MRP to hand: hold the count on the item's placeholder batch. */
  pendingDetails: boolean;
}
export interface AdjustInput {
  premisesId: string;
  reasonCode: string | null;
  note: string | null;
  lines: CountLine[];
}

const MAX_LINES = 100;
const MAX_COUNT = 2_000_000_000;
const MAX_PAISE = 10_000_000_000;
const LINE_KEYS = new Set(['itemId', 'batchId', 'newBatch', 'locationId', 'countedBase', 'pendingDetails']);
const BATCH_KEYS = new Set(['batchNo', 'expiry', 'mrpPaise', 'mrpUnitId']);

const bad = (field: string, rule: string) => new HttpError(422, 'FIELD_INVALID', `${field} is not valid.`, { field, rule });
const uuid = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !UUID_PATTERN.test(v)) throw bad(field, 'uuid');
  return v.toLowerCase();
};
const unknownKeys = (o: object, allowed: Set<string>, at: string) => {
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new HttpError(422, 'UNKNOWN_FIELD', `Unknown field ${at}.${k}.`, { field: `${at}.${k}` });
};

/** Validate the lines' shape; references are checked against the organisation in the transaction. */
export function parseCountLines(raw: unknown): CountLine[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad('lines', 'required');
  if (raw.length > MAX_LINES) throw bad('lines', 'max');
  return raw.map((r, i) => {
    const at = `lines[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad(at, 'object');
    unknownKeys(r, LINE_KEYS, at);
    const o = r as Record<string, unknown>;
    const counted = o.countedBase;
    if (typeof counted !== 'number' || !Number.isSafeInteger(counted) || counted < 0 || counted > MAX_COUNT) throw bad(`${at}.countedBase`, 'int');
    let newBatch: NewBatch | null = null;
    if (o.newBatch !== undefined && o.newBatch !== null) {
      const b = o.newBatch as Record<string, unknown>;
      if (typeof b !== 'object' || Array.isArray(b)) throw bad(`${at}.newBatch`, 'object');
      unknownKeys(b, BATCH_KEYS, `${at}.newBatch`);
      if (typeof b.batchNo !== 'string' || !b.batchNo.trim() || b.batchNo.trim().length > 40) throw bad(`${at}.newBatch.batchNo`, 'length');
      if (typeof b.expiry !== 'string' || !parseExpiry(b.expiry)) throw bad(`${at}.newBatch.expiry`, 'format');
      if (typeof b.mrpPaise !== 'number' || !Number.isSafeInteger(b.mrpPaise) || b.mrpPaise < 1 || b.mrpPaise > MAX_PAISE) throw bad(`${at}.newBatch.mrpPaise`, 'int');
      newBatch = { batchNo: normaliseBatchNo(b.batchNo), expiry: b.expiry.trim(), mrpPaise: b.mrpPaise, mrpUnitId: uuid(b.mrpUnitId, `${at}.newBatch.mrpUnitId`) };
    }
    const batchId = o.batchId === undefined || o.batchId === null ? null : uuid(o.batchId, `${at}.batchId`);
    if (batchId && newBatch) throw new HttpError(422, 'FIELD_INVALID', 'Name an existing batch or a new one, not both.', { field: `${at}.newBatch`, rule: 'exclusive' });
    if (o.pendingDetails !== undefined && typeof o.pendingDetails !== 'boolean') throw bad(`${at}.pendingDetails`, 'bool');
    const pendingDetails = o.pendingDetails === true;
    if (pendingDetails && (batchId || newBatch)) throw new HttpError(422, 'FIELD_INVALID', 'A count with details pending names no batch.', { field: `${at}.pendingDetails`, rule: 'exclusive' });
    return { itemId: uuid(o.itemId, `${at}.itemId`), batchId, newBatch, locationId: o.locationId === undefined || o.locationId === null ? null : uuid(o.locationId, `${at}.locationId`),
      countedBase: counted, pendingDetails };
  });
}

interface ItemInfo { id: string; trackBatches: boolean; active: boolean; mfrName: string | null; mfrAddress: string | null }
interface Location { id: string; kind: string; isDefault: boolean; active: boolean }

async function premisesReady(db: Db, orgId: string, premisesId: string): Promise<Location[]> {
  if ((await db.rows('SELECT 1 FROM premises_settings WHERE org_id = $1 AND premises_id = $2', [orgId, premisesId])).length === 0) {
    throw new HttpError(409, 'PREMISES_NOT_CONFIGURED', 'This premises is not set up for stock yet.');
  }
  return db.rows<Location>('SELECT id, kind, is_default AS "isDefault", active FROM stock_locations WHERE org_id = $1 AND premises_id = $2', [orgId, premisesId]);
}

const notFound = () => new HttpError(404, 'ADJUSTMENT_NOT_FOUND', 'No such adjustment.');

/** D-55: the item's placeholder batch at the premises (one per item and premises), created on first use. */
async function pendingBatch(db: Db, orgId: string, premisesId: string, itemId: string): Promise<string> {
  const find = async () => (await db.rows<{ id: string }>(
    `SELECT id FROM batches WHERE org_id = $1 AND premises_id = $2 AND item_id = $3 AND details_pending IS TRUE`, [orgId, premisesId, itemId]))[0]?.id;
  const found = await find();
  if (found) return found;
  const ins = await db.rows<{ id: string }>(
    `INSERT INTO batches (org_id, premises_id, item_id, batch_no, expiry_date, mrp_paise, mrp_unit_id, details_pending)
     SELECT $1, $2, $3, 'DETAILS PENDING', DATE '2099-12-31', 1, u.id, true FROM item_units u WHERE u.org_id = $1 AND u.item_id = $3 AND u.is_base
     ON CONFLICT ON CONSTRAINT batches_number_key DO NOTHING RETURNING id`, [orgId, premisesId, itemId]);
  return ins[0]?.id ?? (await find())!;
}

/** E-34 POST (count kinds): count lines → one OPENING_BALANCE or STOCKTAKE_ADJUSTMENT document. */
export async function adjustStock(s: Session, input: AdjustInput, grantId: string | undefined): Promise<string> {
  requirePremises(s, input.premisesId);
  const reason = input.reasonCode;
  if (reason !== null && !(COUNT_REASONS as readonly string[]).includes(reason)) throw bad('reasonCode', 'enum');
  if (reason === 'OTHER' && !input.note) throw new HttpError(422, 'NOTE_REQUIRED', 'Say what happened when the reason is "other".');
  return withStockTx(s, async (db) => {
    const locations = await premisesReady(db, s.orgId, input.premisesId);
    await consumeGrant(db, s, 'stock.adjust', input.premisesId, grantId);
    const today = todayIst();
    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const items = new Map((await db.rows<ItemInfo>(
      `SELECT i.id, i.track_batches AS "trackBatches", i.active,
              coalesce(i.custom_manufacturer_name, m.manufacturer_name) AS "mfrName",
              coalesce(i.custom_manufacturer_address, m.manufacturer_address) AS "mfrAddress"
         FROM items i LEFT JOIN medicine_master m ON m.id = i.master_id
        WHERE i.org_id = $1 AND i.id = ANY($2::uuid[])`, [s.orgId, itemIds])).map((i) => [i.id, i]));

    // Resolve each line to its key: the batch (named, or created) and the location.
    const keyed: { line: CountLine; lineNo: number; batchId: string | null; locationId: string }[] = [];
    for (const [i, l] of input.lines.entries()) {
      const lineNo = i + 1;
      const item = items.get(l.itemId);
      if (!item) throw new HttpError(404, 'ITEM_NOT_FOUND', 'No such item.', { lineNo });
      if (!item.active) throw new HttpError(422, 'ITEM_INACTIVE', 'This item is no longer active.', { lineNo });
      let batchId: string | null = null;
      let expired = false;
      if (item.trackBatches) {
        if (l.batchId) {
          const b = (await db.rows<{ expiry: string }>('SELECT expiry_date::text AS expiry FROM batches WHERE org_id = $1 AND premises_id = $2 AND item_id = $3 AND id = $4',
            [s.orgId, input.premisesId, l.itemId, l.batchId]))[0];
          if (!b) throw new HttpError(404, 'BATCH_NOT_FOUND', 'No such batch of that item here.', { lineNo });
          batchId = l.batchId;
          expired = b.expiry < today;
        } else if (l.newBatch) {
          const unit = (await db.rows('SELECT 1 FROM item_units WHERE org_id = $1 AND item_id = $2 AND id = $3', [s.orgId, l.itemId, l.newBatch.mrpUnitId]))[0];
          if (!unit) throw new HttpError(404, 'UNIT_NOT_FOUND', 'No such unit of that item.', { lineNo });
          const exp = parseExpiry(l.newBatch.expiry)!;
          batchId = (await resolveBatch(db, s.orgId, { premisesId: input.premisesId, itemId: l.itemId, batchNo: l.newBatch.batchNo, expiryDate: exp.date,
            expiryAsPrinted: exp.printed, mrpPaise: l.newBatch.mrpPaise, mrpUnitId: l.newBatch.mrpUnitId, manufacturerName: item.mfrName, manufacturerAddress: item.mfrAddress })).id;
          expired = exp.date < today;
        } else if (l.pendingDetails) {
          batchId = await pendingBatch(db, s.orgId, input.premisesId, l.itemId);
        } else {
          throw new HttpError(422, 'BATCH_DETAILS_REQUIRED', 'Pick the batch you counted, or add its batch number, expiry and MRP.', { lineNo });
        }
      } else if (l.batchId || l.newBatch || l.pendingDetails) {
        throw new HttpError(422, 'BATCH_NOT_TRACKED', 'This item is not batch-tracked; leave the batch empty.', { lineNo });
      }
      // A named location must be this premises' and working; otherwise the default store, or
      // quarantine for expired stock (D-14: expired stock never sits on the shelf).
      let loc: Location | undefined;
      if (l.locationId) {
        loc = locations.find((x) => x.id === l.locationId);
        if (!loc || !loc.active) throw new HttpError(404, 'LOCATION_NOT_FOUND', 'No such location at that premises.', { lineNo });
      } else {
        loc = expired ? locations.find((x) => x.kind === 'QUARANTINE') : locations.find((x) => x.isDefault);
        if (!loc) throw new HttpError(409, 'PREMISES_NOT_CONFIGURED', 'This premises has no store set up.', { lineNo });
      }
      keyed.push({ line: l, lineNo, batchId, locationId: loc.id });
    }
    const seen = new Set<string>();
    for (const k of keyed) {
      const key = `${k.line.itemId}/${k.batchId}/${k.locationId}`;
      if (seen.has(key)) throw new HttpError(422, 'DUPLICATE_LINE', 'The same batch is counted twice.', { lineNo: k.lineNo });
      seen.add(key);
    }

    // Under the locks: what is on hand now, and whether the key has ever moved.
    await lockBalances(db, s.orgId, keyed.map((k) => ({ itemId: k.line.itemId, locationId: k.locationId })));
    const lines: { k: (typeof keyed)[number]; delta: number; opening: boolean }[] = [];
    for (const k of keyed) {
      const p = [s.orgId, input.premisesId, k.line.itemId, k.batchId, k.locationId];
      const where = 'org_id = $1 AND premises_id = $2 AND item_id = $3 AND batch_id IS NOT DISTINCT FROM $4::uuid AND location_id = $5';
      const onHand = (await db.rows<{ n: number }>(`SELECT on_hand AS n FROM stock_balances WHERE ${where}`, p))[0]?.n ?? 0;
      const moved = (await db.rows(`SELECT 1 FROM stock_movements WHERE ${where} LIMIT 1`, p)).length > 0;
      const delta = k.line.countedBase - onHand;
      if (delta !== 0) lines.push({ k, delta, opening: !moved });
    }
    if (lines.length === 0) throw new HttpError(422, 'NOTHING_TO_CHANGE', 'The count matches what is recorded; nothing to change.');
    const kinds = new Set(lines.map((l) => (l.opening ? 'OPENING_BALANCE' : 'STOCKTAKE_ADJUSTMENT')));
    if (kinds.size > 1) throw new HttpError(422, 'MIXED_KINDS', 'Enter opening stock and count corrections separately.');
    const kind = [...kinds][0];
    if (kind === 'STOCKTAKE_ADJUSTMENT' && !reason) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the count differs.');

    const at = now();
    const header = (await db.rows<{ id: string }>(
      `INSERT INTO stock_adjustments (org_id, premises_id, kind, reason_code, note, created_by, occurred_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [s.orgId, input.premisesId, kind, kind === 'OPENING_BALANCE' ? null : reason, input.note, s.staffUserId, at]))[0].id;
    const movements: MovementInput[] = [];
    for (const [i, { k, delta }] of lines.entries()) {
      const line = (await db.rows<{ id: string }>(
        `INSERT INTO stock_adjustment_lines (org_id, premises_id, adjustment_id, line_no, item_id, batch_id, location_id, qty_delta, counted_base)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [s.orgId, input.premisesId, header, i + 1, k.line.itemId, k.batchId, k.locationId, delta, k.line.countedBase]))[0].id;
      movements.push({ premisesId: input.premisesId, itemId: k.line.itemId, batchId: k.batchId, locationId: k.locationId, type: kind as MovementInput['type'],
        qtyDelta: delta, referenceType: 'STOCK_ADJUSTMENT_LINE', referenceId: line, reasonCode: kind === 'OPENING_BALANCE' ? null : reason, note: input.note });
    }
    await postMovements(db, { orgId: s.orgId, staffUserId: s.staffUserId, name: s.name }, { occurredAt: at, recordedAt: at }, movements);
    await writeAudit(db, { orgId: s.orgId, action: 'stock.adjusted', actorLabel: s.name, actorRole: s.roleKey, staffUserId: s.staffUserId,
      sessionId: s.sid, deviceId: s.deviceId, entityId: header, detail: { kind: kind.toLowerCase(), count: lines.length, reason: reason?.toLowerCase() ?? null } });
    return header;
  });
}

export interface BatchDetailsInput {
  premisesId: string;
  itemId: string;
  batch: NewBatch;
  /** How much of the pending stock is this batch, in base units; all of it when null. */
  qtyBase: number | null;
}

/**
 * D-55: the details of stock held as "details pending" are read off the pack. One signed document
 * moves that quantity from the placeholder onto the real batch (created if new): two count
 * corrections, −n on the placeholder and +n on the batch, with the reason BATCH_DETAILS_RECORDED.
 * Expired stock lands in quarantine (D-14). Repeat it for each batch on the shelf.
 */
export async function recordBatchDetails(s: Session, input: BatchDetailsInput, grantId: string | undefined): Promise<string> {
  requirePremises(s, input.premisesId);
  return withStockTx(s, async (db) => {
    const locations = await premisesReady(db, s.orgId, input.premisesId);
    await consumeGrant(db, s, 'stock.adjust', input.premisesId, grantId);
    const item = (await db.rows<ItemInfo>(
      `SELECT i.id, i.track_batches AS "trackBatches", i.active,
              coalesce(i.custom_manufacturer_name, m.manufacturer_name) AS "mfrName",
              coalesce(i.custom_manufacturer_address, m.manufacturer_address) AS "mfrAddress"
         FROM items i LEFT JOIN medicine_master m ON m.id = i.master_id WHERE i.org_id = $1 AND i.id = $2`, [s.orgId, input.itemId]))[0];
    if (!item) throw new HttpError(404, 'ITEM_NOT_FOUND', 'No such item.');
    const pending = (await db.rows<{ id: string }>(
      'SELECT id FROM batches WHERE org_id = $1 AND premises_id = $2 AND item_id = $3 AND details_pending IS TRUE', [s.orgId, input.premisesId, input.itemId]))[0];
    if (!pending) throw new HttpError(404, 'NO_PENDING_STOCK', 'This item has no stock waiting for batch details here.');
    const unit = (await db.rows('SELECT 1 FROM item_units WHERE org_id = $1 AND item_id = $2 AND id = $3', [s.orgId, input.itemId, input.batch.mrpUnitId]))[0];
    if (!unit) throw new HttpError(404, 'UNIT_NOT_FOUND', 'No such unit of that item.');
    const exp = parseExpiry(input.batch.expiry)!;
    const expired = exp.date < todayIst();
    const store = locations.find((x) => x.isDefault);
    const to = expired ? locations.find((x) => x.kind === 'QUARANTINE') : store;
    if (!store || !to) throw new HttpError(409, 'PREMISES_NOT_CONFIGURED', 'This premises has no store set up.');
    await lockBalances(db, s.orgId, [{ itemId: input.itemId, locationId: store.id }, { itemId: input.itemId, locationId: to.id }]);
    const onHand = (await db.rows<{ n: number }>(
      'SELECT on_hand AS n FROM stock_balances WHERE org_id = $1 AND item_id = $2 AND batch_id = $3 AND location_id = $4', [s.orgId, input.itemId, pending.id, store.id]))[0]?.n ?? 0;
    const qty = input.qtyBase ?? onHand;
    if (qty <= 0) throw new HttpError(409, 'NO_PENDING_STOCK', 'This item has no stock waiting for batch details here.');
    if (qty > onHand) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'That is more than the stock waiting for details.');
    const real = (await resolveBatch(db, s.orgId, { premisesId: input.premisesId, itemId: input.itemId, batchNo: input.batch.batchNo, expiryDate: exp.date,
      expiryAsPrinted: exp.printed, mrpPaise: input.batch.mrpPaise, mrpUnitId: input.batch.mrpUnitId, manufacturerName: item.mfrName, manufacturerAddress: item.mfrAddress })).id;
    const at = now();
    const reason = 'BATCH_DETAILS_RECORDED';
    const header = (await db.rows<{ id: string }>(
      `INSERT INTO stock_adjustments (org_id, premises_id, kind, reason_code, note, created_by, occurred_at, recorded_at)
       VALUES ($1, $2, 'STOCKTAKE_ADJUSTMENT', $3, NULL, $4, $5, $5) RETURNING id`, [s.orgId, input.premisesId, reason, s.staffUserId, at]))[0].id;
    const moves: MovementInput[] = [];
    for (const [i, [batchId, locationId, delta]] of ([[pending.id, store.id, -qty], [real, to.id, qty]] as const).entries()) {
      const line = (await db.rows<{ id: string }>(
        `INSERT INTO stock_adjustment_lines (org_id, premises_id, adjustment_id, line_no, item_id, batch_id, location_id, qty_delta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [s.orgId, input.premisesId, header, i + 1, input.itemId, batchId, locationId, delta]))[0].id;
      moves.push({ premisesId: input.premisesId, itemId: input.itemId, batchId, locationId, type: 'STOCKTAKE_ADJUSTMENT', qtyDelta: delta,
        referenceType: 'STOCK_ADJUSTMENT_LINE', referenceId: line, reasonCode: reason });
    }
    await postMovements(db, { orgId: s.orgId, staffUserId: s.staffUserId, name: s.name }, { occurredAt: at, recordedAt: at }, moves);
    await writeAudit(db, { orgId: s.orgId, action: 'stock.adjusted', actorLabel: s.name, actorRole: s.roleKey, staffUserId: s.staffUserId,
      sessionId: s.sid, deviceId: s.deviceId, entityId: header, detail: { kind: 'stocktake_adjustment', count: 2, reason: 'batch_details_recorded' } });
    return header;
  });
}

// ---------------------------------------------------------------- reads

export interface BatchHint {
  batchNo: string | null;
  /** As printed on the bill (`MM/YY`, `MM/YYYY`) or `YYYY-MM-DD`. */
  expiry: string | null;
  mrpPaise: number | null;
  mrpUnitId: string | null;
  supplierName: string;
  invoiceNo: string;
}

/**
 * D-53 (founder, 2026-10-19: "I just want to change the quantity"): the batch details a count can
 * reuse, from the newest delivery of this item at the premises, posted or still a draft. Whatever a
 * bill left out stays null, and the screen asks only for that.
 */
export async function batchHint(s: Session, itemId: string, premisesId: string): Promise<BatchHint | null> {
  requirePremises(s, premisesId);
  return withTenant(s.orgId, async (db) => {
    if ((await db.rows('SELECT 1 FROM items WHERE org_id = $1 AND id = $2', [s.orgId, itemId])).length === 0) throw new HttpError(404, 'ITEM_NOT_FOUND', 'No such item.');
    const rows = await db.rows<BatchHint & { at: Date }>(
      `SELECT * FROM (
         SELECT l.batch_no AS "batchNo", coalesce(l.expiry_as_printed, l.expiry_date::text) AS expiry, l.mrp_paise AS "mrpPaise", l.mrp_unit_id AS "mrpUnitId",
                coalesce(g.supplier_name_snapshot, sp.name) AS "supplierName", g.invoice_no AS "invoiceNo", g.posted_at AS at
           FROM goods_receipt_lines l
           JOIN goods_receipts g ON g.org_id = l.org_id AND g.id = l.goods_receipt_id
           JOIN suppliers sp ON sp.org_id = g.org_id AND sp.id = g.supplier_id
          WHERE l.org_id = $1 AND l.item_id = $2 AND g.premises_id = $3 AND g.status = 'POSTED'
         UNION ALL
         SELECT nullif(e->>'batchNo', ''), nullif(e->>'expiry', ''), (e->>'mrpPaise')::bigint, (e->>'mrpUnitId')::uuid,
                sp.name, g.invoice_no, g.updated_at
           FROM goods_receipts g
           JOIN suppliers sp ON sp.org_id = g.org_id AND sp.id = g.supplier_id
           CROSS JOIN LATERAL jsonb_array_elements(g.draft_lines) e
          WHERE g.org_id = $1 AND g.premises_id = $3 AND g.status = 'DRAFT' AND e->>'itemId' = $2::text) h
        ORDER BY (h."batchNo" IS NOT NULL) DESC, h.at DESC LIMIT 1`, [s.orgId, itemId, premisesId]);
    if (!rows[0]) return null;
    const { at, ...hint } = rows[0];
    void at;
    return { ...hint, mrpPaise: hint.mrpPaise === null ? null : Number(hint.mrpPaise) };
  });
}

export interface AdjustmentLineView {
  lineNo: number;
  itemId: string;
  itemName: string;
  baseUnit: string;
  batchId: string | null;
  batchNo: string | null;
  locationName: string;
  qtyDelta: number;
  countedBase: number | null;
}
export interface AdjustmentView {
  id: string;
  premisesId: string;
  kind: string;
  status: string;
  reasonCode: string | null;
  note: string | null;
  createdByName: string;
  recordedAt: string;
  lines: AdjustmentLineView[];
}

/** E-34 GET …/{id}: an adjustment with its lines (no patient field: there is none to give). */
export async function getAdjustment(s: Session, id: string): Promise<AdjustmentView> {
  return withTenant(s.orgId, async (db) => {
    const h = (await db.rows<Omit<AdjustmentView, 'lines'>>(
      `SELECT a.id, a.premises_id AS "premisesId", a.kind, a.status, a.reason_code AS "reasonCode", a.note, u.name AS "createdByName", a.recorded_at AS "recordedAt"
         FROM stock_adjustments a JOIN staff_users u ON u.org_id = a.org_id AND u.id = a.created_by
        WHERE a.org_id = $1 AND a.id = $2`, [s.orgId, id]))[0];
    if (!h || !inScope(s, h.premisesId)) throw notFound();
    const lines = await db.rows<AdjustmentLineView>(
      `SELECT l.line_no AS "lineNo", l.item_id AS "itemId", i.display_name AS "itemName", i.base_unit AS "baseUnit", l.batch_id AS "batchId",
              b.batch_no AS "batchNo", loc.name AS "locationName", l.qty_delta AS "qtyDelta", l.counted_base AS "countedBase"
         FROM stock_adjustment_lines l
         JOIN items i ON i.org_id = l.org_id AND i.id = l.item_id
         JOIN stock_locations loc ON loc.org_id = l.org_id AND loc.id = l.location_id
         LEFT JOIN batches b ON b.org_id = l.org_id AND b.id = l.batch_id
        WHERE l.org_id = $1 AND l.adjustment_id = $2 ORDER BY l.line_no`, [s.orgId, id]);
    return { ...h, lines };
  });
}

export interface AdjustmentSummary { id: string; premisesId: string; kind: string; status: string; reasonCode: string | null; createdByName: string; recordedAt: string; lineCount: number }

/** E-34 GET: adjustments at the caller's premises (or one), newest first. */
export async function listAdjustments(s: Session, q: URLSearchParams): Promise<{ items: AdjustmentSummary[] }> {
  const one = q.get('premisesId');
  if (one) requirePremises(s, one.toLowerCase());
  const premises = one ? [one.toLowerCase()] : s.premises.map((p) => p.id);
  return { items: await withTenant(s.orgId, (db) => db.rows<AdjustmentSummary>(
    `SELECT a.id, a.premises_id AS "premisesId", a.kind, a.status, a.reason_code AS "reasonCode", u.name AS "createdByName", a.recorded_at AS "recordedAt",
            (SELECT count(*)::int FROM stock_adjustment_lines l WHERE l.org_id = a.org_id AND l.adjustment_id = a.id) AS "lineCount"
       FROM stock_adjustments a JOIN staff_users u ON u.org_id = a.org_id AND u.id = a.created_by
      WHERE a.org_id = $1 AND a.premises_id = ANY($2::uuid[])
      ORDER BY a.recorded_at DESC, a.id LIMIT 200`, [s.orgId, premises])) };
}
