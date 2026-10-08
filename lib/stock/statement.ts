import { withTenant } from '../db/tenant';
import { addDays, now } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { requirePremises } from './scope';
import type { PremisesHeader } from './statement-export';

/**
 * The stock statement (D-47; 06a §14; E-45): for a period of IST dates and a premises (or the
 * caller's premises together), per item:
 *
 *   Opening + Received − Issued + Returned + Other = Balance
 *
 * - Opening: Σ qty_delta before the start of `from` (IST);
 * - Received: RECEIPT; Issued: DISPENSE + PROCEDURE_USE, as a positive number;
 * - Returned: PATIENT_RETURN;
 * - Other (signed): OPENING_BALANCE, the write-offs, supplier returns, count corrections, transfers;
 * - a REVERSAL counts in the column of the movement it reverses, on its own date.
 *
 * Always from the ledger (never the cache), so it equals Σ qty_delta to the end of `to`. No patient field.
 */
export interface StatementRow {
  itemId: string;
  name: string;
  category: string;
  baseUnit: string;
  units: { name: string; baseUnitsPerUnit: number; isBase: boolean; active: boolean }[];
  opening: number;
  received: number;
  issued: number;
  returned: number;
  other: number;
  balance: number;
  /** Of the balance, how much sits in quarantine. */
  quarantined: number;
}
export interface Statement {
  premisesId: string | null;
  premisesNames: string[];
  from: string;
  to: string;
  generatedAt: string;
  rows: StatementRow[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const valid = (d: string) => DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
/** The instant an IST date begins. */
const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`);

export function period(q: URLSearchParams): { from: string; to: string } {
  const from = q.get('from') ?? '';
  const to = q.get('to') ?? '';
  if (!valid(from)) throw new HttpError(422, 'FIELD_INVALID', 'from is a date (YYYY-MM-DD).', { field: 'from', rule: 'date' });
  if (!valid(to)) throw new HttpError(422, 'FIELD_INVALID', 'to is a date (YYYY-MM-DD).', { field: 'to', rule: 'date' });
  if (to < from) throw new HttpError(422, 'FIELD_INVALID', 'to is on or after from.', { field: 'to', rule: 'order' });
  if (addDays(from, 365) < to) throw new HttpError(422, 'PERIOD_TOO_LONG', 'A period is at most 366 days.');
  return { from, to };
}

export async function stockStatement(s: Session, q: URLSearchParams): Promise<Statement> {
  const { from, to } = period(q);
  const one = q.get('premisesId');
  if (one) requirePremises(s, one.toLowerCase());
  const premises = one ? [one.toLowerCase()] : s.premises.map((p) => p.id);
  const all = q.get('all') === 'true';
  const rows = await withTenant(s.orgId, (db) => db.rows<Omit<StatementRow, 'units'>>(
    `WITH m AS (
       SELECT m.item_id, m.qty_delta, m.occurred_at,
              CASE WHEN m.movement_type = 'REVERSAL' THEN o.movement_type ELSE m.movement_type END AS kind,
              l.kind = 'QUARANTINE' AS q
         FROM stock_movements m
         JOIN stock_locations l ON l.org_id = m.org_id AND l.id = m.location_id
         LEFT JOIN stock_movements o ON o.org_id = m.org_id AND o.id = m.reverses_movement_id
        WHERE m.org_id = $1 AND m.premises_id = ANY($2::uuid[]) AND m.occurred_at < $4),
     t AS (
       SELECT item_id,
              coalesce(sum(qty_delta) FILTER (WHERE occurred_at < $3), 0)::int AS opening,
              coalesce(sum(qty_delta) FILTER (WHERE occurred_at >= $3 AND kind = 'RECEIPT'), 0)::int AS received,
              coalesce(-sum(qty_delta) FILTER (WHERE occurred_at >= $3 AND kind IN ('DISPENSE','PROCEDURE_USE')), 0)::int AS issued,
              coalesce(sum(qty_delta) FILTER (WHERE occurred_at >= $3 AND kind = 'PATIENT_RETURN'), 0)::int AS returned,
              coalesce(sum(qty_delta) FILTER (WHERE occurred_at >= $3 AND kind NOT IN ('RECEIPT','DISPENSE','PROCEDURE_USE','PATIENT_RETURN')), 0)::int AS other,
              sum(qty_delta)::int AS balance,
              coalesce(sum(qty_delta) FILTER (WHERE q), 0)::int AS quarantined,
              bool_or(occurred_at >= $3) AS moved
         FROM m GROUP BY item_id)
     SELECT i.id AS "itemId", i.display_name AS name, i.category, i.base_unit AS "baseUnit",
            coalesce(t.opening, 0) AS opening, coalesce(t.received, 0) AS received, coalesce(t.issued, 0) AS issued,
            coalesce(t.returned, 0) AS returned, coalesce(t.other, 0) AS other, coalesce(t.balance, 0) AS balance,
            coalesce(t.quarantined, 0) AS quarantined
       FROM items i LEFT JOIN t ON t.item_id = i.id
      WHERE i.org_id = $1 AND ($5 OR coalesce(t.moved, false) OR coalesce(t.balance, 0) <> 0)
      ORDER BY lower(i.display_name), i.id`,
    [s.orgId, premises, istStart(from), istStart(addDays(to, 1)), all]));
  const units = rows.length ? await withTenant(s.orgId, (db) => db.rows<{ itemId: string; name: string; baseUnitsPerUnit: number; isBase: boolean; active: boolean }>(
    `SELECT item_id AS "itemId", name, base_units_per_unit AS "baseUnitsPerUnit", is_base AS "isBase", active
       FROM item_units WHERE org_id = $1 AND item_id = ANY($2::uuid[])`, [s.orgId, rows.map((r) => r.itemId)])) : [];
  return {
    premisesId: one ? one.toLowerCase() : null,
    premisesNames: s.premises.filter((p) => premises.includes(p.id)).map((p) => p.name),
    from, to, generatedAt: now().toISOString(),
    rows: rows.map((r) => ({ ...r, units: units.filter((u) => u.itemId === r.itemId).map(({ itemId, ...u }) => { void itemId; return u; }) })),
  };
}

/** An export writes one audit row (06a §14: every export is audited), in its own transaction. */
export async function auditExport(s: Session, st: Statement, format: string): Promise<void> {
  await withSessionTx(s, (db) => writeAudit(db, { orgId: s.orgId, action: 'report.exported', actorLabel: s.name, actorRole: s.roleKey,
    staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: st.premisesId,
    detail: { register: 'stock_statement', format, from_date: st.from, to_date: st.to, count: st.rows.length } }));
}

/** The print view's header: each premises' name, address, state, GSTIN and licences. */
export async function premisesHeaders(s: Session, st: Statement): Promise<PremisesHeader[]> {
  const ids = st.premisesId ? [st.premisesId] : s.premises.map((p) => p.id);
  return withTenant(s.orgId, (db) => db.rows<PremisesHeader>(
    `SELECT p.name, p.address, p.state_code AS "stateCode", p.gstin,
            array_remove(ARRAY[ps.ndps_licence_no, ps.schedule_x_licence_no], NULL) AS licences
       FROM premises p LEFT JOIN premises_settings ps ON ps.org_id = p.org_id AND ps.premises_id = p.id
      WHERE p.org_id = $1 AND p.id = ANY($2::uuid[]) ORDER BY lower(p.name)`, [s.orgId, ids]));
}
