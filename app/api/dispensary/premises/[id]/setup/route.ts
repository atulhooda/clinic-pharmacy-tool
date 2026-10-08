import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { listDispensaryPremises, setupPremises, type PremisesInput } from '@/lib/stock/settings';
import { PREMISES_SETTINGS, pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-05: a premises' mode (no default), licences, register fields; creates its store and quarantine (`premises.legal_settings` grant). */
export const POST = withSession<{ params: { id: string } }>({ permission: 'stock.settings', idempotent: { status: 201,
  replay: async (s, _rid, ctx) => (await listDispensaryPremises(s)).find((p) => p.id === ctx.params.id.toLowerCase())?.settings ?? null } }, async (req, ctx, s) => {
  const body = await strictBody(req, PREMISES_SETTINGS);
  const id = pathId(ctx.params.id, 'PREMISES_NOT_FOUND', 'No such premises.');
  return json(await setupPremises(s, id, body as PremisesInput, grantFromRequest(req)), { status: 201 });
});
