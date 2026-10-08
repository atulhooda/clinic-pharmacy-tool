import { withTenant } from '../db/tenant';
import { now } from '../clock';
import type { Session } from '../auth/guard';

/**
 * The Today page's numbers (counts only, in one query), within what the person may see:
 * catalogue counts need stock.view, staff counts staff.manage. Premises are the person's own.
 */
export interface TodaySummary {
  dispensaryReady: boolean;
  premises: number;
  premisesReady: number;
  items: number | null;
  rxItems: number | null;
  suppliers: number | null;
  supplierIssues: number | null;
  staff: number | null;
  signedIn: number | null;
}

export async function todaySummary(s: Session): Promise<TodaySummary> {
  const at = now();
  const today = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const r = await withTenant(s.orgId, async (db) => (await db.rows<{
    dispensaryReady: boolean; premises: number; premisesReady: number; items: number; rxItems: number;
    suppliers: number; supplierIssues: number; staff: number; signedIn: number;
  }>(`SELECT EXISTS (SELECT 1 FROM stock_settings WHERE org_id = $1) AS "dispensaryReady",
             (SELECT count(*)::int FROM premises WHERE org_id = $1 AND active AND id = ANY($2::uuid[])) AS premises,
             (SELECT count(*)::int FROM premises_settings WHERE org_id = $1 AND premises_id = ANY($2::uuid[])) AS "premisesReady",
             (SELECT count(*)::int FROM items WHERE org_id = $1 AND active) AS items,
             (SELECT count(*)::int FROM items WHERE org_id = $1 AND active AND requires_prescription) AS "rxItems",
             (SELECT count(*)::int FROM suppliers WHERE org_id = $1 AND active) AS suppliers,
             (SELECT count(*)::int FROM suppliers WHERE org_id = $1 AND active
                 AND (cardinality(drug_licence_numbers) = 0 OR licence_valid_till < $3::date)) AS "supplierIssues",
             (SELECT count(*)::int FROM staff_users WHERE org_id = $1 AND active) AS staff,
             (SELECT count(DISTINCT staff_user_id)::int FROM sessions WHERE org_id = $1 AND revoked_at IS NULL AND expires_at > $4) AS "signedIn"`,
    [s.orgId, s.premises.map((p) => p.id), today, at]))[0]);
  const stock = s.permissions.has('stock.view');
  const staff = s.permissions.has('staff.manage');
  return {
    dispensaryReady: r.dispensaryReady, premises: r.premises, premisesReady: r.premisesReady,
    items: stock ? r.items : null, rxItems: stock ? r.rxItems : null,
    suppliers: stock ? r.suppliers : null, supplierIssues: stock ? r.supplierIssues : null,
    staff: staff ? r.staff : null, signedIn: staff ? r.signedIn : null,
  };
}
