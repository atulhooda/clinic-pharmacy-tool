import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { listDispensaryPremises, putPremisesSettings, type PremisesInput } from '@/lib/stock/settings';
import { PREMISES_SETTINGS, pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-06: change a premises' legal settings (If-Match, `premises.legal_settings` grant). */
export const PUT = withSession<{ params: { id: string } }>({ permission: 'stock.settings', idempotent: { status: 200,
  replay: async (s, _rid, ctx) => (await listDispensaryPremises(s)).find((p) => p.id === ctx.params.id.toLowerCase())?.settings ?? null } }, async (req, ctx, s) => {
  const body = await strictBody(req, PREMISES_SETTINGS);
  const id = pathId(ctx.params.id, 'PREMISES_NOT_FOUND', 'No such premises.');
  const r = await putPremisesSettings(s, id, body as PremisesInput, req.headers.get('if-match'), grantFromRequest(req));
  return json(r, { headers: { etag: `"${r.version}"` } });
});
