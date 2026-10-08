import type { Db } from '../db/db';
import { withTenant } from '../db/tenant';
import { addDays, now, todayIst } from '../clock';
import { HttpError } from '../http/errors';
import { UUID_PATTERN } from '../http/body';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { inScope, requirePremises } from './scope';
import { lockBalances, normaliseBatchNo, postMovements, resolveBatch, withStockTx, type MovementInput } from './ledger';

/**
 * Receiving stock (06a §6.7, §9.3; E-23 … E-26). A delivery (GRN) is a DRAFT that anyone with
 * `stock.receive` edits freely; posting checks it against the premises' rules, resolves or
 * creates its batches, writes its lines and one RECEIPT per line, and freezes it.
 *
 * - A draft's lines are JSON on the header until posting (the app role holds no DELETE).
 * - Milestone 1 records receipts at the time of posting (R6-3): received_at = posted_at = now.
 * - The checks are the same before posting (E-24 shows them on a draft) and at posting.
 */
export interface DraftLine {
  itemId: string;
  purchaseUnitId: string;
  qty: number;
  freeQty: number;
  batchNo: string | null;
  /** As printed: `MM/YYYY`, `MM/YY`, or a full `YYYY-MM-DD`. */
  expiry: string | null;
  mfgDate: string | null;
  mrpPaise: number | null;
  mrpUnitId: string | null;
  purchaseRatePaise: number;
  discountPaise: number;
  gstRateBp: number | null;
  manufacturerName: string | null;
  manufacturerAddress: string | null;
}

const LINE_KEYS = new Set(['itemId', 'purchaseUnitId', 'qty', 'freeQty', 'batchNo', 'expiry', 'mfgDate', 'mrpPaise', 'mrpUnitId',
  'purchaseRatePaise', 'discountPaise', 'gstRateBp', 'manufacturerName', 'manufacturerAddress']);
const MAX_LINES = 200;
const MAX_PAISE = 10_000_000_000; // ₹10 crore per field: far beyond any line, far below 2^53

const bad = (field: string, rule: string) => new HttpError(422, 'FIELD_INVALID', `${field} is not valid.`, { field, rule });

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw bad(field, 'int');
  return v;
}
function str(v: unknown, field: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw bad(field, 'string');
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw bad(field, 'max');
  return t;
}
function uuid(v: unknown, field: string, nullable = false): string | null {
  if ((v === null || v === undefined) && nullable) return null;
  if (typeof v !== 'string' || !UUID_PATTERN.test(v)) throw bad(field, 'uuid');
  return v.toLowerCase();
}

/** §11.3: `MM/YYYY` (or `MM/YY`) is the last day of that month; a full date is kept as is. */
export function parseExpiry(text: string): { date: string; printed: string | null } | null {
  const t = text.trim();
  let m = /^(\d{1,2})\s*[/-]\s*(\d{4}|\d{2})$/.exec(t);
  if (m) {
    const month = Number(m[1]);
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    if (month < 1 || month > 12 || year < 2000 || year > 2099) return null;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { date: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`, printed: t };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const d = new Date(`${t}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) return null;
    return { date: t, printed: null };
  }
  return null;
}

/** Validate a draft's lines (shape only; references are checked against the organisation separately). */
export function parseLines(raw: unknown): DraftLine[] {
  if (!Array.isArray(raw)) throw bad('lines', 'array');
  if (raw.length > MAX_LINES) throw bad('lines', 'max');
  return raw.map((r, i) => {
    const f = (k: string) => `lines[${i}].${k}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad(`lines[${i}]`, 'object');
    for (const k of Object.keys(r)) if (!LINE_KEYS.has(k)) throw new HttpError(422, 'UNKNOWN_FIELD', `Unknown field ${f(k)}.`, { field: f(k) });
    const o = r as Record<string, unknown>;
    const expiry = str(o.expiry, f('expiry'), 20);
    if (expiry && !parseExpiry(expiry)) throw bad(f('expiry'), 'format');
    const mfg = str(o.mfgDate, f('mfgDate'), 20);
    if (mfg && !parseExpiry(mfg)) throw bad(f('mfgDate'), 'format');
    return {
      itemId: uuid(o.itemId, f('itemId'))!,
      purchaseUnitId: uuid(o.purchaseUnitId, f('purchaseUnitId'))!,
      qty: int(o.qty, f('qty'), 1, 1_000_000),
      freeQty: o.freeQty === undefined ? 0 : int(o.freeQty, f('freeQty'), 0, 1_000_000),
      batchNo: (() => { const b = str(o.batchNo, f('batchNo'), 40); return b ? normaliseBatchNo(b) : null; })(),
      expiry,
      mfgDate: mfg,
      mrpPaise: o.mrpPaise === null || o.mrpPaise === undefined ? null : int(o.mrpPaise, f('mrpPaise'), 1, MAX_PAISE),
      mrpUnitId: uuid(o.mrpUnitId, f('mrpUnitId'), true),
      purchaseRatePaise: o.purchaseRatePaise === undefined ? 0 : int(o.purchaseRatePaise, f('purchaseRatePaise'), 0, MAX_PAISE),
      discountPaise: o.discountPaise === undefined ? 0 : int(o.discountPaise, f('discountPaise'), 0, MAX_PAISE),
      gstRateBp: o.gstRateBp === null || o.gstRateBp === undefined ? null : int(o.gstRateBp, f('gstRateBp'), 0, 2800),
      manufacturerName: str(o.manufacturerName, f('manufacturerName'), 200),
      manufacturerAddress: str(o.manufacturerAddress, f('manufacturerAddress'), 500),
    };
  });
}

export interface GrnInput {
  supplierId?: string;
  locationId?: string | null;
  invoiceNo?: string;
  invoiceDate?: string;
  invoiceTotalPaise?: number | null;
  notes?: string | null;
  lines?: unknown;
}

const notFound = () => new HttpError(404, 'GRN_NOT_FOUND', 'No such delivery.');

interface ItemInfo { id: string; name: string; category: string; trackBatches: boolean; active: boolean; flags: string[]; mfrName: string | null; mfrAddress: string | null }
interface UnitInfo { id: string; itemId: string; name: string; factor: number; purchasable: boolean; active: boolean; isBase: boolean }

/** Every line names an item and units of THAT item in this organisation (404 otherwise, like a missing one). */
async function loadRefs(db: Db, orgId: string, lines: readonly DraftLine[]): Promise<{ items: Map<string, ItemInfo>; units: Map<string, UnitInfo> }> {
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const unitIds = [...new Set(lines.flatMap((l) => [l.purchaseUnitId, l.mrpUnitId]).filter((u): u is string => !!u))];
  const items = new Map((await db.rows<ItemInfo>(
    `SELECT i.id, i.display_name AS name, i.category, i.track_batches AS "trackBatches", i.active,
            ARRAY(SELECT DISTINCT f FROM unnest(coalesce(m.schedule_flags, '{}') || i.extra_schedule_flags) f) AS flags,
            coalesce(i.custom_manufacturer_name, m.manufacturer_name) AS "mfrName",
            coalesce(i.custom_manufacturer_address, m.manufacturer_address) AS "mfrAddress"
       FROM items i LEFT JOIN medicine_master m ON m.id = i.master_id
      WHERE i.org_id = $1 AND i.id = ANY($2::uuid[])`, [orgId, itemIds])).map((i) => [i.id, i]));
  const units = new Map((await db.rows<UnitInfo>(
    `SELECT id, item_id AS "itemId", name, base_units_per_unit AS factor, purchasable, active, is_base AS "isBase"
       FROM item_units WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, unitIds])).map((u) => [u.id, u]));
  lines.forEach((l, i) => {
    if (!items.has(l.itemId)) throw new HttpError(404, 'ITEM_NOT_FOUND', 'No such item.', { lineNo: i + 1 });
    for (const u of [l.purchaseUnitId, l.mrpUnitId]) {
      if (u && units.get(u)?.itemId !== l.itemId) throw new HttpError(404, 'UNIT_NOT_FOUND', 'No such unit of that item.', { lineNo: i + 1 });
    }
  });
  return { items, units };
}

async function supplierOrThrow(db: Db, orgId: string, supplierId: string) {
  const r = (await db.rows<{ id: string; name: string; gstin: string | null; address: string | null; licences: string[]; validTill: string | null; active: boolean }>(
    `SELECT id, name, gstin, address, drug_licence_numbers AS licences, licence_valid_till::text AS "validTill", active
       FROM suppliers WHERE org_id = $1 AND id = $2`, [orgId, supplierId]))[0];
  if (!r) throw new HttpError(404, 'SUPPLIER_NOT_FOUND', 'No such supplier.');
  return r;
}

async function configured(db: Db, orgId: string, premisesId: string) {
  if ((await db.rows('SELECT 1 FROM stock_settings WHERE org_id = $1', [orgId])).length === 0) {
    throw new HttpError(409, 'DISPENSARY_NOT_CONFIGURED', 'The dispensary is not set up yet.');
  }
  const ps = (await db.rows<{ mode: string; ndps: string | null; ndpsTill: string | null; x: string | null; xTill: string | null }>(
    `SELECT dispensing_mode AS mode, ndps_licence_no AS ndps, ndps_licence_valid_till::text AS "ndpsTill",
            schedule_x_licence_no AS x, schedule_x_licence_valid_till::text AS "xTill"
       FROM premises_settings WHERE org_id = $1 AND premises_id = $2`, [orgId, premisesId]))[0];
  if (!ps) throw new HttpError(409, 'PREMISES_NOT_CONFIGURED', 'This premises is not set up for stock yet.');
  return ps;
}

async function locationFor(db: Db, orgId: string, premisesId: string, locationId: string | null | undefined): Promise<string> {
  const rows = await db.rows<{ id: string; kind: string; isDefault: boolean; active: boolean }>(
    'SELECT id, kind, is_default AS "isDefault", active FROM stock_locations WHERE org_id = $1 AND premises_id = $2', [orgId, premisesId]);
  const loc = locationId ? rows.find((l) => l.id === locationId.toLowerCase()) : rows.find((l) => l.isDefault);
  if (!loc) throw new HttpError(404, 'LOCATION_NOT_FOUND', 'No such location at that premises.');
  if (loc.kind === 'QUARANTINE' || !loc.active) throw new HttpError(422, 'LOCATION_NOT_ALLOWED', 'Deliveries go to a working store, never to quarantine.');
  return loc.id;
}

function checkHeader(input: GrnInput, creating: boolean): void {
  if (input.invoiceNo !== undefined && (input.invoiceNo.trim().length === 0 || input.invoiceNo.trim().length > 40)) throw bad('invoiceNo', 'length');
  if (input.invoiceDate !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate) || parseExpiry(input.invoiceDate) === null)) throw bad('invoiceDate', 'date');
  if (creating && (!input.supplierId || !input.invoiceNo || !input.invoiceDate)) throw bad(!input.supplierId ? 'supplierId' : !input.invoiceNo ? 'invoiceNo' : 'invoiceDate', 'required');
  if (input.notes && input.notes.length > 500) throw bad('notes', 'max');
}

/** E-23 POST: a new draft at one of the caller's premises. */
export async function createGrn(s: Session, premisesId: string, input: GrnInput): Promise<string> {
  requirePremises(s, premisesId);
  checkHeader(input, true);
  const lines = input.lines === undefined ? [] : parseLines(input.lines);
  return withSessionTx(s, async (db) => {
    await configured(db, s.orgId, premisesId);
    await supplierOrThrow(db, s.orgId, input.supplierId!.toLowerCase());
    await loadRefs(db, s.orgId, lines);
    const locationId = await locationFor(db, s.orgId, premisesId, input.locationId);
    const at = now();
    const id = (await db.rows<{ id: string }>(
      `INSERT INTO goods_receipts (org_id, premises_id, location_id, supplier_id, invoice_no, invoice_date, invoice_total_paise, notes, draft_lines,
                                   created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
      [s.orgId, premisesId, locationId, input.supplierId!.toLowerCase(), input.invoiceNo!.trim(), input.invoiceDate, input.invoiceTotalPaise ?? null,
        input.notes?.trim() || null, JSON.stringify(lines), s.staffUserId, at]))[0].id;
    await writeAudit(db, { orgId: s.orgId, action: 'grn.created', actorLabel: s.name, actorRole: s.roleKey, staffUserId: s.staffUserId,
      sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { count: lines.length } });
    return id;
  });
}

async function lockDraft(db: Db, s: Session, id: string) {
  const g = (await db.rows<{ id: string; premisesId: string; locationId: string; supplierId: string; invoiceNo: string; invoiceDate: string; status: string;
    draftLines: unknown; invoiceTotalPaise: number | null; notes: string | null }>(
    `SELECT id, premises_id AS "premisesId", location_id AS "locationId", supplier_id AS "supplierId", invoice_no AS "invoiceNo",
            invoice_date::text AS "invoiceDate", status, draft_lines AS "draftLines", invoice_total_paise AS "invoiceTotalPaise", notes
       FROM goods_receipts WHERE org_id = $1 AND id = $2 FOR UPDATE`, [s.orgId, id]))[0];
  if (!g || !inScope(s, g.premisesId)) throw notFound();
  if (g.status !== 'DRAFT') throw new HttpError(409, 'GRN_NOT_DRAFT', 'This delivery has already been posted or discarded.');
  return g;
}

/** E-24 PATCH: change a draft's header or replace its lines. */
export async function patchGrn(s: Session, id: string, input: GrnInput): Promise<string> {
  checkHeader(input, false);
  const lines = input.lines === undefined ? undefined : parseLines(input.lines);
  return withSessionTx(s, async (db) => {
    const g = await lockDraft(db, s, id);
    if (input.supplierId) await supplierOrThrow(db, s.orgId, input.supplierId.toLowerCase());
    if (lines) await loadRefs(db, s.orgId, lines);
    const locationId = input.locationId !== undefined ? await locationFor(db, s.orgId, g.premisesId, input.locationId) : g.locationId;
    await db.rows(
      `UPDATE goods_receipts SET supplier_id = $3, location_id = $4, invoice_no = $5, invoice_date = $6, invoice_total_paise = $7, notes = $8,
                                 draft_lines = $9, updated_at = $10
        WHERE org_id = $1 AND id = $2`,
      [s.orgId, id, input.supplierId?.toLowerCase() ?? g.supplierId, locationId, input.invoiceNo?.trim() ?? g.invoiceNo, input.invoiceDate ?? g.invoiceDate,
        input.invoiceTotalPaise === undefined ? g.invoiceTotalPaise : input.invoiceTotalPaise,
        input.notes === undefined ? g.notes : input.notes?.trim() || null,
        JSON.stringify(lines ?? g.draftLines), now()]);
    return id;
  });
}

export interface Problem { code: string; lineNo?: number }

/** Tests only (06b DL-19): skip a service pre-check so the database backstop is reached through the API. */
export const faults = { skipExpiryPrecheck: false };
const STATUS: Record<string, number> = { BATCH_EXPIRED: 409, BATCH_MRP_MISMATCH: 409, DUPLICATE_INVOICE: 409 };
const MESSAGES: Record<string, string> = {
  GRN_EMPTY: 'Add at least one line.',
  INVOICE_DATE_IN_FUTURE: 'The invoice date is after today.',
  SUPPLIER_LICENCE_MISSING: 'This supplier has no drug licence number on file.',
  SUPPLIER_INACTIVE: 'This supplier is no longer active.',
  ITEM_INACTIVE: 'An item on this delivery is no longer active.',
  UNIT_NOT_PURCHASABLE: 'That pack is not bought in.',
  BATCH_DETAILS_REQUIRED: 'A batch-tracked line needs its batch number, expiry and MRP.',
  BATCH_NOT_TRACKED: 'This item is not batch-tracked; leave batch and expiry empty.',
  BATCH_EXPIRED: 'Expired goods are not received.',
  MFG_AFTER_EXPIRY: 'The manufacturing date is after the expiry.',
  MANUFACTURER_DETAILS_MISSING: "The purchase record needs the manufacturer's name and address.",
  LICENCE_REQUIRED_NDPS: 'This premises has no NDPS licence in date.',
  LICENCE_REQUIRED_SCHEDULE_X: 'This premises has no Schedule X licence in date.',
  DISCOUNT_EXCEEDS_GROSS: 'A discount is more than the line is worth.',
  QTY_TOO_LARGE: 'That quantity is too large.',
  BATCH_MRP_MISMATCH: 'This batch is already recorded with a different MRP.',
  DUPLICATE_INVOICE: "This supplier's invoice has already been posted.",
};

interface Context { items: Map<string, ItemInfo>; units: Map<string, UnitInfo>; supplier: Awaited<ReturnType<typeof supplierOrThrow>> }

/**
 * The checks a draft must pass to be posted (06a §9.3 post_grn; MR-03, MR-04, MR-08, MR-09;
 * §11.3), evaluated at the premises' rules as of today. Errors block; warnings are shown.
 */
async function checks(db: Db, orgId: string, g: { id: string; premisesId: string; supplierId: string; invoiceNo: string; invoiceDate: string }, lines: readonly DraftLine[]):
  Promise<{ errors: Problem[]; warnings: Problem[]; ctx: Context }> {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  const today = todayIst();
  const ps = await configured(db, orgId, g.premisesId);
  const supplier = await supplierOrThrow(db, orgId, g.supplierId);
  const { items, units } = await loadRefs(db, orgId, lines);
  const windows = (await db.rows<{ w: number[] }>('SELECT near_expiry_windows_days AS w FROM stock_settings WHERE org_id = $1', [orgId]))[0].w;
  const nearBy = addDays(today, Math.min(...windows));
  const rmp = ps.mode === 'RMP_OWN_PATIENTS';
  if (lines.length === 0) errors.push({ code: 'GRN_EMPTY' });
  if (g.invoiceDate > today) errors.push({ code: 'INVOICE_DATE_IN_FUTURE' });
  if (!supplier.active) errors.push({ code: 'SUPPLIER_INACTIVE' });
  // MR-03: at an RMP premises the supplier has a licence on file; an expired one only warns.
  if (rmp && supplier.licences.length === 0) errors.push({ code: 'SUPPLIER_LICENCE_MISSING' });
  else if (supplier.validTill && supplier.validTill < today) warnings.push({ code: 'SUPPLIER_LICENCE_EXPIRED' });
  const dup = await db.rows(`SELECT 1 FROM goods_receipts WHERE org_id = $1 AND supplier_id = $2 AND lower(invoice_no) = lower($3) AND status = 'POSTED' AND id <> $4`,
    [orgId, g.supplierId, g.invoiceNo, g.id]);
  if (dup.length) errors.push({ code: 'DUPLICATE_INVOICE' });
  for (const [i, l] of lines.entries()) {
    const lineNo = i + 1;
    const item = items.get(l.itemId)!;
    const unit = units.get(l.purchaseUnitId)!;
    if (!item.active) errors.push({ code: 'ITEM_INACTIVE', lineNo });
    if (!unit.purchasable || !unit.active) errors.push({ code: 'UNIT_NOT_PURCHASABLE', lineNo });
    if ((l.qty + l.freeQty) * unit.factor > 2_000_000_000) errors.push({ code: 'QTY_TOO_LARGE', lineNo });
    if (l.discountPaise > l.qty * l.purchaseRatePaise) errors.push({ code: 'DISCOUNT_EXCEEDS_GROSS', lineNo });
    if (item.trackBatches) {
      const exp = l.expiry ? parseExpiry(l.expiry) : null;
      if (!l.batchNo || !exp || !l.mrpPaise || !l.mrpUnitId) errors.push({ code: 'BATCH_DETAILS_REQUIRED', lineNo });
      if (exp && exp.date < today && !faults.skipExpiryPrecheck) errors.push({ code: 'BATCH_EXPIRED', lineNo });
      else if (exp && exp.date <= nearBy) warnings.push({ code: 'NEAR_EXPIRY_ON_ARRIVAL', lineNo });
      const mfg = l.mfgDate ? parseExpiry(l.mfgDate) : null;
      if (mfg && exp && mfg.date > exp.date) errors.push({ code: 'MFG_AFTER_EXPIRY', lineNo });
      // OQ-15: an existing batch keeps its MRP (compared per base unit).
      if (l.batchNo && exp && l.mrpPaise && l.mrpUnitId) {
        const b = (await db.rows<{ mrp: number; factor: number }>(
          `SELECT bt.mrp_paise AS mrp, u.base_units_per_unit AS factor FROM batches bt JOIN item_units u ON u.org_id = bt.org_id AND u.id = bt.mrp_unit_id
            WHERE bt.org_id = $1 AND bt.premises_id = $2 AND bt.item_id = $3 AND bt.batch_no = $4 AND bt.expiry_date = $5`,
          [orgId, g.premisesId, l.itemId, l.batchNo, exp.date]))[0];
        if (b && b.mrp * units.get(l.mrpUnitId)!.factor !== l.mrpPaise * b.factor) errors.push({ code: 'BATCH_MRP_MISMATCH', lineNo });
      }
    } else if (l.batchNo || l.expiry) {
      errors.push({ code: 'BATCH_NOT_TRACKED', lineNo });
    }
    // MR-04: a medicine's purchase record names its manufacturer and their address (line → item → master).
    if (rmp && (item.category === 'MEDICINE' || item.category === 'INJECTABLE')
        && !((l.manufacturerName ?? item.mfrName) && (l.manufacturerAddress ?? item.mfrAddress))) {
      errors.push({ code: 'MANUFACTURER_DETAILS_MISSING', lineNo });
    }
    // MR-08, MR-09: this premises' own licences, in date today.
    if (item.flags.includes('NDPS') && !(ps.ndps && ps.ndpsTill && ps.ndpsTill >= today)) errors.push({ code: 'LICENCE_REQUIRED_NDPS', lineNo });
    if (item.flags.includes('X') && !(ps.x && ps.xTill && ps.xTill >= today)) errors.push({ code: 'LICENCE_REQUIRED_SCHEDULE_X', lineNo });
  }
  return { errors, warnings, ctx: { items, units, supplier } };
}

/** The first error decides the status and code; every error is in `details.problems`. */
function blocked(errors: Problem[]): HttpError {
  const first = errors[0];
  return new HttpError(STATUS[first.code] ?? 422, first.code, MESSAGES[first.code] ?? first.code, { problems: errors, lineNo: first.lineNo });
}

/** E-25: post a draft. Locks, checks, resolves batches, writes lines and RECEIPTs, freezes the delivery. */
export async function postGrn(s: Session, id: string): Promise<{ id: string; warnings: Problem[] }> {
  return withStockTx(s, async (db) => {
    const g = await lockDraft(db, s, id);
    const lines = parseLines(g.draftLines);
    const { errors, warnings, ctx } = await checks(db, s.orgId, g, lines);
    if (errors.length) throw blocked(errors);
    const at = now();
    const settings = (await db.rows<{ m: number }>('SELECT backdate_reason_after_minutes AS m FROM stock_settings WHERE org_id = $1', [s.orgId]))[0];
    await lockBalances(db, s.orgId, lines.map((l) => ({ itemId: l.itemId, locationId: g.locationId })));
    const movements: MovementInput[] = [];
    for (const [i, l] of lines.entries()) {
      const item = ctx.items.get(l.itemId)!;
      const unit = ctx.units.get(l.purchaseUnitId)!;
      const exp = l.expiry ? parseExpiry(l.expiry)! : null;
      const mfg = l.mfgDate ? parseExpiry(l.mfgDate)!.date : null;
      const mfrName = l.manufacturerName ?? item.mfrName;
      const mfrAddress = l.manufacturerAddress ?? item.mfrAddress;
      const batchId = item.trackBatches ? (await resolveBatch(db, s.orgId, { premisesId: g.premisesId, itemId: l.itemId, batchNo: l.batchNo!, expiryDate: exp!.date,
        expiryAsPrinted: exp!.printed, mfgDate: mfg, mrpPaise: l.mrpPaise!, mrpUnitId: l.mrpUnitId!, manufacturerName: mfrName, manufacturerAddress: mfrAddress })).id : null;
      const line = (await db.rows<{ id: string }>(
        `INSERT INTO goods_receipt_lines (org_id, premises_id, goods_receipt_id, line_no, item_id, purchase_unit_id, base_units_per_unit_snapshot, qty, free_qty,
                                          batch_no, expiry_date, expiry_as_printed, mfg_date, mrp_paise, mrp_unit_id, purchase_rate_paise, discount_paise, gst_rate_bp,
                                          manufacturer_name_snapshot, manufacturer_address_snapshot, batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING id`,
        [s.orgId, g.premisesId, id, i + 1, l.itemId, l.purchaseUnitId, unit.factor, l.qty, l.freeQty,
          item.trackBatches ? l.batchNo : null, exp?.date ?? null, exp?.printed ?? null, mfg, l.mrpPaise, l.mrpUnitId, l.purchaseRatePaise, l.discountPaise, l.gstRateBp,
          mfrName, mfrAddress, batchId]))[0];
      movements.push({ premisesId: g.premisesId, itemId: l.itemId, batchId, locationId: g.locationId, type: 'RECEIPT',
        qtyDelta: (l.qty + l.freeQty) * unit.factor, referenceType: 'GOODS_RECEIPT_LINE', referenceId: line.id });
    }
    await postMovements(db, { orgId: s.orgId, staffUserId: s.staffUserId, name: s.name }, { occurredAt: at, recordedAt: at }, movements);
    await db.rows(
      `UPDATE goods_receipts SET status = 'POSTED', draft_lines = '[]', received_at = $3, received_by = $4, posted_at = $3, posted_by = $4,
              reason_after_minutes_snapshot = $5, supplier_name_snapshot = $6, supplier_gstin_snapshot = $7, supplier_address_snapshot = $8,
              supplier_licence_numbers_snapshot = $9, supplier_licence_valid_till_snapshot = $10, updated_at = $3
        WHERE org_id = $1 AND id = $2`,
      [s.orgId, id, at, s.staffUserId, settings.m, ctx.supplier.name, ctx.supplier.gstin, ctx.supplier.address, ctx.supplier.licences, ctx.supplier.validTill])
      .catch((err: { code?: string; constraint?: string }) => {
        if (err.code === '23505' && err.constraint === 'goods_receipts_invoice_key') throw blocked([{ code: 'DUPLICATE_INVOICE' }]);
        throw err;
      });
    await writeAudit(db, { orgId: s.orgId, action: 'grn.posted', actorLabel: s.name, actorRole: s.roleKey, staffUserId: s.staffUserId,
      sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { count: lines.length } });
    return { id, warnings };
  });
}

/** E-26: discard a draft; it stays, marked DISCARDED, and never posts. */
export async function discardGrn(s: Session, id: string): Promise<string> {
  return withSessionTx(s, async (db) => {
    await lockDraft(db, s, id);
    const at = now();
    await db.rows(`UPDATE goods_receipts SET status = 'DISCARDED', draft_lines = '[]', discarded_at = $3, discarded_by = $4, updated_at = $3
                    WHERE org_id = $1 AND id = $2`, [s.orgId, id, at, s.staffUserId]);
    await writeAudit(db, { orgId: s.orgId, action: 'grn.discarded', actorLabel: s.name, actorRole: s.roleKey, staffUserId: s.staffUserId,
      sessionId: s.sid, deviceId: s.deviceId, entityId: id });
    return id;
  });
}

// ---------------------------------------------------------------- reads

export interface GrnLineView extends DraftLine {
  lineNo: number;
  itemName: string;
  baseUnit: string;
  purchaseUnitName: string;
  baseUnitsPerUnit: number;
  receivedBase: number;
  /** qty × rate − discount, before GST. */
  valuePaise: number;
  gstPaise: number;
  batchId: string | null;
}
export interface GrnView {
  id: string;
  status: string;
  premisesId: string;
  locationId: string;
  supplierId: string;
  supplierName: string;
  supplierLicenceStatus: string;
  invoiceNo: string;
  invoiceDate: string;
  invoiceTotalPaise: number | null;
  notes: string | null;
  createdAt: string;
  postedAt: string | null;
  receivedAt: string | null;
  lines: GrnLineView[];
  valuePaise: number;
  gstPaise: number;
  totalPaise: number;
  /** For a draft: what posting would say now. */
  checks: { errors: Problem[]; warnings: Problem[] } | null;
}

/** GST on a pre-tax value, rounded half-up to the paisa (display only; the bill's own figures are on its lines). */
const gstOf = (value: number, bp: number | null) => (bp ? Math.floor((value * bp * 2 + 10_000) / 20_000) : 0);

const HEADER = `SELECT g.id, g.status, g.premises_id AS "premisesId", g.location_id AS "locationId", g.supplier_id AS "supplierId",
         coalesce(g.supplier_name_snapshot, s.name) AS "supplierName",
         CASE WHEN cardinality(s.drug_licence_numbers) = 0 THEN 'MISSING' WHEN s.licence_valid_till IS NULL THEN 'VALIDITY_UNKNOWN'
              WHEN s.licence_valid_till < $3::date THEN 'EXPIRED' ELSE 'VALID' END AS "supplierLicenceStatus",
         g.invoice_no AS "invoiceNo", g.invoice_date::text AS "invoiceDate", g.invoice_total_paise AS "invoiceTotalPaise", g.notes,
         g.created_at AS "createdAt", g.posted_at AS "postedAt", g.received_at AS "receivedAt", g.draft_lines AS "draftLines"
    FROM goods_receipts g JOIN suppliers s ON s.org_id = g.org_id AND s.id = g.supplier_id`;

/** E-24 GET: a delivery with its lines; a draft also carries its checks. */
export async function getGrn(s: Session, id: string): Promise<GrnView> {
  return withTenant(s.orgId, async (db) => {
    const g = (await db.rows<Omit<GrnView, 'lines' | 'valuePaise' | 'gstPaise' | 'totalPaise' | 'checks'> & { draftLines: unknown }>(
      `${HEADER} WHERE g.org_id = $1 AND g.id = $2`, [s.orgId, id, todayIst()]))[0];
    if (!g || !inScope(s, g.premisesId)) throw notFound();
    let raw: (DraftLine & { batchId: string | null; baseUnitsPerUnit?: number })[];
    let problems: GrnView['checks'] = null;
    if (g.status === 'DRAFT') {
      raw = parseLines(g.draftLines).map((l) => ({ ...l, batchId: null }));
      try {
        const c = await checks(db, s.orgId, g, raw);
        problems = { errors: c.errors, warnings: c.warnings };
      } catch (err) {
        // A reference that no longer resolves (e.g. a unit made inactive is still fine; a removed one cannot be) shows as one error.
        if (!(err instanceof HttpError)) throw err;
        problems = { errors: [{ code: err.code }], warnings: [] };
      }
    } else {
      raw = await db.rows(`SELECT item_id AS "itemId", purchase_unit_id AS "purchaseUnitId", qty, free_qty AS "freeQty", batch_no AS "batchNo",
                                  coalesce(expiry_as_printed, expiry_date::text) AS expiry, mfg_date::text AS "mfgDate", mrp_paise AS "mrpPaise", mrp_unit_id AS "mrpUnitId",
                                  purchase_rate_paise AS "purchaseRatePaise", discount_paise AS "discountPaise", gst_rate_bp AS "gstRateBp",
                                  manufacturer_name_snapshot AS "manufacturerName", manufacturer_address_snapshot AS "manufacturerAddress", batch_id AS "batchId",
                                  base_units_per_unit_snapshot AS "baseUnitsPerUnit"
                             FROM goods_receipt_lines WHERE org_id = $1 AND goods_receipt_id = $2 ORDER BY line_no`, [s.orgId, id]);
    }
    const itemIds = [...new Set(raw.map((l) => l.itemId))];
    const names = new Map((await db.rows<{ id: string; name: string; baseUnit: string }>(
      'SELECT id, display_name AS name, base_unit AS "baseUnit" FROM items WHERE org_id = $1 AND id = ANY($2::uuid[])', [s.orgId, itemIds])).map((r) => [r.id, r]));
    const unitRows = new Map((await db.rows<{ id: string; name: string; factor: number }>(
      'SELECT id, name, base_units_per_unit AS factor FROM item_units WHERE org_id = $1 AND item_id = ANY($2::uuid[])', [s.orgId, itemIds])).map((r) => [r.id, r]));
    const lines = raw.map((l, i) => {
      const factor = l.baseUnitsPerUnit ?? unitRows.get(l.purchaseUnitId)?.factor ?? 1;
      const value = l.qty * l.purchaseRatePaise - l.discountPaise;
      return { ...l, lineNo: i + 1, itemName: names.get(l.itemId)?.name ?? '', baseUnit: names.get(l.itemId)?.baseUnit ?? '',
        purchaseUnitName: unitRows.get(l.purchaseUnitId)?.name ?? '', baseUnitsPerUnit: factor, receivedBase: (l.qty + l.freeQty) * factor,
        valuePaise: value, gstPaise: gstOf(value, l.gstRateBp), batchId: l.batchId ?? null };
    });
    const { draftLines, ...head } = g;
    void draftLines;
    const valuePaise = lines.reduce((n, l) => n + l.valuePaise, 0);
    const gstPaise = lines.reduce((n, l) => n + l.gstPaise, 0);
    return { ...head, lines, valuePaise, gstPaise, totalPaise: valuePaise + gstPaise, checks: problems };
  });
}

export interface GrnSummary { id: string; status: string; premisesId: string; supplierName: string; invoiceNo: string; invoiceDate: string; lineCount: number; createdAt: string; postedAt: string | null }

/** E-23 GET: deliveries at the caller's premises (or one), drafts first, newest first. */
export async function listGrns(s: Session, q: URLSearchParams): Promise<{ items: GrnSummary[] }> {
  const one = q.get('premisesId');
  if (one) requirePremises(s, one.toLowerCase());
  const premises = one ? [one.toLowerCase()] : s.premises.map((p) => p.id);
  const status = q.get('status');
  if (status && !['DRAFT', 'POSTED', 'REVERSED', 'DISCARDED'].includes(status)) throw bad('status', 'enum');
  const supplierId = q.get('supplierId');
  if (supplierId && !UUID_PATTERN.test(supplierId)) throw bad('supplierId', 'uuid');
  return { items: await withTenant(s.orgId, (db) => db.rows<GrnSummary>(
    `SELECT g.id, g.status, g.premises_id AS "premisesId", coalesce(g.supplier_name_snapshot, s.name) AS "supplierName", g.invoice_no AS "invoiceNo",
            g.invoice_date::text AS "invoiceDate", g.created_at AS "createdAt", g.posted_at AS "postedAt",
            CASE WHEN g.status = 'DRAFT' THEN jsonb_array_length(g.draft_lines)
                 ELSE (SELECT count(*)::int FROM goods_receipt_lines l WHERE l.org_id = g.org_id AND l.goods_receipt_id = g.id) END AS "lineCount"
       FROM goods_receipts g JOIN suppliers s ON s.org_id = g.org_id AND s.id = g.supplier_id
      WHERE g.org_id = $1 AND g.premises_id = ANY($2::uuid[]) AND ($3::text IS NULL OR g.status = $3) AND ($4::uuid IS NULL OR g.supplier_id = $4::uuid)
      ORDER BY (g.status = 'DRAFT') DESC, g.created_at DESC, g.id LIMIT 200`, [s.orgId, premises, status, supplierId])) };
}
