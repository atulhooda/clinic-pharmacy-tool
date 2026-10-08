import { withTenant } from '../db/tenant';
import { HttpError } from '../http/errors';
import type { Session } from '../auth/guard';

/**
 * The global medicine master (06a §6.3; E-08, E-09). The same rows for every organisation
 * (06b DG-01, DX-37); the app can only read it (DG-03); the only write route is a correction
 * request (Milestone 2, DG-02).
 */
export interface MasterRow {
  id: string;
  brandName: string;
  manufacturerName: string;
  dosageForm: string;
  strengthText: string | null;
  packText: string | null;
  suggestedBaseUnit: string | null;
  suggestedUnits: { name: string; baseUnits: number }[];
  salts: { name: string; strength: string | null }[];
  scheduleFlags: string[];
  requiresPrescription: boolean;
  storageCondition: string | null;
  verified: boolean;
  discontinued: boolean;
  version: number;
}
export const MASTER_COLS = `id, brand_name AS "brandName", manufacturer_name AS "manufacturerName", dosage_form AS "dosageForm",
  strength_text AS "strengthText", pack_text AS "packText", suggested_base_unit AS "suggestedBaseUnit", suggested_units AS "suggestedUnits",
  salts, schedule_flags AS "scheduleFlags", requires_prescription AS "requiresPrescription", storage_condition AS "storageCondition",
  verified, discontinued, version`;

/** E-08: search by brand text (trigram-indexed) and/or by salt name. */
export async function searchMaster(s: Session, q: URLSearchParams): Promise<{ items: MasterRow[] }> {
  const text = (q.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  const salt = (q.get('salt') ?? '').trim().toLowerCase().slice(0, 80);
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
  const items = await withTenant(s.orgId, (db) => db.rows<MasterRow>(
    `SELECT ${MASTER_COLS} FROM medicine_master
      WHERE NOT discontinued
        AND ($1 = '' OR lower(brand_name) LIKE '%' || $1 || '%' OR lower(brand_name) % $1)
        AND ($2 = '' OR EXISTS (SELECT 1 FROM jsonb_array_elements(salts) e WHERE lower(e->>'name') = $2))
      ORDER BY ($1 <> '' AND lower(brand_name) LIKE $1 || '%') DESC, lower(brand_name), id
      LIMIT $3`, [text.replace(/[%_\\]/g, ''), salt, limit]));
  return { items };
}

/** E-09 */
export async function getMaster(s: Session, id: string): Promise<MasterRow> {
  const r = (await withTenant(s.orgId, (db) => db.rows<MasterRow>(`SELECT ${MASTER_COLS} FROM medicine_master WHERE id = $1`, [id])))[0];
  if (!r) throw new HttpError(404, 'MASTER_NOT_FOUND', 'No such medicine.');
  return r;
}
