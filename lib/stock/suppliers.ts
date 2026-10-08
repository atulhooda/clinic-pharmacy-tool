import { withTenant } from '../db/tenant';
import { now } from '../clock';
import { HttpError } from '../http/errors';
import { withSessionTx, type Session } from '../auth/guard';
import { isoDate, checkViolation } from './scope';

/**
 * Suppliers (06a §6.5; E-20, E-21). Org-wide. The licence status is derived, as of today in
 * IST. Contact details are business contacts and are never logged or audited.
 */
export type LicenceStatus = 'MISSING' | 'EXPIRED' | 'VALIDITY_UNKNOWN' | 'VALID';
export interface Supplier {
  id: string;
  name: string;
  gstin: string | null;
  drugLicenceNumbers: string[];
  licenceValidTill: string | null;
  licenceStatus: LicenceStatus;
  address: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  active: boolean;
}
const COLS = `id, name, gstin, drug_licence_numbers AS "drugLicenceNumbers", licence_valid_till::text AS "licenceValidTill",
  CASE WHEN cardinality(drug_licence_numbers) = 0 THEN 'MISSING'
       WHEN licence_valid_till IS NULL THEN 'VALIDITY_UNKNOWN'
       WHEN licence_valid_till < $2::date THEN 'EXPIRED' ELSE 'VALID' END AS "licenceStatus",
  address, contact_name AS "contactName", contact_phone AS "contactPhone", contact_email AS "contactEmail", active`;
const todayIst = () => new Date(now().getTime() + 330 * 60_000).toISOString().slice(0, 10);
const notFound = () => new HttpError(404, 'SUPPLIER_NOT_FOUND', 'No such supplier.');

export async function listSuppliers(s: Session, q: URLSearchParams): Promise<{ items: Supplier[] }> {
  const text = (q.get('q') ?? '').trim().toLowerCase().replace(/[%_\\]/g, '').slice(0, 80);
  return { items: await withTenant(s.orgId, (db) => db.rows<Supplier>(
    `SELECT ${COLS} FROM suppliers WHERE org_id = $1 AND ($3 = '' OR lower(name) LIKE '%' || $3 || '%')
      ORDER BY active DESC, lower(name) LIMIT 200`, [s.orgId, todayIst(), text])) };
}

export async function getSupplier(s: Session, id: string): Promise<Supplier> {
  const r = (await withTenant(s.orgId, (db) => db.rows<Supplier>(`SELECT ${COLS} FROM suppliers WHERE org_id = $1 AND id = $3`, [s.orgId, todayIst(), id])))[0];
  if (!r) throw notFound();
  return r;
}

export interface SupplierInput {
  name?: string;
  gstin?: string | null;
  drugLicenceNumbers?: string[];
  licenceValidTill?: string | null;
  address?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  active?: boolean;
}
const MAP: Record<keyof SupplierInput, string> = {
  name: 'name', gstin: 'gstin', drugLicenceNumbers: 'drug_licence_numbers', licenceValidTill: 'licence_valid_till', address: 'address',
  contactName: 'contact_name', contactPhone: 'contact_phone', contactEmail: 'contact_email', active: 'active',
};

function conflict(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'suppliers_name_key') throw new HttpError(409, 'SUPPLIER_NAME_TAKEN', 'Another supplier has that name.');
  if (e.code === '23505' && e.constraint === 'suppliers_gstin_key') throw new HttpError(409, 'SUPPLIER_GSTIN_TAKEN', 'Another supplier has that GSTIN.');
  return checkViolation(err);
}
function validate(input: SupplierInput): void {
  if (input.licenceValidTill && !isoDate.test(input.licenceValidTill)) throw new HttpError(422, 'FIELD_INVALID', 'Dates are YYYY-MM-DD.', { field: 'licenceValidTill', rule: 'format' });
}

export async function createSupplier(s: Session, input: SupplierInput & { name: string }): Promise<Supplier> {
  validate(input);
  const id = await withSessionTx(s, async (db) => {
    const keys = (Object.keys(MAP) as (keyof SupplierInput)[]).filter((k) => input[k] !== undefined);
    const cols = ['org_id', 'created_at', 'updated_at', ...keys.map((k) => MAP[k])];
    const at = now();
    return (await db.rows<{ id: string }>(`INSERT INTO suppliers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      [s.orgId, at, at, ...keys.map((k) => (k === 'name' ? input.name.trim() : input[k]))]).catch(conflict))[0].id;
  });
  return getSupplier(s, id);
}

export async function patchSupplier(s: Session, id: string, input: SupplierInput): Promise<Supplier> {
  validate(input);
  await withSessionTx(s, async (db) => {
    const cur = await db.rows('SELECT 1 FROM suppliers WHERE org_id = $1 AND id = $2 FOR UPDATE', [s.orgId, id]);
    if (cur.length === 0) throw notFound();
    const keys = (Object.keys(MAP) as (keyof SupplierInput)[]).filter((k) => input[k] !== undefined);
    if (keys.length === 0) return;
    await db.rows(`UPDATE suppliers SET ${keys.map((k, i) => `${MAP[k]} = $${i + 3}`).join(', ')}, updated_at = $${keys.length + 3} WHERE org_id = $1 AND id = $2`,
      [s.orgId, id, ...keys.map((k) => (k === 'name' ? input.name!.trim() : input[k])), now()]).catch(conflict);
  });
  return getSupplier(s, id);
}
