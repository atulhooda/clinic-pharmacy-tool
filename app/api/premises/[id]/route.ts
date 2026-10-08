import { json } from '@/lib/http/api';
import { strictBody, UUID_PATTERN } from '@/lib/http/body';
import { HttpError } from '@/lib/http/errors';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { listPremises, patchPremises } from '@/lib/admin/premises';

export const dynamic = 'force-dynamic';

/** M-04: edit a premises' name, address, state, GSTIN, legal name or active flag (`org.settings` + grant). */
export const PATCH = withSession<{ params: { id: string } }>({ permission: 'org.settings', idempotent: { status: 200,
  replay: async (s, _rid, ctx) => (await listPremises(s)).find((p) => p.id === ctx.params.id.toLowerCase()) ?? null } }, async (req, ctx, s) => {
  const body = await strictBody(req, {
    name: { type: 'string', min: 1, max: 80, optional: true },
    address: { type: 'string', min: 1, max: 500, optional: true },
    stateCode: { type: 'string', pattern: /^[0-9]{2}$/, optional: true },
    gstin: { type: 'string', max: 15, optional: true, nullable: true },
    legalName: { type: 'string', max: 200, optional: true, nullable: true },
    active: { type: 'bool', optional: true },
  });
  if (!UUID_PATTERN.test(ctx.params.id)) throw new HttpError(404, 'PREMISES_NOT_FOUND', 'No such premises.');
  return json(await patchPremises(s, ctx.params.id.toLowerCase(), body, grantFromRequest(req)));
});
